'use strict';
/*
 * The fixing engine: decide which files the AI may see/change, gather context from the
 * stack trace within a token budget, build the prompt, strictly validate the AI's JSON + diffs,
 * apply them, run tests, and retry with the failure output (max FIX_MAX_ATTEMPTS).
 */
const path = require('node:path').posix;
const { parseStack, urlPath } = require('./issues');
const { createRedactor } = require('./redact');
const { CostCapError } = require('./ai');

// ---------------------------------------------------------------------------
// Safety: files the AI may never see or change, and files it may only read.
// ---------------------------------------------------------------------------
const NEVER = [
  '.env', '.env.*', '*.env', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', '*.lock', 'go.sum',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.jks', 'id_rsa*', 'id_ed25519*', 'secrets.*', 'secret.*', 'credentials*', '**/secrets/**',
  '.github/**', '.gitlab-ci.yml', '.gitlab/**', '.circleci/**', '.travis.yml', 'azure-pipelines.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml', '.buildkite/**',
  'vercel.json', '.vercel/**', 'netlify.toml', '.netlify/**', 'Dockerfile', '*.dockerfile', 'docker-compose*', 'fly.toml', 'render.yaml', 'app.yaml',
  'Procfile', 'firebase.json', '.firebaserc', 'wrangler.toml', 'serverless.yml', '*.tf', '*.tfvars',
  '.git/**', 'node_modules/**',
];
const READ_ONLY = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'test/**', 'tests/**', 'spec/**', 'package.json', '.gitignore', '.gitattributes'];

function globToRegex(glob) {
  const g = glob.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // Patterns without a slash match the file name in any folder (like .gitignore).
  return new RegExp(g.includes('/') ? `^${re}$` : `(^|/)${re}$`, 'i');
}

function createSafety({ denylist = [], readonly = [] } = {}) {
  const never = [...NEVER, ...denylist].map(globToRegex);
  const ro = [...READ_ONLY, ...readonly].map(globToRegex);
  const canSend = (p) => !never.some((r) => r.test(p));
  return { canSend, canModify: (p) => canSend(p) && !ro.some((r) => r.test(p)) };
}

/** Repo-relative, forward slashes, no traversal. Returns null if unsafe. */
function cleanPath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/').replace(/^[ab]\//, '').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!s || /^[a-z]:/i.test(s) || s.split('/').includes('..')) return null;
  return path.normalize(s);
}

// ---------------------------------------------------------------------------
// Unified diffs: lenient parsing (LLMs are sloppy), strict content matching.
// ---------------------------------------------------------------------------
function parseDiff(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const hunks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^--- /.test(l) && /^\+\+\+ /.test(lines[i + 1] || '')) { i++; cur = null; continue; }
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
    if (h || /^@@\s*$/.test(l) || /^@@ .*@@/.test(l)) { cur = { oldStart: h ? Number(h[1]) : null, lines: [] }; hunks.push(cur); continue; }
    if (!cur || l.startsWith('\\')) continue;
    if (l.startsWith('+')) cur.lines.push(['+', l.slice(1)]);
    else if (l.startsWith('-')) cur.lines.push(['-', l.slice(1)]);
    else cur.lines.push([' ', l.startsWith(' ') ? l.slice(1) : l]);
  }
  for (const h of hunks) while (h.lines.length && h.lines.at(-1)[0] === ' ' && h.lines.at(-1)[1] === '') h.lines.pop();
  return hunks.filter((h) => h.lines.length);
}

/** Applies a diff to content. Throws with a clear reason if a hunk doesn't match. */
function applyDiff(content, diff) {
  const hunks = parseDiff(diff);
  if (!hunks.length || !hunks.some((h) => h.lines.some(([op]) => op !== ' '))) throw new Error('diff has no changes (needs @@ hunks with + and - lines)');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const finalNl = /\r?\n$/.test(content);
  const lines = content.split(/\r?\n/);
  if (finalNl) lines.pop();
  let added = 0;
  let removed = 0;
  let pos = 0;
  const norms = [(s) => s, (s) => s.trimEnd(), (s) => s.trim().replace(/\s+/g, ' ')];
  hunks.forEach((h, n) => {
    const old = h.lines.filter(([op]) => op !== '+').map(([, t]) => t);
    let idx = -1;
    if (!old.length) idx = Math.min(h.oldStart ?? lines.length, lines.length);
    for (const norm of norms) {
      if (idx >= 0) break;
      const want = old.map(norm);
      const hits = [];
      for (let i = pos; i + old.length <= lines.length; i++) if (want.every((w, k) => norm(lines[i + k]) === w)) hits.push(i);
      if (hits.length) {
        const hint = (h.oldStart ?? 1) - 1;
        idx = hits.reduce((a, b) => (Math.abs(b - hint) < Math.abs(a - hint) ? b : a));
      }
    }
    if (idx < 0) throw new Error(`hunk ${n + 1} does not match the file (could not find the line "${(old[0] || '').trim().slice(0, 80)}")`);
    const out = [];
    let k = idx;
    for (const [op, t] of h.lines) {
      if (op === ' ') out.push(lines[k++]); // keep the file's own whitespace
      else if (op === '-') { k++; removed++; } else { out.push(t); added++; }
    }
    lines.splice(idx, old.length, ...out);
    pos = idx + out.length;
  });
  return { content: lines.join(eol) + (finalNl ? eol : ''), added, removed };
}

