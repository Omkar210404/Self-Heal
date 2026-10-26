#!/usr/bin/env node
'use strict';
/*
 * Secret scanner. Scans staged files AND the full git history for phone
 * numbers, tokens and keys. Also checks that no value from your local .env
 * appears anywhere in the repo. Exits 1 if anything is found.
 *
 *   node scripts/scan-secrets.js            staged files + full history
 *   node scripts/scan-secrets.js --staged   staged files only
 *   node scripts/scan-secrets.js --worktree all tracked + untracked (not ignored) files
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Each rule: name + regex (global). Keep these in sync with server/redact.js in spirit.
const RULES = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'OpenAI-style key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'Meta/WhatsApp token', re: /\bEAA[A-Za-z0-9]{40,}/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    name: 'secret assignment',
    re: /\b(?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret|access[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{16,})["']/gi,
    group: 1,
  },
  { name: 'phone number', re: /(?<![\w.:/#@-])\+?\d{10,15}(?![\w.])/g, phone: true },
  { name: 'phone number', re: /(?<![\w.])\+\d{1,3}[ -]\d{3,5}[ -]?\d{3,5}(?:[ -]?\d{1,5})?(?![\w.])/g, phone: true },
];

// Obvious placeholders and test values are allowed.
const PLACEHOLDER = /(x{4,}|example|placeholder|your[-_]|replace[-_]|changeme|dummy|fake|mock|test|sample|redacted|choose-a|\$\{|<[a-z_]+>)/i;

function isAllowed(rule, value) {
  if (rule.phone) {
    const digits = value.replace(/\D/g, '');
    if (/0{6,}/.test(digits)) return true; // zero-padded test numbers
    if (/^(\d)\1+$/.test(digits)) return true; // 1111111111
    if (/^1[6-9]\d{11}$/.test(digits)) return true; // millisecond timestamps
    if (/^(0123456789|1234567890)/.test(digits)) return true;
    return false;
  }
  return PLACEHOLDER.test(value);
}

function scanText(text, where) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 5000) continue; // minified or binary-ish blobs
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line))) {
        const value = rule.group ? m[rule.group] : m[0];
        if (!isAllowed(rule, value) && !isAllowed(rule, line)) {
          findings.push({ where, line: i + 1, rule: rule.name, sample: mask(value) });
        }
      }
    }
  }
  return findings;
}

function mask(v) {
  if (v.length <= 6) return '*'.repeat(v.length);
  return v.slice(0, 3) + '*'.repeat(Math.min(12, v.length - 5)) + v.slice(-2);
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512, ...opts });
}

function envValues(root) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].replace(/^["']|["']$/g, '');
    if (v.length < 6 || PLACEHOLDER.test(v)) continue;
    if (/^(true|false|\d+(\.\d+)?)$/i.test(v)) continue;
    if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(v)) continue;
    // Plain config like "gemini,claude,ollama" or model names are not secrets.
    if (/^(AI_PROVIDERS|CLAUDE_MODEL|GEMINI_MODEL|OLLAMA_MODEL|OLLAMA_URL|MERGE_METHOD|TEST_COMMAND|INSTALL_COMMAND|LOG_LEVEL|HOST|DATA_DIR|WHATSAPP_API_VERSION|WHATSAPP_TEMPLATE_LANG|WHATSAPP_TEMPLATE_NAME|GITHUB_API_URL|GIT_AUTHOR_NAME|GIT_AUTHOR_EMAIL|REPO_PATH_PREFIXES|DENYLIST|READONLY_PATHS|GITHUB_BASE_BRANCH|ALLOWED_ORIGINS|PUBLIC_URL|GITHUB_REPO)$/.test(m[1])) continue;
    out.push({ key: m[1], value: v });
  }
  return out;
}

function scanEnvValues(text, where, values) {
  const findings = [];
  for (const { key, value } of values) {
    if (text.includes(value)) findings.push({ where, line: 0, rule: `value of ${key} from your .env`, sample: mask(value) });
    const digits = value.replace(/\D/g, '');
    if (key === 'OWNER_WHATSAPP_NUMBER' && digits.length >= 8 && text.replace(/[\s-]/g, '').includes(digits)) {
      findings.push({ where, line: 0, rule: 'your OWNER_WHATSAPP_NUMBER', sample: mask(digits) });
    }
  }
  return findings;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const values = envValues(root);
  const self = 'scripts/scan-secrets.js';
  let findings = [];

  if (args.has('--worktree')) {
    const files = git(['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root }).split('\n').filter(Boolean);
    for (const f of files) {
      if (f === self) continue;
      const full = path.join(root, f);
      if (!fs.existsSync(full)) continue;
      const text = fs.readFileSync(full, 'utf8');
      findings.push(...scanText(text, f), ...scanEnvValues(text, f, values));
    }
  } else {
    const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: root }).split('\n').filter(Boolean);
    for (const f of staged) {
      if (f === self) continue;
      if (/^\.env($|\.)/.test(path.basename(f)) && path.basename(f) !== '.env.example') {
        findings.push({ where: f, line: 0, rule: '.env file is staged', sample: '' });
        continue;
      }
      let text;
      try { text = git(['show', `:${f}`], { cwd: root }); } catch { continue; }
      findings.push(...scanText(text, `staged:${f}`), ...scanEnvValues(text, `staged:${f}`, values));
    }
    if (!args.has('--staged')) {
      let hasHistory = true;
      try { git(['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: 'pipe' }); } catch { hasHistory = false; }
      if (hasHistory) {
        // Full history patches + commit messages (no author lines), excluding this scanner's own rules.
        const log = git(['log', '-p', '--all', '--no-color', '--format=commit %H%n%B', '--', '.', `:(exclude)${self}`], { cwd: root });
        const commitFindings = scanText(log, 'history');
        findings.push(...commitFindings, ...scanEnvValues(log, 'history', values));
        const tracked = git(['log', '--all', '--name-only', '--format='], { cwd: root }).split('\n').filter(Boolean);
        for (const f of new Set(tracked)) {
          const b = path.basename(f);
          if (/^\.env($|\.)/.test(b) && b !== '.env.example') findings.push({ where: `history:${f}`, line: 0, rule: '.env file was committed', sample: '' });
        }
      }
    }
  }

  const label = args.has('--worktree') ? 'working tree' : args.has('--staged') ? 'staged files' : 'staged files + full git history';
  if (findings.length) {
    console.error(`secret scan FAILED (${label}): ${findings.length} finding(s)`);
    for (const f of findings.slice(0, 50)) console.error(`  ${f.where}${f.line ? ':' + f.line : ''}  ${f.rule}  ${f.sample}`);
    console.error('Stop and remove these before committing.');
    process.exit(1);
  }
  console.log(`secret scan passed (${label}; ${values.length} .env value(s) checked)`);
}

if (require.main === module) main();
module.exports = { scanText, isAllowed, RULES };
