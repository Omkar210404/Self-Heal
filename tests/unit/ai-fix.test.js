'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRedactor } = require('../../server/redact');
const fix = require('../../server/fix');
const ai = require('../../server/ai');
const { loadConfig } = require('../../server/config');
const { memDb, memLogger, fakeClock, jsonResponse, stubFetch, FAKE_OWNER } = require('../helpers');

const CART = `function calculateTotal(items, coupon) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  if (coupon.percentOff) {
    total = total * (1 - coupon.percentOff / 100);
  }
  return Math.round(total * 100) / 100;
}
module.exports = { calculateTotal };
`;

/** In-memory workspace: tests "pass" when the coupon guard is present. */
function memWorkspace(files, { hasTests = true } = {}) {
  const original = { ...files };
  let cur = { ...files };
  return {
    files: () => cur,
    listFiles: () => Object.keys(cur),
    read: (p) => cur[p] ?? null,
    write: (p, c) => { cur[p] = c; },
    reset: async () => { cur = { ...original }; },
    hasTests: () => hasTests,
    runTests: async () => {
      const ok = /coupon && coupon\.percentOff/.test(cur['cart.js']);
      return { passed: ok, output: ok ? 'pass 2' : "TypeError: Cannot read properties of undefined (reading 'percentOff')", summary: ok ? '2 passed' : '1 failed' };
    },
  };
}

const ISSUE = {
  id: 1, kind: 'error', title: "TypeError: Cannot read properties of undefined (reading 'percentOff')", file: '/demo/cart.js', line: 6, count: 3,
  first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-01-01T01:00:00Z', page_url: 'https://shop.example/checkout', user_agent: 'UA',
  stack: "TypeError: x\n    at calculateTotal (https://shop.example/demo/cart.js:6:14)\n    at checkout (https://shop.example/demo/app.js:3:5)",
};
const FILES = { 'cart.js': CART, 'cart.test.js': "require('./cart')", 'app.js': "const { calculateTotal } = require('./cart.js');\n", '.env': 'SECRET=1', 'package.json': '{}' };

function router(providers, env = {}) {
  const config = loadConfig({ AI_DAILY_MAX_CALLS: '100', ...env });
  const usage = new ai.UsageTracker({ db: memDb(), config, clock: fakeClock() });
  return { config, usage, r: new ai.AIRouter({ providers, usage, logger: memLogger(), malformedRetries: 1 }) };
}

test('redaction hides secrets, emails and phones, and restores them exactly', () => {
  const ghToken = 'gh' + 'p_' + 'a'.repeat(36);
  const src = `const apiKey = "abcdef123456";\nfetch(url, { headers: { Authorization: 'Bearer ${'x'.repeat(30)}' } });\n// mail ops@shop.example or +${FAKE_OWNER}\nDB=postgres://u:hunter22@db/x ${ghToken}\nconst at = 1700000000000;`;
  const r = createRedactor(['configured-secret-1']);
  const red = r.redact(src + ' configured-secret-1');
  for (const leak of ['abcdef123456', 'ops@shop.example', FAKE_OWNER, 'hunter22', ghToken, 'x'.repeat(30), 'configured-secret-1']) assert.ok(!red.includes(leak), leak);
  assert.ok(red.includes('1700000000000'), 'timestamps kept');
  assert.equal(r.restore(red), src + ' configured-secret-1');
  assert.equal(createRedactor().redact('a@b.co a@b.co').match(/REDACTED_EMAIL_1/g).length, 2, 'same value, same placeholder');
});

test('safety: never-send and read-only rules, plus configurable denylist', () => {
  const s = fix.createSafety({ denylist: ['private/**'] });
  for (const p of ['.env', 'config/.env.production', 'package-lock.json', 'yarn.lock', '.github/workflows/deploy.yml', 'vercel.json', 'netlify.toml', 'certs/site.pem', 'private/a.js']) {
    assert.equal(s.canSend(p), false, p);
  }
  for (const p of ['cart.test.js', 'src/__tests__/a.js', 'tests/x.js', 'package.json']) assert.deepEqual([s.canSend(p), s.canModify(p)], [true, false], p);
  assert.equal(s.canModify('src/cart.js'), true);
  assert.equal(fix.cleanPath('../etc/passwd'), null);
  assert.equal(fix.cleanPath('a/src/x.js'), 'src/x.js');
});