// ---------------------------------------------------------------------------
// Context: stack-trace files + their tests + direct imports, within a token budget.
// ---------------------------------------------------------------------------
const EXTS = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte'];
const tokens = (s) => Math.ceil(s.length / 4);

/** Maps a URL path like /assets/js/cart.js to a repo file. */
function resolveRepoPath(p, files, prefixes = []) {
  const clean = cleanPath(urlPath(p));
  if (!clean) return null;
  for (const pre of ['', ...prefixes]) if (files.has(pre + clean)) return pre + clean;
  const segs = clean.split('/');
  for (let i = 1; i < segs.length; i++) {
    const tail = segs.slice(i).join('/');
    const hits = [...files].filter((f) => f === tail || f.endsWith('/' + tail));
    if (hits.length === 1) return hits[0];
  }
  return null;
}

function findImports(file, content, files, prefixes) {
  const specs = new Set();
  const res = [/\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g, /\bexport\s+[^'";]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, /<script[^>]+src=['"]([^'"]+)['"]/gi];
  for (const re of res) for (const m of content.matchAll(re)) specs.add(m[1]);
  const out = [];
  for (const spec of specs) {
    if (spec.startsWith('/')) { const r = resolveRepoPath(spec, files, prefixes); if (r) out.push(r); continue; }
    if (!spec.startsWith('.')) continue; // packages are not ours to fix
    const base = path.normalize(path.join(path.dirname(file), spec));
    const hit = [...EXTS.map((e) => base + e), ...EXTS.slice(1).map((e) => `${base}/index${e}`)].find((c) => files.has(c));
    if (hit) out.push(hit);
  }
  return out;
}

function findTests(file, files) {
  const dir = path.dirname(file);
  const name = path.basename(file).replace(/\.[^.]+$/, '');
  const ext = path.extname(file);
  const exts = [...new Set([ext, '.js', '.ts', '.mjs'])];
  const cands = exts.flatMap((e) => [`${name}.test${e}`, `${name}.spec${e}`].flatMap((b) => [path.join(dir, b), path.join(dir, '__tests__', b), `test/${b}`, `tests/${b}`]));
  return cands.map((c) => path.normalize(c)).filter((c) => files.has(c));
}

/**
 * @param {{issue, workspace: {listFiles(): string[], read(p): string|null}, safety, config, redactor}} o
 * @returns {{files: object[], omitted: object[], full: Map<string,string>}} `full` = redacted full content for validation
 */
function gatherContext({ issue, workspace, safety, config, redactor }) {
  const files = new Set(workspace.listFiles());
  const prefixes = config.fix.pathPrefixes;
  const frames = parseStack(issue.stack);
  if (issue.file) frames.unshift({ path: issue.file, line: issue.line });
  const errorLines = new Map();
  const ordered = [];
  const add = (p, role) => { if (p && !ordered.some((o) => o.path === p)) ordered.push({ path: p, role }); };
  for (const f of frames) {
    const p = resolveRepoPath(f.path, files, prefixes);
    if (!p) continue;
    if (!errorLines.has(p)) errorLines.set(p, []);
    if (f.line) errorLines.get(p).push(f.line);
    if (ordered.filter((o) => o.role === 'stack').length < 5) add(p, 'stack');
  }
  const stack = ordered.map((o) => o.path);
  for (const p of stack) for (const t of findTests(p, files)) add(t, 'test');
  for (const p of stack) {
    const c = workspace.read(p);
    if (c) for (const imp of findImports(p, c, files, prefixes)) add(imp, 'import');
  }

  let budget = config.fix.contextTokenBudget;
  const out = [];
  const omitted = [];
  const full = new Map();
  for (const { path: p, role } of ordered) {
    if (!safety.canSend(p)) { omitted.push({ path: p, reason: 'denylisted (never sent to AI)' }); continue; }
    const raw = workspace.read(p);
    if (raw == null || raw.includes('\0')) { omitted.push({ path: p, reason: 'unreadable or binary' }); continue; }
    const content = redactor.redact(raw);
    full.set(p, content);
    const lines = content.split('\n');
    const entry = { path: p, role, readOnly: !safety.canModify(p), errorLines: errorLines.get(p) || [], content, from: 1, to: lines.length, total: lines.length };
    if (tokens(content) <= budget) {
      budget -= tokens(content);
    } else if (role === 'stack' && budget > 500) {
      // Too big: send a window around the error lines.
      const at = (entry.errorLines[0] || 1) - 1;
      const span = Math.max(20, Math.floor((budget * 4) / 80 / 2));
      entry.from = Math.max(1, at - span + 1);
      entry.to = Math.min(lines.length, at + span);
      entry.content = lines.slice(entry.from - 1, entry.to).join('\n');
      entry.truncated = true;
      budget -= tokens(entry.content);
    } else {
      omitted.push({ path: p, reason: 'over the context token budget' });
      continue;
    }
    out.push(entry);
  }
  return { files: out, omitted, full };
}

// ---------------------------------------------------------------------------
// Prompt and strict response validation.
// ---------------------------------------------------------------------------
function buildSystem(config) {
  return [
    'You are selfheal, an automated bug fixer for a live website. You get a production error and source files from its repository.',
    'Find the root cause and propose the SMALLEST safe code change that fixes it.',
    'Rules:',
    '- Only change files marked "may change". Never change tests: they define correct behaviour.',
    `- At most ${config.fix.maxFiles} files and ${config.fix.maxLines} changed lines in total. No new dependencies, no new files.`,
    '- Values like [REDACTED_SECRET_1] are placeholders for hidden data. Keep them exactly as written.',
    '- Each diff is a unified diff for ONE file: "--- a/path", "+++ b/path", then @@ hunks whose context and - lines are copied exactly from the file.',
    '- If the bug cannot be fixed in these files (backend, third-party, missing info), set fixable to false and explain why.',
    'Reply with ONLY this JSON object, no markdown, no prose:',
    '{"fixable": true, "root_cause": "one or two sentences", "explanation": "what you changed and why", "changes": [{"path": "src/file.js", "diff": "--- a/src/file.js\\n+++ b/src/file.js\\n@@ -10,3 +10,3 @@\\n ..."}]}',
  ].join('\n');
}

function buildPrompt({ issue, ctx, redactor, history = [] }) {
  const r = (v) => redactor.redact(v ?? '');
  const parts = [
    '## Error',
    `Type: ${issue.kind}`,
    `Message: ${r(issue.title)}`,
    `Location: ${r(issue.file) || 'unknown'}${issue.line ? `:${issue.line}` : ''}`,
    `Seen: ${issue.count} times (first ${issue.first_seen}, last ${issue.last_seen})`,
    issue.page_url ? `Page: ${r(issue.page_url)}` : '',
    issue.user_agent ? `Browser: ${r(issue.user_agent)}` : '',
    issue.release ? `Release: ${r(issue.release)}` : '',
    issue.stack ? `Stack trace:\n${r(issue.stack)}` : '',
    '',
    '## Files',
  ];
  for (const f of ctx.files) {
    const label = `${f.readOnly ? 'read-only' : 'may change'}, ${f.role}${f.errorLines.length ? `, error at line ${f.errorLines.join(', ')}` : ''}${f.truncated ? `, showing lines ${f.from}-${f.to} of ${f.total}` : ''}`;
    parts.push(`===== FILE: ${f.path} (${label}) =====\n${f.content}\n===== END FILE =====`);
  }
  if (ctx.omitted.length) parts.push(`(Not shown: ${ctx.omitted.map((o) => `${o.path}: ${o.reason}`).join('; ')})`);
  if (history.length) {
    parts.push('', '## Previous attempts (these did NOT work, do something different)');
    history.forEach((h, i) => parts.push(`### Attempt ${i + 1}\nChanges:\n${h.changes.map((c) => c.diff).join('\n')}\nResult: ${h.result}\n${r(h.output).slice(-3000)}`));
  }
  return parts.filter((p) => p !== '').join('\n');
}

function extractJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { /* try the outermost braces */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  return undefined;
}

/** Returns validate(text) for the router. Checks schema, paths, safety rules, limits, and that every diff applies. */
function makeValidator({ ctx, safety, config }) {
  const shown = new Set(ctx.files.map((f) => f.path));
  return (text) => {
    const errors = [];
    const j = extractJson(text);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, errors: ['response is not a JSON object'] };
    const fixable = j.fixable !== false;
    if (typeof j.root_cause !== 'string' || j.root_cause.trim().length < 5) errors.push('root_cause must be a non-empty string');
    if (typeof j.explanation !== 'string' || !j.explanation.trim()) errors.push('explanation must be a non-empty string');
    if (!Array.isArray(j.changes)) errors.push('changes must be an array');
    if (errors.length) return { ok: false, errors };
    if (!fixable) return { ok: true, value: { fixable: false, rootCause: j.root_cause.trim(), explanation: j.explanation.trim(), changes: [] } };
    if (!j.changes.length) return { ok: false, errors: ['fixable is true but changes is empty'] };

    const changes = [];
    for (const c of j.changes) {
      const p = cleanPath(c?.path);
      if (!p) { errors.push(`invalid path "${c?.path}"`); continue; }
      if (typeof c.diff !== 'string') { errors.push(`${p}: diff must be a string`); continue; }
      if (!safety.canModify(p)) { errors.push(`${p}: this file may not be changed (tests, config, secrets, lock and CI files are off-limits)`); continue; }
      if (!shown.has(p)) { errors.push(`${p}: you may only change files that were shown to you`); continue; }
      if (changes.some((x) => x.path === p)) { errors.push(`${p}: put all changes to one file in a single diff`); continue; }
      try {
        const r = applyDiff(ctx.full.get(p), c.diff);
        changes.push({ path: p, diff: c.diff, content: r.content, added: r.added, removed: r.removed });
      } catch (err) {
        errors.push(`${p}: ${err.message}`);
      }
    }
    if (changes.length > config.fix.maxFiles) errors.push(`changes ${changes.length} files, the safety limit is ${config.fix.maxFiles}`);
    const total = changes.reduce((n, c) => n + c.added + c.removed, 0);
    if (total > config.fix.maxLines) errors.push(`changes ${total} lines, the safety limit is ${config.fix.maxLines}: make a smaller fix`);
    if (errors.length) return { ok: false, errors };
    return { ok: true, value: { fixable: true, rootCause: j.root_cause.trim(), explanation: j.explanation.trim(), changes } };
  };
}

