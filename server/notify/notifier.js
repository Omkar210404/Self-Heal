'use strict';
const { PermanentError } = require('../queue');
const { parseCommand } = require('./commands');
const { WINDOW_CLOSED } = require('./whatsapp-cloud');
const msgs = require('./messages');

const HOUR = 3600_000;

/**
 * Provider-agnostic owner messaging.
 * - Every outgoing message is a row in `messages`; sending happens in queue jobs (lane "notify"),
 *   so sends are retried with backoff and survive restarts.
 * - dedupe keys make duplicate alerts impossible (alert:<issue>:<cycle>).
 * - Free-form messages refused because the 24-hour window is closed (error 131047, returned
 *   immediately or reported later by a status webhook) fall back to the approved template.
 *   The original message is re-sent as soon as the owner writes back (window open again).
 * - At most MAX_ALERTS_PER_HOUR individual alerts; extra issues are bundled into one summary.
 */
class Notifier {
  constructor({ db, queue, provider, issues, config, logger, clock = { now: () => Date.now() } }) {
    this.db = db;
    this.queue = queue;
    this.provider = provider;
    this.issues = issues;
    this.config = config;
    this.wa = config.whatsapp;
    this.owner = config.whatsapp.ownerNumber;
    this.logger = logger;
    this.clock = clock;
    this.commandHandler = null;

    const retry = { lane: 'notify', maxAttempts: Math.max(1, this.wa.sendRetries) };
    queue.register('wa_send', (p) => this.deliver(p.messageId), { ...retry, onFail: (p, err) => this.markFailed(p.messageId, err) });
    queue.register('wa_template', (p) => this.deliverTemplate(p.messageId), { ...retry, onFail: (p, err) => this.markFailed(p.messageId, err) });
    queue.register('wa_bundle', () => this.sendBundle(), { lane: 'notify', maxAttempts: 3 });
  }

  iso(ms = this.clock.now()) {
    return new Date(ms).toISOString();
  }

  /** fn(command, inbound) => message|null. Set by the workflow. */
  setCommandHandler(fn) {
    this.commandHandler = fn;
  }

