'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Notifier } = require('../../server/notify/notifier');
const { MockWhatsAppProvider } = require('../../server/notify/mock-whatsapp');
const { createWebhookRouter } = require('../../server/notify/webhook');
const { JobQueue } = require('../../server/queue');
const { IssueService, normalizeReport } = require('../../server/issues');
const { loadConfig } = require('../../server/config');
const { memDb, memLogger, fakeClock, listen, FAKE_OWNER, FAKE_STRANGER } = require('../helpers');

function setup(env = {}) {
  const clock = fakeClock();
  const db = memDb();
  const config = loadConfig({ OWNER_WHATSAPP_NUMBER: FAKE_OWNER, WHATSAPP_TEMPLATE_NAME: 'selfheal_alert', MAX_ALERTS_PER_HOUR: '3', WHATSAPP_SEND_RETRIES: '3', ...env });
  const logger = memLogger([FAKE_OWNER]);
  const queue = new JobQueue({ db, logger, clock, backoffMs: 1000 });
  const issues = new IssueService({ db, clock, logger });
  const provider = new MockWhatsAppProvider({ appSecret: 'test-app-secret', verifyToken: 'test-verify' });
  const notifier = new Notifier({ db, queue, provider, issues, config, logger, clock });
  const newIssue = (n = 1) => issues.ingest(normalizeReport({ type: 'error', name: 'TypeError', message: `boom ${'x'.repeat(n)}`, source: 'https://s.example/a.js', line: n })).issue;
  const reply = (fields) => {
    const { raw, signature } = provider.buildInbound({ from: FAKE_OWNER, ...fields });
    return notifier.processWebhook(raw, signature);
  };
  return { clock, db, config, logger, queue, issues, provider, notifier, newIssue, reply };
}

test('alert is sent with Fix it / Ignore buttons and the issue becomes alerted', async () => {
  const s = setup();
  const issue = s.newIssue();
  s.notifier.alertIssue(issue);
  await s.queue.drain();
  const [m] = s.provider.outbox;
  assert.equal(m.type, 'buttons');
  assert.equal(m.to, FAKE_OWNER);
  assert.match(m.text, new RegExp(`issue #${issue.id}`));
  assert.match(m.text, /a\.js line 1/);
  assert.deepEqual(m.buttons.map((b) => b.id), [`fix:${issue.id}`, `ignore:${issue.id}`]);
  assert.equal(s.issues.get(issue.id).status, 'alerted');
});

test('never sends a duplicate alert for the same issue', async () => {
  const s = setup();
  const issue = s.newIssue();
  s.notifier.alertIssue(issue);
  s.notifier.alertIssue(issue);
  await s.queue.drain();
  s.notifier.alertIssue(s.issues.get(issue.id));
  await s.queue.drain();
  assert.equal(s.provider.outbox.length, 1);
});

test('more than MAX_ALERTS_PER_HOUR issues are bundled into one summary', async () => {
  const s = setup();
  const list = [1, 2, 3, 4, 5].map((n) => s.newIssue(n));
  for (const i of list) s.notifier.alertIssue(i);
  await s.queue.drain();
  assert.equal(s.provider.outbox.length, 3, 'three individual alerts');
  assert.equal(s.issues.get(list[3].id).status, 'new');
  s.clock.advance(60 * 60_000);
  await s.queue.drain();
  assert.equal(s.provider.outbox.length, 4, 'one summary message');
  const summary = s.provider.outbox[3];
  assert.equal(summary.type, 'text');
  assert.match(summary.text, /2 more new errors/);
  assert.match(summary.text, new RegExp(`#${list[3].id} `));
  assert.match(summary.text, new RegExp(`#${list[4].id} `));
  assert.equal(s.issues.get(list[3].id).status, 'alerted');
  assert.equal(s.issues.get(list[4].id).status, 'alerted');
  assert.ok(s.issues.events(list[3].id).some((e) => e.type === 'alert_bundled'));
});

