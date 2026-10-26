'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IssueService, normalizeReport, parseStack, normalizeMessage, normalizePath } = require('../../server/issues');
const { memDb, memLogger, fakeClock } = require('../helpers');

const CHROME_STACK = `TypeError: Cannot read properties of undefined (reading 'percentOff')
    at calculateTotal (https://shop.example/cart.js:9:14)
    at HTMLButtonElement.<anonymous> (https://shop.example/app.js:20:5)`;

function svc() {
  const clock = fakeClock();
  return { clock, issues: new IssueService({ db: memDb(), clock, logger: memLogger() }) };
}

const report = (over = {}) =>
  normalizeReport({ type: 'error', name: 'TypeError', message: "Cannot read properties of undefined (reading 'percentOff')", stack: CHROME_STACK, source: 'https://shop.example/cart.js', line: 9, col: 14, url: 'https://shop.example/checkout?email=a@b.c', userAgent: 'UA', release: '1.0.0', ...over });

test('parseStack handles Chrome and Firefox formats and skips the snippet itself', () => {
  const ff = 'calculateTotal@https://shop.example/cart.js:9:14\n@https://shop.example/app.js:20:5';
  const snippetFrame = '    at w.fetch (https://shop.example/selfheal.min.js:1:900)\n';
  assert.deepEqual(parseStack(CHROME_STACK).map((f) => [f.fn, f.path, f.line]), [['calculateTotal', '/cart.js', 9], ['HTMLButtonElement.<anonymous>', '/app.js', 20]]);
  assert.deepEqual(parseStack(ff).map((f) => [f.path, f.line]), [['/cart.js', 9], ['/app.js', 20]]);
  assert.equal(parseStack('Error\n' + snippetFrame + '    at load (https://shop.example/app.js:3:1)')[0].path, '/app.js');
});

test('normalizers remove variable parts', () => {
  assert.equal(normalizeMessage('Order 12345 not found for 3f2a1b9c8d7e6f50'), 'Order N not found for <hex>');
  assert.equal(normalizePath('https://x/assets/app.3f2a1b9c.js?v=1'), '/assets/app.[hash].js');
  assert.equal(normalizePath('/api/orders/42/items'), '/api/orders/:id/items');
});

test('normalizeReport builds title, file, line and strips query strings', () => {
  const r = report();
  assert.equal(r.title, "TypeError: Cannot read properties of undefined (reading 'percentOff')");
  assert.equal(r.file, '/cart.js');
  assert.equal(r.line, 9);
  assert.equal(r.pageUrl, 'https://shop.example/checkout');
  assert.equal(normalizeReport(null), null);
  assert.equal(normalizeReport({ type: 'error' }), null, 'needs a message or stack');
  const noSource = normalizeReport({ type: 'error', message: 'x', stack: CHROME_STACK });
  assert.equal(noSource.file, '/cart.js');
  assert.equal(noSource.line, 9);
});

test('identical errors group into one issue with counts and first/last seen', () => {
  const { issues, clock } = svc();
  const a = issues.ingest(report());
  clock.advance(60_000);
  const b = issues.ingest(report({ url: 'https://shop.example/other' }));
  assert.equal(a.isNew, true);
  assert.equal(b.isNew, false);
  assert.equal(a.issue.id, b.issue.id);
  const issue = issues.get(a.issue.id);
  assert.equal(issue.count, 2);
  assert.notEqual(issue.first_seen, issue.last_seen);
  assert.equal(issues.occurrences(issue.id).length, 2);
  assert.equal(issues.events(issue.id)[0].type, 'created');
});

test('fingerprint = message + file + line: different line or file makes a new issue', () => {
  const { issues } = svc();
  const a = issues.ingest(report()).issue.id;
  const b = issues.ingest(report({ line: 30 })).issue.id;
  const c = issues.ingest(report({ source: 'https://shop.example/other.js' })).issue.id;
  assert.equal(new Set([a, b, c]).size, 3);
});