test('applyDiff: exact, whitespace-tolerant, multi-hunk, CRLF; refuses mismatches', () => {
  const d = ai.lineDiff('cart.js', CART.split('\n'), 5, '  if (coupon && coupon.percentOff) {');
  const r = fix.applyDiff(CART, d);
  assert.match(r.content, /coupon && coupon\.percentOff/);
  assert.deepEqual([r.added, r.removed], [1, 1]);
  const sloppy = '@@\n-if (coupon.percentOff) {\n+  if (coupon?.percentOff) {\n'; // no header, wrong indent
  assert.match(fix.applyDiff(CART, sloppy).content, /coupon\?\.percentOff/);
  const crlf = fix.applyDiff(CART.replace(/\n/g, '\r\n'), d).content;
  assert.ok(crlf.includes('\r\n') && !/[^\r]\n/.test(crlf));
  const two = '@@ -1,1 +1,1 @@\n-function calculateTotal(items, coupon) {\n+function calculateTotal(items, coupon = null) {\n@@ -9,1 +9,1 @@\n-  return Math.round(total * 100) / 100;\n+  return Math.round(total * 100) / 100; // cents\n';
  assert.match(fix.applyDiff(CART, two).content, /coupon = null[\s\S]*\/\/ cents/);
  assert.throws(() => fix.applyDiff(CART, '@@\n-not in file\n+x\n'), /does not match/);
  assert.throws(() => fix.applyDiff(CART, 'just words'), /no changes/);
});

test('context: maps stack URLs to repo files, adds tests and imports, skips denylisted', () => {
  const ws = memWorkspace(FILES);
  const config = loadConfig({});
  const ctx = fix.gatherContext({ issue: ISSUE, workspace: ws, safety: fix.createSafety(), config, redactor: createRedactor() });
  assert.deepEqual(ctx.files.map((f) => [f.path, f.role, f.readOnly]), [['cart.js', 'stack', false], ['app.js', 'stack', false], ['cart.test.js', 'test', true]]);
  assert.deepEqual(ctx.files[0].errorLines, [6, 6]);
  assert.equal(fix.resolveRepoPath('/assets/x.js', new Set(['public/assets/x.js']), ['public/']), 'public/assets/x.js');
  assert.deepEqual(fix.findImports('src/a.js', "import b from './b';\nconst c = require('../c.js');\nimport 'lodash';", new Set(['src/b.ts', 'c.js'])), ['src/b.ts', 'c.js']);
});