test('retries failed sends with backoff, then succeeds', async () => {
  const s = setup();
  s.provider.failNext('retryable', 2);
  const issue = s.newIssue();
  s.notifier.alertIssue(issue);
  await s.queue.drain();
  assert.equal(s.provider.outbox.length, 0);
  s.clock.advance(1000);
  await s.queue.drain();
  s.clock.advance(2000);
  await s.queue.drain();
  assert.equal(s.provider.outbox.length, 1);
  assert.equal(s.issues.get(issue.id).status, 'alerted');
});

test('when every retry fails the message is marked failed and the issue gets a notify_failed event', async () => {
  const s = setup();
  s.provider.setDown(true);
  const issue = s.newIssue();
  const { id } = s.notifier.alertIssue(issue);
  for (let i = 0; i < 5; i++) { await s.queue.drain(); s.clock.advance(10_000); }
  assert.equal(s.notifier.getMessage(id).status, 'failed');
  assert.match(s.notifier.getMessage(id).error, /down/);
  assert.ok(s.issues.events(issue.id).some((e) => e.type === 'notify_failed'));
  assert.equal(s.issues.get(issue.id).status, 'new', 'not marked alerted because the owner was never told');
  assert.equal(s.notifier.failures().length, 1);
});

test('permanent errors are not retried', async () => {
  const s = setup();
  s.provider.failNext('permanent');
  const { id } = s.notifier.send({ kind: 'reply', message: { text: 'x' } });
  await s.queue.drain();
  assert.equal(s.notifier.getMessage(id).status, 'failed');
});

test('24-hour window closed: falls back to the template, then resends the original when the owner replies', async () => {
  const s = setup();
  s.provider.windowOpen = false;
  const issue = s.newIssue();
  const { id } = s.notifier.alertIssue(issue);
  await s.queue.drain();
  assert.equal(s.provider.outbox.length, 1);
  const tpl = s.provider.outbox[0];
  assert.equal(tpl.type, 'template');
  assert.equal(tpl.template, 'selfheal_alert');
  assert.match(tpl.params[0], new RegExp(`New error #${issue.id}`));
  assert.equal(s.notifier.getMessage(id).status, 'awaiting_window');
  assert.equal(s.issues.get(issue.id).status, 'alerted', 'the owner was told via the template');

  // Owner replies (window opens) -> the full alert with buttons is resent.
  s.provider.windowOpen = true;
  assert.equal(await s.reply({ text: 'hi' }), 200);
  await s.queue.drain();
  const resent = s.provider.outbox.find((m) => m.type === 'buttons');
  assert.ok(resent, 'original interactive alert resent');
  assert.equal(s.notifier.getMessage(id).status, 'resent');
  assert.equal(s.provider.outbox.filter((m) => m.type === 'text').length, 0, 'no extra help reply on top of the resend');
});

test('a window-closed failure reported later by a status webhook also falls back to the template', async () => {
  const s = setup();
  const { id } = s.notifier.send({ kind: 'reply', message: { text: 'later failure', summary: 'Summary here' } });
  await s.queue.drain();
  const wamid = s.notifier.getMessage(id).provider_message_id;
  const { raw, signature } = s.provider.buildStatus({ id: wamid, status: 'failed', code: 131047 });
  assert.equal(await s.notifier.processWebhook(raw, signature), 200);
  await s.queue.drain();
  assert.equal(s.provider.outbox[1].type, 'template');
  assert.equal(s.notifier.getMessage(id).status, 'awaiting_window');
});

test('window closed and no template configured: clear failure', async () => {
  const s = setup({ WHATSAPP_TEMPLATE_NAME: '' });
  s.provider.windowOpen = false;
  const { id } = s.notifier.send({ kind: 'reply', message: { text: 'x' } });
  await s.queue.drain();
  assert.equal(s.notifier.getMessage(id).status, 'failed');
  assert.match(s.notifier.getMessage(id).error, /WHATSAPP_TEMPLATE_NAME is not set/);
});

