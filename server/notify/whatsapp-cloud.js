'use strict';
const crypto = require('node:crypto');
const { ProviderError } = require('./provider');

// Meta error codes (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)
const WINDOW_CLOSED = 131047; // re-engagement: more than 24h since the user last wrote
const RETRYABLE_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056]);
const HINTS = {
  190: 'Access token is invalid or expired: create a new WHATSAPP_TOKEN (use a System User token for long-lived access).',
  131030: 'Your number is not in the allowed recipients list: add it under WhatsApp > API Setup > "To" in the Meta dashboard.',
  132001: 'Template does not exist or is not approved in this language: check WHATSAPP_TEMPLATE_NAME and WHATSAPP_TEMPLATE_LANG.',
  132000: 'Template parameter count does not match: check WHATSAPP_TEMPLATE_HAS_BODY_PARAM.',
  131026: 'Message undeliverable: the number may not be on WhatsApp.',
  100: 'Invalid parameter: check WHATSAPP_PHONE_NUMBER_ID.',
};

function classifyError(status, body) {
  const e = body?.error || {};
  const code = e.code ?? null;
  const detail = e.error_data?.details || e.message || `HTTP ${status}`;
  const hint = HINTS[code] ? ` ${HINTS[code]}` : '';
  return new ProviderError(`WhatsApp API error${code ? ` ${code}` : ''}: ${detail}.${hint}`, {
    code,
    status,
    windowClosed: code === WINDOW_CLOSED,
    retryable: status >= 500 || status === 429 || RETRYABLE_CODES.has(code),
  });
}

/** Parses a Meta webhook payload into inbound messages and delivery statuses. */
function parseWebhook(body) {
  const messages = [];
  const statuses = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const v = change?.value || {};
      for (const m of v.messages || []) {
        const out = { id: m.id, from: String(m.from || ''), timestamp: Number(m.timestamp) || null, type: m.type };
        if (m.type === 'text') out.text = m.text?.body || '';
        else if (m.type === 'interactive' && m.interactive?.type === 'button_reply') {
          out.buttonId = m.interactive.button_reply?.id;
          out.buttonTitle = m.interactive.button_reply?.title;
        } else if (m.type === 'button') {
          // Quick-reply button on a template message.
          out.buttonId = m.button?.payload;
          out.buttonTitle = m.button?.text;
          out.text = m.button?.text;
        }
        if (out.id) messages.push(out);
      }
      for (const s of v.statuses || []) {
        if (!s?.id) continue;
        statuses.push({ id: s.id, status: s.status, errors: (s.errors || []).map((x) => ({ code: x.code, title: x.title || x.message || '' })) });
      }
    }
  }
  return { messages, statuses };
}

function verifyHmac(appSecret, rawBody, header) {
  if (!appSecret || !header || !Buffer.isBuffer(rawBody)) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header).trim());
  if (!m) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const got = Buffer.from(m[1], 'hex');
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

function signBody(appSecret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

/** WhatsApp limits: interactive body 1024 chars, button titles 20, text 4096. */
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

class WhatsAppCloudProvider {
  constructor({ token, phoneNumberId, appSecret, verifyToken, apiVersion = 'v23.0', graphUrl = 'https://graph.facebook.com', fetch = globalThis.fetch, timeoutMs = 15000 }) {
    this.name = 'whatsapp-cloud';
    this.token = token;
    this.phoneNumberId = phoneNumberId;
    this.appSecret = appSecret;
    this.verifyToken = verifyToken;
    this.url = `${graphUrl.replace(/\/+$/, '')}/${apiVersion}/${phoneNumberId}/messages`;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
  }

  async request(payload) {
    let res;
    try {
      res = await this.fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ProviderError(`WhatsApp API unreachable: ${err?.name === 'TimeoutError' ? 'timed out' : err?.message}`, { retryable: true });
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) throw classifyError(res.status, body);
    const id = body?.messages?.[0]?.id;
    if (!id) throw new ProviderError('WhatsApp API returned no message id', { retryable: true });
    return { id };
  }

  sendText(to, text) {
    return this.request({ to, type: 'text', text: { preview_url: false, body: clip(text, 4096) } });
  }

  sendButtons(to, text, buttons) {
    return this.request({
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: clip(text, 1024) },
        action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: clip(b.title, 20) } })) },
      },
    });
  }

  sendTemplate(to, name, lang, params = []) {
    const template = { name, language: { code: lang } };
    if (params.length) {
      // Template variables may not contain newlines, tabs or 4+ spaces in a row.
      const clean = (p) => clip(String(p).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   '), 900);
      template.components = [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: clean(p) })) }];
    }
    return this.request({ to, type: 'template', template });
  }

  verifySignature(rawBody, header) {
    return verifyHmac(this.appSecret, rawBody, header);
  }

  verifyChallenge(query) {
    if (query?.['hub.mode'] === 'subscribe' && this.verifyToken && query['hub.verify_token'] === this.verifyToken) {
      return String(query['hub.challenge'] ?? '');
    }
    return null;
  }

  parseWebhook(body) {
    return parseWebhook(body);
  }
}

module.exports = { WhatsAppCloudProvider, parseWebhook, classifyError, verifyHmac, signBody, WINDOW_CLOSED };
