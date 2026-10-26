'use strict';
/*
 * Email channel (same MessagingProvider interface as WhatsApp).
 * Buttons become signed links: GET shows a confirm page (mail scanners prefetch links, so a GET never acts),
 * POST runs the command as the owner. Links are HMAC-signed with a key derived from .env secrets.
 */
const crypto = require('node:crypto');
const express = require('express');
const nodemailer = require('nodemailer');
const { ProviderError } = require('./provider');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LINK_TTL_MS = 14 * 24 * 3600_000;

function linkSigner(config) {
  const key = crypto.createHash('sha256').update(`selfheal-email-links:${config.projectKey}:${config.dashboard.password}`).digest();
  const sign = (cmd, exp) => crypto.createHmac('sha256', key).update(`${cmd}|${exp}`).digest('hex').slice(0, 32);
  return {
    url(cmd) {
      const exp = Date.now() + LINK_TTL_MS;
      return `${config.publicUrl}/email/action?c=${encodeURIComponent(cmd)}&e=${exp}&s=${sign(cmd, exp)}`;
    },
    verify(cmd, exp, sig) {
      if (!cmd || !exp || !sig || Number(exp) < Date.now()) return false;
      const want = sign(cmd, exp);
      return String(sig).length === want.length && crypto.timingSafeEqual(Buffer.from(String(sig)), Buffer.from(want));
    },
  };
}

class EmailProvider {
  constructor({ config, transport }) {
    const e = config.email;
    this.name = 'email';
    this.from = e.from || e.smtpUser;
    this.links = linkSigner(config);
    this.transport = transport || nodemailer.createTransport({ host: e.smtpHost, port: e.smtpPort, secure: e.smtpPort === 465, auth: { user: e.smtpUser, pass: e.smtpPass } });
  }

  normalizeAddress(a) { return String(a || '').trim().toLowerCase(); }

  async deliver(to, text, buttons = []) {
    const subject = text.split('\n')[0].replace(/[*_]/g, '').replace(/^\W+/u, '').slice(0, 120) || 'selfheal';
    const body = text.split('\n').slice(1).join('\n').trim();
    const html = `<div style="font:15px/1.5 system-ui,sans-serif;max-width:560px">
      <p style="font-size:17px"><b>${esc(subject)}</b></p>
      <p>${esc(body).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</p>
      ${buttons.map((b) => `<a href="${esc(this.links.url(b.id))}" style="display:inline-block;margin:6px 8px 0 0;padding:10px 18px;background:#1f6feb;color:#fff;border-radius:6px;text-decoration:none">${esc(b.title)}</a>`).join('')}
      <p style="color:#888;font-size:12px;margin-top:24px">Sent by selfheal. Buttons open a confirm page on your selfheal server.</p></div>`;
    const plain = `${text}\n\n${buttons.map((b) => `${b.title}: ${this.links.url(b.id)}`).join('\n')}`;
    try {
      const info = await this.transport.sendMail({ from: this.from, to, subject: `[selfheal] ${subject}`, text: plain, html });
      return { id: info.messageId || `email-${Date.now()}` };
    } catch (err) {
      // Auth/config errors (535, EAUTH) will not fix themselves; network/temporary ones are retried.
      const permanent = err.code === 'EAUTH' || err.responseCode === 535 || (err.responseCode >= 500 && err.responseCode < 600);
      const hint = err.code === 'EAUTH' ? ' (check SMTP_USER/SMTP_PASS; Gmail needs an App Password)' : '';
      throw new ProviderError(`Email send failed: ${err.message}${hint}`, { retryable: !permanent, code: err.code || err.responseCode });
    }
  }

  sendText(to, text) { return this.deliver(to, text); }
  sendButtons(to, text, buttons) { return this.deliver(to, text, buttons); }
  sendTemplate(to, name, lang, params) { return this.deliver(to, params.join(' ') || 'selfheal needs your attention'); }
  verifySignature() { return false; }
  verifyChallenge() { return null; }
  parseWebhook() { return { messages: [], statuses: [] }; }
}

const LABELS = { fix: 'Fix issue', ignore: 'Ignore issue', merge: 'Merge the fix for issue', reject: 'Reject the fix for issue', rollback: 'Roll back issue' };

/** GET /email/action shows a confirm button; POST runs the command as the owner. */
function createEmailRouter({ provider, notifier, config }) {
  const r = express.Router();
  const page = (body) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>selfheal</title>
    <body style="margin:0;background:#0d1117;color:#e6edf3;font:16px/1.5 system-ui,sans-serif"><div style="max-width:420px;margin:15vh auto;padding:24px;background:#161b22;border:1px solid #30363d;border-radius:12px">${body}
    <p style="margin-top:20px"><a style="color:#58a6ff" href="/dashboard">Open dashboard</a></p></div></body>`;
  r.get('/email/action', (req, res) => {
    const { c, e, s } = req.query;
    if (!provider.links.verify(c, e, s)) return res.status(403).send(page('<h2>Link expired or invalid</h2>'));
    const [action, id] = String(c).split(':');
    res.send(page(`<h2>${esc(LABELS[action] || action)} #${esc(id)}?</h2>
      <form method="post"><input type="hidden" name="c" value="${esc(c)}"><input type="hidden" name="e" value="${esc(e)}"><input type="hidden" name="s" value="${esc(s)}">
      <button style="padding:12px 22px;font:inherit;background:#1f6feb;color:#fff;border:0;border-radius:8px;cursor:pointer">Confirm</button></form>`));
  });
  r.post('/email/action', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res, next) => {
    try {
      const { c, e, s } = req.body || {};
      if (!provider.links.verify(c, e, s)) return res.status(403).send(page('<h2>Link expired or invalid</h2>'));
      await notifier.handleInbound({ id: `email-${crypto.randomUUID()}`, from: config.email.owner, buttonId: c });
      res.send(page('<h2>✅ Done</h2><p>You will get an email with the result shortly.</p>'));
    } catch (err) {
      next(err);
    }
  });
  return r;
}

module.exports = { EmailProvider, createEmailRouter, linkSigner };
