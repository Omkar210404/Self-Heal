'use strict';
/*
 * End-to-end in MOCK_MODE: real server, real SQLite, real queue, real git (local mock remote),
 * real test runs of the demo repo; fake WhatsApp / AI / GitHub API only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../../server/app');
const { loadConfig } = require('../../server/config');
const { createBrowser } = require('../helpers/fake-browser');
const { tmpDir, rmrf, memLogger, FAKE_STRANGER } = require('../helpers');

const SNIPPET = fs.readFileSync(path.join(__dirname, '../../snippet/dist/selfheal.min.js'), 'utf8');

let unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

async function boot(env = {}, mockModes = {}) {
  const dir = tmpDir('selfheal-e2e-');
  const config = loadConfig({ DATA_DIR: dir, QUEUE_POLL_MS: '20', QUEUE_BACKOFF_MS: '30', WHATSAPP_SEND_RETRIES: '2', SWEEP_INTERVAL_MS: '600000', ...env }, { mock: true });
  const logger = memLogger();
  const app = await createApp({ config, logger, mockModes });
  const port = await app.start({ port: 0, host: '127.0.0.1' });
  config.publicUrl = `http://127.0.0.1:${port}`;
  const base = config.publicUrl;
  const s = app.services;
  const ctx = {
    base, config, logger, s,
    outbox: () => s.provider.outbox,
    lastOut: () => s.provider.outbox.at(-1),
    issue: (id) => s.issues.get(id),
    async waitFor(fn, what, ms = 30000) {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for: ${what}\n${logger.lines.slice(-15).join('\n')}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    /** The owner replies on WhatsApp: a real signed webhook POST. */
    async reply(fields, from = config.whatsapp.ownerNumber) {
      const { raw, signature } = s.provider.buildInbound({ from, ...fields });
      const r = await fetch(`${base}/webhook/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature }, body: raw });
      assert.equal(r.status, 200);
    },
    /** A visitor hits the checkout bug in the demo site: real snippet, beacon delivered to the server. */
    async siteError() {
      const b = createBrowser({ dataset: { endpoint: `${base}/api/errors`, key: config.projectKey, release: 'demo-1.0.0' }, href: `${base}/demo/index.html` });
      b.load(SNIPPET);
      const err = new TypeError("Cannot read properties of undefined (reading 'percentOff')");
      err.stack = `${err.name}: ${err.message}\n    at calculateTotal (${base}/demo/cart.js:6:14)\n    at HTMLButtonElement.onclick (${base}/demo/app.js:7:17)`;
      b.dispatch('error', { error: err, message: err.message, filename: `${base}/demo/cart.js`, lineno: 6, colno: 14 });
      b.runTimers();
      for (const { url, data } of b.beacons) {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: await data.text() });
        assert.equal(r.status, 202);
      }
      return ctx.waitFor(() => s.issues.list()[0], 'issue created');
    },
    async close() { await app.stop(); rmrf(dir); },
  };
  return ctx;
}

test.afterEach(() => assert.deepEqual(unhandled, [], 'no unhandled promise rejections'));

test('happy path: error → issue → alert → approve → fail → retry → pass → PR → merge → rollback', { timeout: 120000 }, async () => {
  const t = await boot();
  try {
    // 1-3: error → issue → WhatsApp alert with buttons
    const issue = await t.siteError();
    const alert = await t.waitFor(() => t.outbox().find((m) => m.type === 'buttons'), 'alert');
    assert.match(alert.text, /New error on your site/);
    assert.deepEqual(alert.buttons.map((b) => b.title), ['Fix it', 'Ignore']);
    await t.waitFor(() => t.issue(issue.id).status === 'alerted', 'alerted');
    await t.siteError(); // duplicate error: grouped, no second alert
    assert.equal(t.issue(issue.id).count, 2);

    // 4-6: owner taps Fix it → AI fix #1 fails the tests → retry with output → passes
    await t.reply({ buttonId: `fix:${issue.id}` });
    const ready = await t.waitFor(() => t.outbox().find((m) => /Fix ready for issue/.test(m.text || '')), 'fix ready message', 60000);
    const i = t.issue(issue.id);
    assert.equal(i.status, 'fix_ready');
    assert.equal(i.attempts, 2);
    assert.equal(i.branch, `selfheal/issue-${issue.id}`);
    assert.match(ready.text, /Tests: ✅ passed on attempt 2 of 3/);
    assert.match(ready.text, /cart\.js \(\+1 −1\)/);
    assert.match(ready.text, /PR: http/);
    assert.deepEqual(ready.buttons.map((b) => b.title), ['Merge', 'Reject']);
    assert.ok(t.outbox().some((m) => /On it/.test(m.text || '')), 'acknowledged the approval');
    const attempts = t.s.db.prepare('SELECT test_passed FROM fix_attempts WHERE issue_id = ? ORDER BY id').all(issue.id);
    assert.deepEqual(attempts.map((a) => a.test_passed), [0, 1]);
    const pr = t.s.host.pr(i.pr_number);
    assert.match(pr.body, /Root cause/);
    assert.match(pr.body, /passed on attempt 2/);
    assert.equal(pr.base, 'main');

    // 7-8: owner taps Merge → merged; the mock "deploy" now serves the fixed code
    const before = await (await fetch(`${t.base}/demo/cart.js`)).text();
    assert.match(before, /if \(coupon\.percentOff\)/);
    await t.reply({ buttonId: `merge:${issue.id}` });
    await t.waitFor(() => t.issue(issue.id).status === 'merged', 'merged');
    await t.waitFor(() => t.outbox().some((m) => /Merged the fix/.test(m.text || '')), 'merged message');
    assert.match(await (await fetch(`${t.base}/demo/cart.js`)).text(), /coupon && coupon\.percentOff/);
    assert.equal(await t.s.host.branchExists(`selfheal/issue-${issue.id}`), false, 'own branch deleted after merge');

    // 9: ROLLBACK <id> as text → revert PR opened and merged
    await t.reply({ text: `rollback ${issue.id}` });
    await t.waitFor(() => t.issue(issue.id).status === 'rolled_back', 'rolled back', 60000);
    await t.waitFor(() => t.outbox().some((m) => /Rolled back issue/.test(m.text || '')), 'rollback message');
    assert.match(await (await fetch(`${t.base}/demo/cart.js`)).text(), /if \(coupon\.percentOff\)/);
    assert.ok(t.issue(issue.id).revert_pr_url);

    // Full history recorded
    const path_ = t.s.issues.events(issue.id).filter((e) => e.to_status).map((e) => e.to_status);
    assert.deepEqual(path_, ['alerted', 'approved', 'fixing', 'fix_ready', 'merged', 'rolled_back']);

    // Commands from strangers are ignored
    const sent = t.outbox().length;
    await t.reply({ text: `merge ${issue.id}` }, FAKE_STRANGER);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.outbox().length, sent);

    // Dashboard: login required, history page, secrets masked
    assert.equal((await fetch(`${t.base}/dashboard`, { redirect: 'manual' })).status, 302);
    const bad = await fetch(`${t.base}/dashboard/login`, { method: 'POST', body: new URLSearchParams({ password: 'nope' }), redirect: 'manual' });
    assert.match(bad.headers.get('location'), /e=1/);
    const login = await fetch(`${t.base}/dashboard/login`, { method: 'POST', body: new URLSearchParams({ password: t.config.dashboard.password }), redirect: 'manual' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const detail = await (await fetch(`${t.base}/dashboard/issues/${issue.id}`, { headers: { cookie } })).text();
    for (const s of ['AI diagnosis', 'Fix attempts', 'rolled back', 'History']) assert.ok(detail.includes(s), s);
    const settings = await (await fetch(`${t.base}/dashboard/settings`, { headers: { cookie } })).text();
    for (const secret of [t.config.projectKey, t.config.whatsapp.appSecret, t.config.dashboard.password]) assert.ok(!settings.includes(secret), 'secret masked');
    const csrfLess = await fetch(`${t.base}/dashboard/settings/test-message`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({}) });
    assert.equal(csrfLess.status, 403, 'POST without CSRF token refused');
    const phone = await (await fetch(`${t.base}/dashboard/phone`, { headers: { cookie } })).text();
    assert.match(phone, /Simulated WhatsApp/);
  } finally {
    await t.close();
  }
});

test('Ignore button and text YES without an id', { timeout: 60000 }, async () => {
  const t = await boot();
  try {
    const issue = await t.siteError();
    await t.waitFor(() => t.issue(issue.id).status === 'alerted', 'alerted');
    await t.reply({ text: 'IGNORE' });
    await t.waitFor(() => t.issue(issue.id).status === 'ignored', 'ignored');
    await t.reply({ text: 'yes' }); // nothing is waiting any more
    await t.waitFor(() => /no issue waiting/i.test(t.lastOut()?.text || ''), 'needs id reply');
  } finally {
    await t.close();
  }
});

test('failure: all AI providers down → fix_failed and the owner is told why', { timeout: 60000 }, async () => {
  const t = await boot({}, { 'mock-primary': 'down', 'mock-secondary': 'down' });
  try {
    const issue = await t.siteError();
    await t.waitFor(() => t.issue(issue.id).status === 'alerted', 'alerted');
    await t.reply({ text: `YES ${issue.id}` });
    await t.waitFor(() => t.issue(issue.id).status === 'fix_failed', 'fix_failed', 60000);
    const m = await t.waitFor(() => t.outbox().find((x) => /Could not fix issue/.test(x.text || '')), 'failure message');
    assert.match(m.text, /AI providers/);
    assert.match(m.text, /mock-primary.*down/);
    assert.match(m.text, /mock-secondary.*down/);
  } finally {
    await t.close();
  }
});

test('failure: tests fail 3 times → fix_failed, nothing pushed', { timeout: 90000 }, async () => {
  const t = await boot({}, { 'mock-primary': 'always-wrong' });
  try {
    const issue = await t.siteError();
    await t.waitFor(() => t.issue(issue.id).status === 'alerted', 'alerted');
    await t.reply({ buttonId: `fix:${issue.id}` });
    await t.waitFor(() => t.issue(issue.id).status === 'fix_failed', 'fix_failed', 90000);
    const m = await t.waitFor(() => t.outbox().find((x) => /Could not fix issue/.test(x.text || '')), 'failure message');
    assert.match(m.text, /Tests still failed after 3 attempts/);
    assert.equal(t.s.db.prepare('SELECT COUNT(*) AS n FROM fix_attempts').get().n, 3);
    assert.equal(await t.s.host.branchExists(`selfheal/issue-${issue.id}`), false);
  } finally {
    await t.close();
  }
});

test('failure: WhatsApp send fails → retried, then marked failed and shown on the dashboard', { timeout: 60000 }, async () => {
  const t = await boot();
  try {
    t.s.provider.setDown(true);
    const issue = await t.siteError();
    await t.waitFor(() => t.s.issues.events(issue.id).some((e) => e.type === 'notify_failed'), 'notify_failed');
    assert.equal(t.issue(issue.id).status, 'new', 'not marked alerted: the owner was never told');
    assert.equal(t.s.notifier.failures()[0].status, 'failed');
    const jobs = t.s.queue.list().filter((j) => j.type === 'wa_send');
    assert.equal(jobs[0].attempts, 2, 'retried up to WHATSAPP_SEND_RETRIES');
  } finally {
    await t.close();
  }
});

test('failure: 24-hour window closed → template, full alert resent after the owner replies', { timeout: 60000 }, async () => {
  const t = await boot();
  try {
    t.s.provider.windowOpen = false;
    const issue = await t.siteError();
    const tpl = await t.waitFor(() => t.outbox().find((m) => m.type === 'template'), 'template');
    assert.match(tpl.params[0], new RegExp(`#${issue.id}`));
    t.s.provider.windowOpen = true;
    await t.reply({ text: 'hi' });
    await t.waitFor(() => t.outbox().find((m) => m.type === 'buttons'), 'resent alert with buttons');
  } finally {
    await t.close();
  }
});