test('context: a stack file over the budget is sent as a window around the error line', () => {
  const big = Array.from({ length: 2000 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const ws = memWorkspace({ 'cart.js': big });
  const config = loadConfig({ CONTEXT_TOKEN_BUDGET: '1000' });
  const ctx = fix.gatherContext({ issue: { ...ISSUE, line: 1000, stack: '' , file: '/cart.js' }, workspace: ws, safety: fix.createSafety(), config, redactor: createRedactor() });
  const f = ctx.files[0];
  assert.equal(f.truncated, true);
  assert.ok(f.from < 1000 && f.to > 1000 && f.content.length < big.length);
});

test('validator: strict schema, safety rules and size limits', () => {
  const ws = memWorkspace(FILES);
  const config = loadConfig({ FIX_MAX_LINES: '4' });
  const safety = fix.createSafety();
  const ctx = fix.gatherContext({ issue: ISSUE, workspace: ws, safety, config, redactor: createRedactor() });
  const v = fix.makeValidator({ ctx, safety, config });
  const good = { root_cause: 'missing coupon guard', explanation: 'guard it', changes: [{ path: 'cart.js', diff: ai.lineDiff('cart.js', CART.split('\n'), 5, '  if (coupon && coupon.percentOff) {') }] };
  assert.equal(v('```json\n' + JSON.stringify(good) + '\n```').ok, true, 'fenced JSON accepted');
  assert.match(v('not json').errors[0], /not a JSON object/);
  assert.match(v(JSON.stringify({ ...good, root_cause: '' })).errors[0], /root_cause/);
  assert.match(v(JSON.stringify({ ...good, changes: [{ path: 'cart.test.js', diff: 'x' }] })).errors[0], /may not be changed/);
  assert.match(v(JSON.stringify({ ...good, changes: [{ path: '.env', diff: 'x' }] })).errors[0], /may not be changed/);
  assert.match(v(JSON.stringify({ ...good, changes: [{ path: 'other.js', diff: 'x' }] })).errors[0], /only change files that were shown/);
  const huge = { ...good, changes: [{ path: 'cart.js', diff: '@@\n-  let total = 0;\n+  let total = 0;\n+  // a\n+  // b\n+  // c\n+  // d\n' }] };
  assert.match(v(JSON.stringify(huge)).errors.join(), /safety limit is 4/);
  assert.equal(v(JSON.stringify({ fixable: false, root_cause: 'backend returns 500', explanation: 'not in this repo', changes: [] })).value.fixable, false);
});

test('Claude, Gemini and Ollama providers send the right requests and parse replies', async () => {
  const c = stubFetch(jsonResponse(200, { model: 'm', content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 10, output_tokens: 5 } }));
  const cr = await new ai.ClaudeProvider({ apiKey: 'test-k', model: 'claude-x', fetch: c }).complete({ system: 'S', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual([cr.text, cr.inputTokens, cr.outputTokens], ['{"a":1}', 10, 5]);
  assert.equal(c.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.calls[0].init.headers['x-api-key'], 'test-k');
  assert.equal(c.calls[0].body.system, 'S');

  const g = stubFetch(jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"b":2}' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }));
  const gr = await new ai.GeminiProvider({ apiKey: 'test-g', model: 'gemini-x', fetch: g }).complete({ system: 'S', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] });
  assert.equal(gr.text, '{"b":2}');
  assert.match(g.calls[0].url, /\/v1beta\/models\/gemini-x:generateContent$/);
  assert.deepEqual(g.calls[0].body.contents.map((x) => x.role), ['user', 'model']);
  assert.equal(g.calls[0].body.generationConfig.responseMimeType, 'application/json');

  const o = stubFetch(jsonResponse(200, { message: { content: '{"c":3}' }, prompt_eval_count: 4, eval_count: 2 }));
  const or = await new ai.OllamaProvider({ model: 'qwen', fetch: o }).complete({ system: 'S', messages: [{ role: 'user', content: 'a' }] });
  assert.equal(or.text, '{"c":3}');
  assert.equal(o.calls[0].body.messages[0].role, 'system');
  assert.equal(new ai.OllamaProvider({ model: '' }).isConfigured(), false);
});

test('provider errors are classified: auth, rate limit, timeout, unreachable', async () => {
  const p = (res) => new ai.ClaudeProvider({ apiKey: 'k', model: 'm', fetch: stubFetch(res), timeoutMs: 50 });
  const kind = async (res) => { try { await p(res).complete({ system: '', messages: [] }); } catch (e) { return e.kind; } };
  assert.equal(await kind(jsonResponse(401, { error: { message: 'invalid x-api-key' } })), 'auth');
  assert.equal(await kind(jsonResponse(429, {})), 'rate_limit');
  assert.equal(await kind(jsonResponse(529, {})), 'unavailable');
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  assert.equal(await kind(timeout), 'timeout');
  assert.equal(await kind(new TypeError('fetch failed')), 'unavailable');
});

test('router: falls back to the next provider, retries malformed answers, reports all failures', async () => {
  const down = new ai.MockAIProvider({ name: 'mock-a', mode: 'down' });
  const flaky = new ai.MockAIProvider({ name: 'mock-b', mode: 'malformed-once' });
  const { r } = router([down, flaky]);
  const okValidate = (t) => (t.startsWith('{') ? { ok: true, value: JSON.parse(t) } : { ok: false, errors: ['not json'] });
  const prompt = `===== FILE: cart.js (may change, stack) =====\n${CART}\n===== END FILE =====`;
  const res = await r.generate({ system: '', prompt, validate: okValidate });
  assert.equal(res.provider, 'mock-b');
  assert.equal(flaky.calls, 2, 'retried once after the malformed answer');
  assert.deepEqual(res.failures.map((f) => f.kind), ['unavailable', 'malformed']);

  const { r: r2 } = router([new ai.MockAIProvider({ name: 'mock-a', mode: 'down' }), new ai.MockAIProvider({ name: 'mock-b', mode: 'malformed' })]);
  await assert.rejects(r2.generate({ system: '', prompt, validate: okValidate }), (e) => e instanceof ai.AllProvidersFailedError && /mock-a.*down/.test(e.message));
  const { r: none } = router([new ai.ClaudeProvider({ apiKey: '' })]);
  await assert.rejects(none.generate({ system: '', prompt, validate: okValidate }), /No AI provider is configured/);
});

test('router: daily cost/call cap stops all AI calls', async () => {
  const p = new ai.MockAIProvider({ name: 'mock-a', mode: 'right' });
  const { r, usage } = router([p], { AI_DAILY_MAX_CALLS: '1' });
  const validate = () => ({ ok: true, value: {} });
  await r.generate({ system: '', prompt: 'x', validate });
  await assert.rejects(r.generate({ system: '', prompt: 'x', validate }), (e) => e instanceof ai.CostCapError && e.resumeAt > 0);
  assert.equal(p.calls, 1);
  assert.equal(usage.today().calls, 1);
  usage.record({ provider: 'claude', inputTokens: 1e6, outputTokens: 0, ok: true });
  assert.equal(usage.today().costUsd, 3, 'cost uses configured prices');
});

test('createProviders follows AI_PROVIDERS order and skips unknown names', () => {
  const ps = ai.createProviders(loadConfig({ AI_PROVIDERS: 'ollama,claude,bogus,gemini', ANTHROPIC_API_KEY: 'test-k' }));
  assert.deepEqual(ps.map((p) => p.name), ['ollama', 'claude', 'gemini']);
  assert.deepEqual(ps.filter((p) => p.isConfigured()).map((p) => p.name), ['claude']);
});

test('runFix: wrong fix fails tests, retry with the output passes', async () => {
  const ws = memWorkspace(FILES);
  const provider = new ai.MockAIProvider({ name: 'mock-a' });
  const { r, config } = router([provider]);
  const attempts = [];
  const res = await fix.runFix({ issue: ISSUE, workspace: ws, router: r, config, onAttempt: (a) => attempts.push(a) });
  assert.equal(res.outcome, 'fixed');
  assert.equal(res.attempt, 2);
  assert.equal(res.tested, true);
  assert.deepEqual(res.files, [{ path: 'cart.js', added: 1, removed: 1 }]);
  assert.deepEqual(attempts.map((a) => a.testPassed), [false, true]);
  assert.match(ws.files()['cart.js'], /coupon && coupon\.percentOff/);
});

test('runFix: tests fail on all 3 attempts -> tests_failed; untested repo; unfixable', async () => {
  const { r, config } = router([new ai.MockAIProvider({ name: 'm', mode: 'always-wrong' })]);
  const failed = await fix.runFix({ issue: ISSUE, workspace: memWorkspace(FILES), router: r, config });
  assert.equal(failed.outcome, 'tests_failed');
  assert.equal(failed.attempt, 3);
  assert.match(failed.testOutput, /TypeError/);

  const { r: r2, config: c2 } = router([new ai.MockAIProvider({ name: 'm', mode: 'always-wrong' })]);
  const untested = await fix.runFix({ issue: ISSUE, workspace: memWorkspace(FILES, { hasTests: false }), router: r2, config: c2 });
  assert.deepEqual([untested.outcome, untested.tested, untested.attempt], ['fixed', false, 1]);

  const { r: r3, config: c3 } = router([new ai.MockAIProvider({ name: 'm', mode: 'unfixable' })]);
  assert.equal((await fix.runFix({ issue: ISSUE, workspace: memWorkspace(FILES), router: r3, config: c3 })).outcome, 'unfixable');
  const nowhere = await fix.runFix({ issue: { ...ISSUE, file: '/vendor/x.js', stack: '' }, workspace: memWorkspace(FILES), router: r3, config: c3 });
  assert.match(nowhere.rootCause, /Could not map the error/);
});

test('runFix: secrets in the repo never reach the AI', async () => {
  const leaky = { ...FILES, 'cart.js': CART.replace('let total = 0;', 'let total = 0; const token = "test_tok_9f8e7d6c";') };
  const seen = [];
  const spy = { name: 'spy', isConfigured: () => true, complete: async (req) => { seen.push(req.messages[0].content); throw new ai.AIProviderError('spy', 'unavailable', 'x'); } };
  const { r, config } = router([spy]);
  await assert.rejects(fix.runFix({ issue: { ...ISSUE, title: `failed for ops@shop.example ${FAKE_OWNER}` }, workspace: memWorkspace(leaky), router: r, config }));
  for (const leak of ['test_tok_9f8e7d6c', 'ops@shop.example', FAKE_OWNER, 'SECRET=1']) assert.ok(!seen[0].includes(leak), leak);
});