// ---------------------------------------------------------------------------
// The loop: ask AI -> apply -> test -> retry with the output.
// ---------------------------------------------------------------------------
/**
 * @param {{issue, workspace, router, config, secrets?: string[], onAttempt?: (a) => void}} o
 *   workspace: { listFiles, read, write, reset, hasTests(): boolean, runTests(): Promise<{passed, output, summary}> }
 * @returns {Promise<{outcome: 'fixed'|'unfixable'|'tests_failed', ...}>}
 *   Throws CostCapError / AllProvidersFailedError from the router.
 */
async function runFix({ issue, workspace, router, config, secrets = [], onAttempt = () => {} }) {
  const redactor = createRedactor(secrets);
  const safety = createSafety(config.fix);
  const ctx = gatherContext({ issue, workspace, safety, config, redactor });
  if (!ctx.files.some((f) => !f.readOnly)) {
    return { outcome: 'unfixable', rootCause: 'Could not map the error to any source file in the repository that may be changed.', explanation: `Stack trace files: ${issue.file || 'none'}. Set REPO_PATH_PREFIXES if your files live in a subfolder.`, context: ctx };
  }
  const tested = workspace.hasTests();
  const validate = makeValidator({ ctx, safety, config });
  const system = buildSystem(config);
  const history = [];
  for (let attempt = 1; attempt <= config.fix.maxAttempts; attempt++) {
    const ai = await router.generate({ system, prompt: buildPrompt({ issue, ctx, redactor, history }), validate });
    const fix = ai.value;
    if (!fix.fixable) {
      onAttempt({ attempt, provider: ai.provider, rootCause: fix.rootCause, explanation: fix.explanation, changes: [], error: 'AI says not fixable' });
      return { outcome: 'unfixable', rootCause: fix.rootCause, explanation: fix.explanation, provider: ai.provider, attempt };
    }
    await workspace.reset();
    for (const c of fix.changes) workspace.write(c.path, redactor.restore(c.content));
    const test = tested ? await workspace.runTests() : { passed: true, output: '', summary: 'untested' };
    const files = fix.changes.map(({ path: p, added, removed }) => ({ path: p, added, removed }));
    onAttempt({ attempt, provider: ai.provider, rootCause: fix.rootCause, explanation: fix.explanation, changes: fix.changes.map(({ path: p, diff }) => ({ path: p, diff: redactor.restore(diff) })), testPassed: tested ? test.passed : null, testOutput: test.output });
    if (test.passed) {
      return { outcome: 'fixed', tested, attempt, provider: ai.provider, rootCause: fix.rootCause, explanation: fix.explanation, files, testSummary: test.summary, testOutput: test.output };
    }
    history.push({ changes: fix.changes, result: test.timedOut ? 'tests timed out' : 'tests FAILED', output: test.output });
  }
  await workspace.reset();
  return { outcome: 'tests_failed', attempt: config.fix.maxAttempts, testOutput: history.at(-1)?.output || '' };
}

module.exports = { createSafety, globToRegex, cleanPath, parseDiff, applyDiff, resolveRepoPath, findImports, gatherContext, buildPrompt, buildSystem, makeValidator, extractJson, runFix, CostCapError };