test('failure: merge conflict → owner told, nothing forced', { timeout: 90000 }, async () => {
  const t = await boot({}, { 'mock-primary': 'right' });
  try {
    const issue = await t.siteError();
    await t.waitFor(() => t.issue(issue.id).status === 'alerted', 'alerted');
    await t.reply({ buttonId: `fix:${issue.id}` });
    await t.waitFor(() => t.issue(issue.id).status === 'fix_ready', 'fix_ready', 60000);
    await t.s.host.pushToBase('cart.js', '// someone rewrote this file\n');
    await t.reply({ text: 'MERGE' });
    const m = await t.waitFor(() => t.outbox().find((x) => /Could not merge issue/.test(x.text || '')), 'merge blocked message', 60000);
    assert.match(m.text, /merge conflict/);
    assert.equal(t.issue(issue.id).status, 'fix_ready');
    assert.ok(t.s.issues.events(issue.id).some((e) => e.type === 'merge_conflict'));
    assert.match(await (await fetch(`${t.base}/demo/cart.js`)).text(), /someone rewrote/, 'main untouched');
  } finally {
    await t.close();
  }
});

test('failure: daily AI cap reached → fixing paused, owner told, job deferred to tomorrow', { timeout: 60000 }, async () => {
  const t = await boot({ AI_DAILY_MAX_CALLS: '0' });
  try {
    const issue = await t.siteError();
    await t.waitFor(() => t.issue(issue.id).status === 'alerted', 'alerted');
    await t.reply({ buttonId: `fix:${issue.id}` });
    const m = await t.waitFor(() => t.outbox().find((x) => /Daily AI limit reached/.test(x.text || '')), 'cost cap message');
    assert.match(m.text, /resume automatically/);
    assert.equal(t.issue(issue.id).status, 'approved');
    assert.ok(t.s.issues.events(issue.id).some((e) => e.type === 'paused_cost_cap'));
    const job = t.s.queue.active('fix', { issueId: issue.id })[0];
    assert.ok(job.run_at > Date.now() + 60_000, 'deferred, not failed');
  } finally {
    await t.close();
  }
});

test('startup fails clearly in real mode when nothing is configured', async () => {
  const dir = tmpDir();
  try {
    await assert.rejects(createApp({ config: loadConfig({ DATA_DIR: dir }), logger: memLogger() }), (e) => /No AI provider is configured/.test(e.message) && /GITHUB_TOKEN/.test(e.message));
  } finally {
    rmrf(dir);
  }
});
