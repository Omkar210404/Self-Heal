'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WhatsAppCloudProvider, parseWebhook, classifyError, signBody } = require('../../server/notify/whatsapp-cloud');
const { jsonResponse, stubFetch, FAKE_OWNER } = require('../helpers');

const make = (fetch) =>
  new WhatsAppCloudProvider({ token: 'test-token-abc', phoneNumberId: 'PID', appSecret: 'test-app-secret', verifyToken: 'test-verify', apiVersion: 'v23.0', fetch });
const ok = () => jsonResponse(200, { messages: [{ id: 'wamid.X' }] });

test('sendText posts the right payload with a bearer token', async () => {
  const f = stubFetch(ok());
  const r = await make(f).sendText(FAKE_OWNER, 'hello');
  assert.equal(r.id, 'wamid.X');
  const c = f.calls[0];
  assert.equal(c.url, 'https://graph.facebook.com/v23.0/PID/messages');
  assert.equal(c.init.headers.Authorization, 'Bearer test-token-abc');
  assert.deepEqual(c.body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: FAKE_OWNER, type: 'text', text: { preview_url: false, body: 'hello' } });
});

test('sendButtons builds interactive reply buttons within WhatsApp limits', async () => {
  const f = stubFetch(ok());
  await make(f).sendButtons(FAKE_OWNER, 'x'.repeat(2000), [{ id: 'fix:1', title: 'Fix it' }, { id: 'ignore:1', title: 'A very very long button title' }, { id: 'a', title: 'a' }, { id: 'b', title: 'b' }]);
  const i = f.calls[0].body.interactive;
  assert.equal(i.type, 'button');
  assert.equal(i.body.text.length, 1024);
  assert.equal(i.action.buttons.length, 3, 'max 3 buttons');
  assert.deepEqual(i.action.buttons[0], { type: 'reply', reply: { id: 'fix:1', title: 'Fix it' } });
  assert.equal(i.action.buttons[1].reply.title.length, 20);
});

test('sendTemplate with and without a body parameter; parameter is cleaned', async () => {
  const f = stubFetch(ok());
  const p = make(f);
  await p.sendTemplate(FAKE_OWNER, 'selfheal_alert', 'en', ['line one\nline two\t     spaced']);
  const t = f.calls[0].body.template;
  assert.equal(t.name, 'selfheal_alert');
  assert.deepEqual(t.language, { code: 'en' });
  assert.equal(t.components[0].parameters[0].text, 'line one line two    spaced'.replace(/ {4,}/, '   '));
  await p.sendTemplate(FAKE_OWNER, 'hello_world', 'en_US', []);
  assert.equal(f.calls[1].body.template.components, undefined);
});

test('classifies errors: window closed, retryable, permanent with hints', async () => {
  const w = classifyError(400, { error: { code: 131047, message: 'Re-engagement message' } });
  assert.equal(w.windowClosed, true);
  assert.equal(w.retryable, false);
  assert.equal(classifyError(503, null).retryable, true);
  assert.equal(classifyError(400, { error: { code: 130429 } }).retryable, true, 'rate limit');
  const auth = classifyError(401, { error: { code: 190, message: 'expired' } });
  assert.equal(auth.retryable, false);
  assert.match(auth.message, /System User token/);
  assert.match(classifyError(400, { error: { code: 131030 } }).message, /allowed recipients/);

  const p = make(stubFetch(jsonResponse(400, { error: { code: 131047, message: 'Re-engagement' } })));
  await assert.rejects(p.sendText(FAKE_OWNER, 'x'), (e) => e.windowClosed === true);
  const net = make(stubFetch(new TypeError('fetch failed')));
  await assert.rejects(net.sendText(FAKE_OWNER, 'x'), (e) => e.retryable === true && /unreachable/.test(e.message));
  const noId = make(stubFetch(jsonResponse(200, {})));
  await assert.rejects(noId.sendText(FAKE_OWNER, 'x'), (e) => e.retryable === true);
});

test('verifies X-Hub-Signature-256 against the raw body', () => {
  const p = make(stubFetch(ok()));
  const raw = Buffer.from('{"a":1}');
  assert.equal(p.verifySignature(raw, signBody('test-app-secret', raw)), true);
  assert.equal(p.verifySignature(raw, signBody('wrong-secret', raw)), false);
  assert.equal(p.verifySignature(Buffer.from('{"a":2}'), signBody('test-app-secret', raw)), false, 'tampered body');
  assert.equal(p.verifySignature(raw, undefined), false);
  assert.equal(p.verifySignature(raw, 'sha256=nothex'), false);
});

test('webhook challenge only with the right verify token', () => {
  const p = make(stubFetch(ok()));
  assert.equal(p.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify', 'hub.challenge': '123' }), '123');
  assert.equal(p.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '123' }), null);
});

test('parseWebhook reads text, button replies, template buttons and statuses', () => {
  const body = {
    entry: [{
      changes: [{
        value: {
          messages: [
            { from: FAKE_OWNER, id: 'm1', timestamp: '1', type: 'text', text: { body: 'YES 4' } },
            { from: FAKE_OWNER, id: 'm2', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'merge:4', title: 'Merge' } } },
            { from: FAKE_OWNER, id: 'm3', type: 'button', button: { payload: 'fix:5', text: 'Fix it' } },
            { from: FAKE_OWNER, type: 'text', text: { body: 'no id, skipped' } },
          ],
          statuses: [{ id: 'wamid.X', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }],
        },
      }],
    }],
  };
  const { messages, statuses } = parseWebhook(body);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].text, 'YES 4');
  assert.equal(messages[1].buttonId, 'merge:4');
  assert.equal(messages[2].buttonId, 'fix:5');
  assert.deepEqual(statuses, [{ id: 'wamid.X', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }]);
  assert.deepEqual(parseWebhook(null), { messages: [], statuses: [] });
});