test('http errors group by method + path + status, ignoring ids', () => {
  const { issues } = svc();
  const mk = (u, st = 500) => normalizeReport({ type: 'http', method: 'GET', status: st, requestUrl: u, message: `HTTP ${st} GET ${u}` });
  const a = issues.ingest(mk('https://shop.example/api/orders/1')).issue.id;
  const b = issues.ingest(mk('https://shop.example/api/orders/2')).issue.id;
  const c = issues.ingest(mk('https://shop.example/api/orders/2', 404)).issue.id;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('keeps only the latest 20 occurrences', () => {
  const { issues } = svc();
  let id;
  for (let i = 0; i < 25; i++) id = issues.ingest(report()).issue.id;
  assert.equal(issues.get(id).count, 25);
  assert.equal(issues.occurrences(id).length, 20);
});

test('status transitions follow the state machine and are logged', () => {
  const { issues } = svc();
  const { id } = issues.ingest(report()).issue;
  const seen = [];
  issues.onTransition((i, from, to) => seen.push(`${from}->${to}`));
  assert.equal(issues.transition(id, 'alerted').ok, true);
  assert.equal(issues.transition(id, 'merged').ok, false, 'cannot skip ahead');
  assert.equal(issues.transition(id, 'approved', { reason: 'owner said yes' }).ok, true);
  assert.equal(issues.transition(id, 'fixing', { from: ['alerted'] }).ok, false, 'from guard');
  assert.equal(issues.transition(id, 'fixing', { from: ['approved'] }).ok, true);
  assert.equal(issues.transition(id, 'fix_ready').ok, true);
  assert.equal(issues.transition(id, 'merged').ok, true);
  assert.equal(issues.transition(id, 'rolled_back').ok, true);
  assert.deepEqual(seen, ['new->alerted', 'alerted->approved', 'approved->fixing', 'fixing->fix_ready', 'fix_ready->merged', 'merged->rolled_back']);
  const ev = issues.events(id).filter((e) => e.to_status);
  assert.equal(ev.length, 6);
  assert.ok(ev.every((e) => e.created_at));
  assert.equal(JSON.parse(ev[1].detail).reason, 'owner said yes');
  assert.throws(() => issues.transition(id, 'bogus'));
  assert.equal(issues.transition(9999, 'alerted').ok, false);
});

test('an error that returns well after a merge reopens the issue as a new cycle', () => {
  const { issues, clock } = svc();
  const { id } = issues.ingest(report()).issue;
  for (const s of ['alerted', 'approved', 'fixing', 'fix_ready', 'merged']) issues.transition(id, s);
  clock.advance(5 * 60_000);
  assert.equal(issues.ingest(report()).reopened, false, 'within grace period (old page versions)');
  clock.advance(60 * 60_000);
  const r = issues.ingest(report());
  assert.equal(r.reopened, true);
  assert.equal(r.issue.status, 'new');
  assert.equal(r.issue.cycle, 2);
  assert.ok(issues.events(id).some((e) => e.type === 'recurred'));
});

test('ignored issues stay ignored when the error repeats', () => {
  const { issues } = svc();
  const { id } = issues.ingest(report()).issue;
  issues.transition(id, 'ignored');
  const r = issues.ingest(report());
  assert.equal(r.isNew, false);
  assert.equal(r.reopened, false);
  assert.equal(issues.get(id).status, 'ignored');
});

test('counts, list and update', () => {
  const { issues } = svc();
  const { id } = issues.ingest(report()).issue;
  issues.ingest(report({ line: 2 }));
  issues.transition(id, 'alerted');
  assert.equal(issues.counts().new, 1);
  assert.equal(issues.counts().alerted, 1);
  assert.equal(issues.list({ status: 'alerted' }).length, 1);
  assert.equal(issues.list().length, 2);
  const u = issues.update(id, { root_cause: 'x', files_changed: [{ path: 'a.js' }], status: 'merged' });
  assert.equal(u.root_cause, 'x');
  assert.equal(u.status, 'alerted', 'status cannot be changed via update');
  assert.deepEqual(JSON.parse(u.files_changed), [{ path: 'a.js' }]);
});
