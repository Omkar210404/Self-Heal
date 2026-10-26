'use strict';
const crypto = require('node:crypto');
const { ProviderError } = require('./provider');
const { parseWebhook, verifyHmac, signBody } = require('./whatsapp-cloud');

/**
 * Fake WhatsApp for mock mode and tests. Keeps sent messages in memory and lets
 * tests inject failures: retryable outages, permanent errors, or a closed 24-hour window.
 */
class MockWhatsAppProvider {
  constructor({ appSecret, verifyToken }) {
    this.name = 'mock-whatsapp';
    this.appSecret = appSecret;
    this.verifyToken = verifyToken;
    this.outbox = [];
    this.failures = []; // queue of 'retryable' | 'permanent' | 'window'
    this.down = false;
    this.windowOpen = true;
    this.seq = 0;
  }

  /** Make the next n sends fail with the given kind. */
  failNext(kind = 'retryable', n = 1) {
    for (let i = 0; i < n; i++) this.failures.push(kind);
  }

  setDown(down) {
    this.down = !!down;
  }

  async deliver(type, to, data) {
    if (this.down) throw new ProviderError('Mock WhatsApp is down (simulated outage)', { retryable: true, status: 503 });
    const f = this.failures.shift();
    if (f === 'retryable') throw new ProviderError('Mock WhatsApp temporary error', { retryable: true, status: 503 });
    if (f === 'permanent') throw new ProviderError('Mock WhatsApp permanent error (invalid recipient)', { code: 131026, status: 400 });
    if ((f === 'window' || !this.windowOpen) && type !== 'template') {
      throw new ProviderError('WhatsApp API error 131047: Re-engagement message (24-hour window closed)', { windowClosed: true, code: 131047, status: 400 });
    }
    const id = `wamid.mock.${++this.seq}`;
    this.outbox.push({ id, type, to, at: new Date().toISOString(), ...data });
    return { id };
  }

  sendText(to, text) {
    return this.deliver('text', to, { text });
  }

  sendButtons(to, text, buttons) {
    return this.deliver('buttons', to, { text, buttons });
  }

  sendTemplate(to, name, lang, params = []) {
    return this.deliver('template', to, { template: name, lang, params, text: `[template ${name}] ${params.join(' ')}` });
  }

  verifySignature(rawBody, header) {
    return verifyHmac(this.appSecret, rawBody, header);
  }

  verifyChallenge(query) {
    if (query?.['hub.mode'] === 'subscribe' && query['hub.verify_token'] === this.verifyToken) return String(query['hub.challenge'] ?? '');
    return null;
  }

  parseWebhook(body) {
    return parseWebhook(body);
  }

  /** Builds a signed Meta-format webhook body, as if `from` had replied. */
  buildInbound({ from, text, buttonId, buttonTitle }) {
    const id = 'wamid.in.' + crypto.randomBytes(8).toString('hex');
    const message = buttonId
      ? { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId, title: buttonTitle || buttonId } } }
      : { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } };
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'mock', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: [message] } }] }] };
    const raw = Buffer.from(JSON.stringify(body));
    return { raw, signature: signBody(this.appSecret, raw), id };
  }

  /** Builds a signed status webhook (e.g. a delivery failure that arrives later). */
  buildStatus({ id, status, code }) {
    const s = { id, status, timestamp: String(Math.floor(Date.now() / 1000)) };
    if (code) s.errors = [{ code, title: 'Re-engagement message' }];
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'mock', changes: [{ field: 'messages', value: { statuses: [s] } }] }] };
    const raw = Buffer.from(JSON.stringify(body));
    return { raw, signature: signBody(this.appSecret, raw) };
  }
}

module.exports = { MockWhatsAppProvider };