  getMessage(id) {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) || null;
  }

  setMessage(id, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE messages SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), this.iso(), id);
  }

  insertMessage({ direction, kind, issueId = null, dedupeKey = null, payload, status }) {
    const now = this.iso();
    const info = this.db
      .prepare(
        `INSERT INTO messages (direction, issue_id, kind, dedupe_key, payload, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`
      )
      .run(direction, issueId, kind, dedupeKey, JSON.stringify(payload), status, now, now);
    return info.changes ? Number(info.lastInsertRowid) : null;
  }

  /**
   * Queues a message to the owner. With a dedupeKey, the same message is never sent twice.
   * @param {{kind: string, issueId?: number|null, message: {text: string, buttons?: any[], summary?: string}, dedupeKey?: string|null, meta?: object}} m
   */
  send({ kind, issueId = null, message, dedupeKey = null, meta = {} }) {
    const id = this.insertMessage({
      direction: 'out',
      kind,
      issueId,
      dedupeKey,
      payload: { text: message.text, buttons: message.buttons || null, summary: message.summary || msgs.short(message.text, 120), meta },
      status: 'queued',
    });
    if (!id) return { duplicate: true, id: this.db.prepare('SELECT id FROM messages WHERE dedupe_key = ?').get(dedupeKey)?.id };
    this.queue.enqueue('wa_send', { messageId: id }, { dedupeKey: `wa_send:${id}` });
    return { duplicate: false, id };
  }

  /** Job: send one queued message. Throws to retry (retryable errors only). */
  async deliver(messageId) {
    const m = this.getMessage(messageId);
    if (!m || !['queued', 'retrying'].includes(m.status)) return; // already handled (e.g. resumed after restart)
    const p = JSON.parse(m.payload);
    try {
      const r = p.buttons?.length ? await this.provider.sendButtons(this.owner, p.text, p.buttons) : await this.provider.sendText(this.owner, p.text);
      this.setMessage(m.id, { status: 'sent', provider_message_id: r.id, error: null });
      this.onDelivered(m);
    } catch (err) {
      if (err?.windowClosed) return this.fallbackToTemplate(m);
      this.setMessage(m.id, { status: 'retrying', error: this.logger.mask(err?.message || String(err)) });
      if (!err?.retryable) throw new PermanentError(err?.message || String(err));
      throw err;
    }
  }

  /** The 24-hour window is closed: send the approved template instead and resend the original later. */
  fallbackToTemplate(m) {
    if (!this.wa.templateName) {
      throw new PermanentError('The 24-hour WhatsApp window is closed and WHATSAPP_TEMPLATE_NAME is not set, so the message could not be delivered.');
    }
    this.setMessage(m.id, { status: 'awaiting_window', error: '24-hour window closed: template sent instead; will resend when you reply' });
    const p = JSON.parse(m.payload);
    const tid = this.insertMessage({
      direction: 'out',
      kind: 'template',
      issueId: m.issue_id,
      dedupeKey: `template:${m.id}`,
      payload: { text: p.summary, summary: p.summary, meta: { originalId: m.id } },
      status: 'queued',
    });
    if (tid) this.queue.enqueue('wa_template', { messageId: tid }, { dedupeKey: `wa_template:${tid}` });
    this.logger.warn(`WhatsApp 24-hour window closed; falling back to template "${this.wa.templateName}" for message #${m.id}`);
    if (m.issue_id) this.issues.addEvent(m.issue_id, 'whatsapp_template_fallback', { kind: m.kind });
  }

  async deliverTemplate(messageId) {
    const t = this.getMessage(messageId);
    if (!t || !['queued', 'retrying'].includes(t.status)) return;
    const p = JSON.parse(t.payload);
    const params = this.wa.templateHasBodyParam ? [`${p.summary}. Reply HELP or any message to see the details.`] : [];
    try {
      const r = await this.provider.sendTemplate(this.owner, this.wa.templateName, this.wa.templateLang, params);
      this.setMessage(t.id, { status: 'sent', provider_message_id: r.id, error: null });
      const original = p.meta?.originalId && this.getMessage(p.meta.originalId);
      if (original) this.onDelivered(original);
    } catch (err) {
      this.setMessage(t.id, { status: 'retrying', error: this.logger.mask(err?.message || String(err)) });
      if (!err?.retryable) throw new PermanentError(err?.message || String(err));
      throw err;
    }
  }

  /** The owner has been told about this issue (directly or via the template). */
  onDelivered(m) {
    const p = JSON.parse(m.payload);
    if (m.kind === 'alert' && m.issue_id) {
      this.issues.transition(m.issue_id, 'alerted', { from: ['new'], reason: 'Owner alerted on WhatsApp', event: 'alerted' });
    } else if (m.kind === 'bundle') {
      for (const id of p.meta?.issueIds || []) this.issues.transition(id, 'alerted', { from: ['new'], reason: 'Included in a bundled WhatsApp summary', event: 'alerted' });
    }
  }

  /** Called by the queue when a send failed for good. */
  markFailed(messageId, err) {
    const m = this.getMessage(messageId);
    if (!m) return;
    const reason = this.logger.mask(err?.message || String(err));
    this.setMessage(m.id, { status: 'failed', error: reason });
    let target = m;
    if (m.kind === 'template') {
      const orig = JSON.parse(m.payload).meta?.originalId;
      if (orig) {
        this.setMessage(orig, { status: 'failed', error: `template fallback failed: ${reason}` });
        target = this.getMessage(orig) || m;
      }
    }
    this.logger.error(`WhatsApp message #${m.id} (${m.kind}) could not be delivered: ${reason}`);
    if (target.issue_id) this.issues.addEvent(target.issue_id, 'notify_failed', { kind: target.kind, error: reason });
  }

  /** Sends an alert for a new issue, or bundles it if the hourly limit is reached. */
  alertIssue(issue) {
    const dedupeKey = `alert:${issue.id}:${issue.cycle}`;
    if (this.db.prepare('SELECT 1 FROM messages WHERE dedupe_key = ?').get(dedupeKey)) return { duplicate: true };
    if (issue.alert_bundled) return { bundled: true };
    const since = this.iso(this.clock.now() - HOUR);
    const recent = this.db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM messages WHERE direction = 'out' AND kind = 'alert' AND created_at >= ?").get(since);
    if (recent.n >= this.wa.maxAlertsPerHour) {
      this.issues.update(issue.id, { alert_bundled: 1 });
      this.issues.addEvent(issue.id, 'alert_bundled', { reason: `More than ${this.wa.maxAlertsPerHour} alerts in the last hour; will be included in a summary` });
      if (!this.queue.active('wa_bundle').length) {
        const runAt = Date.parse(recent.oldest) + HOUR;
        this.queue.enqueue('wa_bundle', {}, { runAt });
      }
      return { bundled: true };
    }
    return this.send({ kind: 'alert', issueId: issue.id, message: msgs.alert(issue, this.config), dedupeKey });
  }

  /** Job: one summary message for every issue held back by the hourly limit. */
  sendBundle() {
    const pending = this.db.prepare("SELECT * FROM issues WHERE alert_bundled = 1 AND status = 'new' ORDER BY id").all();
    if (!pending.length) return;
    const ids = pending.map((i) => i.id);
    this.db.prepare(`UPDATE issues SET alert_bundled = 2 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    this.send({ kind: 'bundle', message: msgs.bundle(pending, { maxPerHour: this.wa.maxAlertsPerHour }), meta: { issueIds: ids }, dedupeKey: `bundle:${ids.join(',')}` });
  }

  /** Verifies and processes a raw webhook POST. Returns the HTTP status to answer with. */
  async processWebhook(rawBody, signature) {
    if (!this.provider.verifySignature(rawBody, signature)) {
      this.logger.warn('rejected WhatsApp webhook with a missing or invalid signature');
      return 401;
    }
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return 400;
    }
    const { messages, statuses } = this.provider.parseWebhook(body);
    for (const s of statuses) {
      try {
        this.handleStatus(s);
      } catch (err) {
        this.logger.error('failed to process WhatsApp status update', err);
      }
    }
    for (const m of messages) {
      try {
        await this.handleInbound(m);
      } catch (err) {
        this.logger.error('failed to process inbound WhatsApp message', err);
      }
    }
    return 200;
  }

  handleStatus(s) {
    const m = this.db.prepare("SELECT * FROM messages WHERE provider_message_id = ? AND direction = 'out'").get(s.id);
    if (!m) return;
    if (s.status === 'failed') {
      const windowClosed = s.errors.some((e) => Number(e.code) === WINDOW_CLOSED);
      if (windowClosed && m.kind !== 'template' && m.status === 'sent') {
        this.fallbackToTemplate(m);
      } else if (m.status !== 'failed') {
        const reason = s.errors.map((e) => `${e.code}: ${e.title}`).join('; ') || 'delivery failed';
        this.markFailed(m.id, new Error(`WhatsApp reported delivery failure (${reason})`));
      }
    } else if ((s.status === 'delivered' || s.status === 'read') && ['sent', 'delivered'].includes(m.status)) {
      this.setMessage(m.id, { status: s.status });
    }
  }

  async handleInbound(msg) {
    const from = String(msg.from || '').replace(/\D/g, '');
    const fromOwner = !!this.owner && from === this.owner;
    const id = this.insertMessage({
      direction: 'in',
      kind: 'inbound',
      dedupeKey: `in:${msg.id}`,
      payload: { text: msg.text ?? null, buttonId: msg.buttonId ?? null, from: fromOwner ? 'owner' : this.logger.mask(from) },
      status: fromOwner ? 'received' : 'ignored',
    });
    if (!id) return { duplicate: true }; // Meta re-delivered the same webhook
    if (!fromOwner) {
      this.logger.warn(`ignored WhatsApp message from unknown sender ${this.logger.mask(from)}`);
      return { ignored: true };
    }
    this.db.kvSet('owner_last_inbound_at', this.iso());
    const resent = this.resendAwaiting();
    const cmd = parseCommand(msg.buttonId || msg.text);
    // A "hi" that reopened the window is answered by the resent messages themselves.
    if (resent > 0 && (cmd.action === 'unknown' || cmd.action === 'help')) return { resent };

    let reply;
    try {
      reply = this.commandHandler ? await this.commandHandler(cmd, msg) : msgs.help();
    } catch (err) {
      this.logger.error(`command "${cmd.action}" failed`, err);
      reply = { text: `⚠️ Something went wrong handling "${msgs.short(cmd.raw, 40)}": ${this.logger.mask(err?.message || String(err))}`, summary: 'Command failed' };
    }
    if (reply) this.send({ kind: 'reply', issueId: cmd.id ?? null, message: reply, dedupeKey: `reply:${msg.id}` });
    return { command: cmd, resent };
  }

  /** The owner wrote to us, so the window is open: resend what the template stood in for. */
  resendAwaiting() {
    const rows = this.db.prepare("SELECT * FROM messages WHERE direction = 'out' AND status = 'awaiting_window' ORDER BY id").all();
    for (const m of rows) {
      const p = JSON.parse(m.payload);
      this.setMessage(m.id, { status: 'resent' });
      this.send({ kind: m.kind, issueId: m.issue_id, message: p, meta: p.meta || {}, dedupeKey: `resend:${m.id}` });
    }
    return rows.length;
  }

  ownerLastInboundAt() {
    return this.db.kvGet('owner_last_inbound_at');
  }

  /** Messages with problems, for the dashboard banner. */
  failures(limit = 20) {
    return this.db.prepare("SELECT * FROM messages WHERE direction = 'out' AND status IN ('failed','awaiting_window') ORDER BY id DESC LIMIT ?").all(limit);
  }

  forIssue(issueId) {
    return this.db.prepare('SELECT * FROM messages WHERE issue_id = ? ORDER BY id').all(issueId);
  }

  recent(limit = 100) {
    return this.db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?').all(limit).reverse();
  }
}

module.exports = { Notifier };