test('template without a body parameter sends no params', async () => {
  const s = setup({ WHATSAPP_TEMPLATE_HAS_BODY_PARAM: 'false', WHATSAPP_TEMPLATE_NAME: 'hello_world' });
  s.provider.windowOpen = false;
  s.notifier.send({ kind: 'reply', message: { text: 'x' } });
  await s.queue.drain();
  assert.deepEqual(s.provider.outbox[0].params, []);
});

test('delivery status updates are recorded', async () => {
  const s = setup();
  const { id } = s.notifier.send({ kind: 'reply', message: { text: 'x' } });
  await s.queue.drain();
  const wamid = s.notifier.getMessage(id).provider_message_id;
  const { raw, signature } = s.provider.buildStatus({ id: wamid, status: 'read' });
  await s.notifier.processWebhook(raw, signature);
  assert.equal(s.notifier.getMessage(id).status, 'read');
});

test('commands from the owner reach the handler and the reply is sent', async () => {
  const s = setup();
  const seen = [];
  s.notifier.setCommandHandler(async (cmd) => { seen.push(cmd); return { text: `ok ${cmd.action} ${cmd.id}` }; });
  await s.reply({ buttonId: 'fix:7', buttonTitle: 'Fix it' });
  await s.reply({ text: 'merge 7' });
  await s.queue.drain();
  assert.deepEqual(seen.map((c) => [c.action, c.id]), [['fix', 7], ['merge', 7]]);
  assert.deepEqual(s.provider.outbox.map((m) => m.text), ['ok fix 7', 'ok merge 7']);
  assert.ok(s.notifier.ownerLastInboundAt());
});

test('a failing command handler produces an error reply instead of silence', async () => {
  const s = setup();
  s.notifier.setCommandHandler(async () => { throw new Error('database on fire'); });
  await s.reply({ text: 'yes 1' });
  await s.queue.drain();
  assert.match(s.provider.outbox[0].text, /Something went wrong.*database on fire/);
});

test('messages from anyone but the owner are ignored and logged with the number masked', async () => {
  const s = setup();
  let called = false;
  s.notifier.setCommandHandler(async () => { called = true; return null; });
  const { raw, signature } = s.provider.buildInbound({ from: FAKE_STRANGER, text: 'MERGE 1' });
  await s.notifier.processWebhook(raw, signature);
  assert.equal(called, false);
  const log = s.logger.lines.join('\n');
  assert.match(log, /unknown sender/);
  assert.ok(!log.includes(FAKE_STRANGER), 'number masked in logs');
  const row = s.db.prepare("SELECT * FROM messages WHERE direction = 'in'").get();
  assert.equal(row.status, 'ignored');
  assert.ok(!row.payload.includes(FAKE_STRANGER), 'number masked in the database');
});

test('duplicate webhook deliveries are processed once', async () => {
  const s = setup();
  let n = 0;
  s.notifier.setCommandHandler(async () => { n++; return null; });
  const { raw, signature } = s.provider.buildInbound({ from: FAKE_OWNER, text: 'yes 1' });
  await s.notifier.processWebhook(raw, signature);
  await s.notifier.processWebhook(raw, signature);
  assert.equal(n, 1);
});

test('webhook HTTP routes: verification handshake and signature check', async (t) => {
  const s = setup();
  s.notifier.setCommandHandler(async () => null);
  const app = express();
  app.use(createWebhookRouter({ provider: s.provider, notifier: s.notifier, logger: s.logger }));
  const srv = await listen(app);
  t.after(srv.close);
  const good = await fetch(`${srv.url}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=987`);
  assert.equal(good.status, 200);
  assert.equal(await good.text(), '987');
  assert.equal((await fetch(`${srv.url}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1`)).status, 403);

  const { raw, signature } = s.provider.buildInbound({ from: FAKE_OWNER, text: 'help' });
  const post = (sig) => fetch(`${srv.url}/webhook/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Hub-Signature-256': sig } : {}) }, body: raw });
  assert.equal((await post(signature)).status, 200);
  assert.equal((await post('sha256=' + '0'.repeat(64))).status, 401);
  assert.equal((await post(null)).status, 401);
});
