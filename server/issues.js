'use strict';
const crypto = require('node:crypto');

const STATUSES = ['new', 'alerted', 'approved', 'fixing', 'fix_ready', 'merged', 'rejected', 'ignored', 'fix_failed', 'rolled_back'];

// Allowed status changes. Anything else is refused.
const TRANSITIONS = {
  new: ['alerted', 'approved', 'ignored'],
  alerted: ['approved', 'ignored'],
  approved: ['fixing', 'fix_failed'],
  fixing: ['fix_ready', 'fix_failed', 'approved'],
  fix_ready: ['merged', 'rejected', 'fix_failed'],
  merged: ['rolled_back', 'new'],
  rejected: ['approved'],
  ignored: ['approved'],
  fix_failed: ['approved'],
  rolled_back: ['approved'],
};

const KINDS = new Set(['error', 'unhandledrejection', 'http', 'resource']);
const MAX_OCCURRENCES = 20;
const REOPEN_GRACE_MS = 30 * 60 * 1000;

const s = (v, n) => (v === undefined || v === null ? '' : String(v)).slice(0, n);
const intOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.trunc(Number(v)) : null);

/** Path part of a URL without origin, query or hash. */
function urlPath(u) {
  if (!u) return '';
  try {
    return new URL(u, 'http://x.invalid').pathname;
  } catch {
    return String(u).split(/[?#]/)[0];
  }
}

const SNIPPET_FILE = /selfheal(\.min)?\.js$/;

/** Parses Chrome/Edge ("at fn (url:1:2)") and Firefox/Safari ("fn@url:1:2") stack traces. */
function parseStack(stack) {
  const frames = [];
  for (const raw of String(stack || '').split('\n')) {
    const line = raw.trim();
    let m = line.match(/^at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/);
    if (!m) {
      const f = line.match(/^(.*?)@(.+?):(\d+):(\d+)$/);
      if (f) m = [f[0], f[1], f[2], f[3], f[4]];
    }
    if (!m) continue;
    const url = m[2].replace(/^async /, '');
    if (!/[/\\.]/.test(url) || url.startsWith('native') || url.startsWith('<anonymous>')) continue;
    if (SNIPPET_FILE.test(urlPath(url))) continue; // our own fetch/XHR wrapper
    frames.push({ fn: m[1] || '', url, path: urlPath(url), line: Number(m[3]), col: Number(m[4]) });
  }
  return frames;
}

/** Strips variable parts (ids, numbers, hashes) so similar errors group together. */
function normalizeMessage(msg) {
  return String(msg || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function normalizePath(p) {
  return urlPath(p)
    .replace(/\.[0-9a-f]{6,}\./gi, '.[hash].') // app.3f2a1b9c.js -> app.[hash].js
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}(?=\/|$)/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

/** Validates and trims one raw report from the snippet. Returns null if unusable. */
function normalizeReport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = KINDS.has(raw.type) ? raw.type : 'error';
  const r = {
    kind,
    name: s(raw.name, 100),
    message: s(raw.message, 1000),
    stack: s(raw.stack, 8000),
    source: s(raw.source, 2000),
    line: intOrNull(raw.line),
    col: intOrNull(raw.col),
    pageUrl: s(raw.url, 2000).split(/[?#]/)[0],
    userAgent: s(raw.userAgent, 400),
    timestamp: s(raw.timestamp, 40),
    release: s(raw.release, 100),
    method: s(raw.method, 10).toUpperCase(),
    status: intOrNull(raw.status),
    requestUrl: s(raw.requestUrl, 2000).split(/[?#]/)[0],
    tag: s(raw.tag, 20),
  };
  if (!r.message && !r.stack) return null;

  const frames = parseStack(r.stack);
  if (kind === 'error' || kind === 'unhandledrejection') {
    r.file = normalizePath(r.source) || (frames[0] ? normalizePath(frames[0].path) : '');
    if (r.line == null && frames[0]) {
      r.line = frames[0].line;
      r.col = frames[0].col;
    }
    const prefix = r.name && !r.message.startsWith(r.name) ? `${r.name}: ` : '';
    r.title = `${prefix}${r.message}`.slice(0, 300);
    r.fingerprintParts = [kind, r.name, normalizeMessage(r.message), r.file, r.line ?? ''];
  } else if (kind === 'http') {
    r.file = frames[0] ? normalizePath(frames[0].path) : '';
    r.line = frames[0]?.line ?? null;
    r.col = frames[0]?.col ?? null;
    r.title = r.message.slice(0, 300);
    r.fingerprintParts = [kind, r.method, normalizePath(r.requestUrl), r.status ?? ''];
  } else {
    r.file = normalizePath(r.source);
    r.title = r.message.slice(0, 300);
    r.fingerprintParts = [kind, r.tag, normalizePath(r.source)];
  }
  r.fingerprint = crypto.createHash('sha256').update(r.fingerprintParts.join('|')).digest('hex').slice(0, 32);
  return r;
}

class IssueService {
  constructor({ db, clock = { now: () => Date.now() }, logger }) {
    this.db = db;
    this.clock = clock;
    this.logger = logger;
    this.listeners = [];
  }

  iso() {
    return new Date(this.clock.now()).toISOString();
  }

  /** Called after every status change: fn(issue, from, to). */
  onTransition(fn) {
    this.listeners.push(fn);
  }

  /**
   * Groups a normalized report into an issue.
   * @returns {{issue: object, isNew: boolean, reopened: boolean}}
   */
  ingest(report) {
    const now = this.iso();
    return this.db.tx(() => {
      const existing = this.db.prepare('SELECT * FROM issues WHERE fingerprint = ?').get(report.fingerprint);
      let issue;
      let isNew = false;
      let reopened = false;
      if (existing) {
        this.db
          .prepare(
            `UPDATE issues SET count = count + 1, last_seen = ?, stack = COALESCE(NULLIF(?, ''), stack), page_url = ?, user_agent = ?,
             release = COALESCE(NULLIF(?, ''), release), updated_at = ? WHERE id = ?`
          )
          .run(now, report.stack, report.pageUrl, report.userAgent, report.release, now, existing.id);
        issue = this.get(existing.id);
        // An error that comes back well after its fix was merged means the fix did not work: start a new cycle.
        const mergedAgo = this.clock.now() - Date.parse(this.lastStatusChange(existing.id) || existing.updated_at);
        if (existing.status === 'merged' && mergedAgo > REOPEN_GRACE_MS) {
          this.db.prepare('UPDATE issues SET cycle = cycle + 1, alert_bundled = 0 WHERE id = ?').run(existing.id);
          this.transition(existing.id, 'new', { reason: 'Error happened again after the fix was merged', event: 'recurred' });
          issue = this.get(existing.id);
          reopened = true;
        }
      } else {
        const info = this.db
          .prepare(
            `INSERT INTO issues (fingerprint, kind, title, message, file, line, col, stack, page_url, user_agent, release,
             first_seen, last_seen, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`
          )
          .run(
            report.fingerprint, report.kind, report.title, report.message, report.file, report.line, report.col,
            report.stack, report.pageUrl, report.userAgent, report.release, now, now, now, now
          );
        issue = this.get(Number(info.lastInsertRowid));
        this.addEvent(issue.id, 'created', { title: issue.title });
        isNew = true;
      }
      const occ = { ...report };
      delete occ.fingerprintParts;
      this.db.prepare('INSERT INTO occurrences (issue_id, data, created_at) VALUES (?, ?, ?)').run(issue.id, JSON.stringify(occ), now);
      this.db
        .prepare('DELETE FROM occurrences WHERE issue_id = ? AND id NOT IN (SELECT id FROM occurrences WHERE issue_id = ? ORDER BY id DESC LIMIT ?)')
        .run(issue.id, issue.id, MAX_OCCURRENCES);
      return { issue, isNew, reopened };
    });
  }

  get(id) {
    return this.db.prepare('SELECT * FROM issues WHERE id = ?').get(Number(id)) || null;
  }

  list({ status, limit = 100, offset = 0 } = {}) {
    if (status) return this.db.prepare('SELECT * FROM issues WHERE status = ? ORDER BY last_seen DESC LIMIT ? OFFSET ?').all(status, limit, offset);
    return this.db.prepare('SELECT * FROM issues ORDER BY last_seen DESC LIMIT ? OFFSET ?').all(limit, offset);
  }

  counts() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM issues GROUP BY status').all();
    const out = Object.fromEntries(STATUSES.map((st) => [st, 0]));
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  events(id) {
    return this.db.prepare('SELECT * FROM events WHERE issue_id = ? ORDER BY id').all(Number(id));
  }

  occurrences(id) {
    return this.db.prepare('SELECT * FROM occurrences WHERE issue_id = ? ORDER BY id DESC').all(Number(id)).map((o) => ({ ...o, data: JSON.parse(o.data) }));
  }

  lastStatusChange(id) {
    return this.db.prepare("SELECT created_at FROM events WHERE issue_id = ? AND to_status IS NOT NULL ORDER BY id DESC LIMIT 1").get(id)?.created_at || null;
  }

  addEvent(issueId, type, detail, { from = null, to = null } = {}) {
    const d = detail === undefined || detail === null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail);
    this.db.prepare('INSERT INTO events (issue_id, type, from_status, to_status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(issueId, type, from, to, d, this.iso());
  }

  canTransition(from, to) {
    return (TRANSITIONS[from] || []).includes(to);
  }

  /**
   * Atomically moves an issue to a new status and logs it.
   * @param {number} id
   * @param {string} to
   * @param {{reason?: string, from?: string[], event?: string, detail?: any}} [opts] `from` restricts the allowed current statuses.
   * @returns {{ok: boolean, issue: object|null, from?: string, error?: string}}
   */
  transition(id, to, opts = {}) {
    if (!STATUSES.includes(to)) throw new Error(`Unknown status: ${to}`);
    const res = this.db.tx(() => {
      const cur = this.get(id);
      if (!cur) return { ok: false, issue: null, error: `Issue #${id} not found` };
      if (opts.from && !opts.from.includes(cur.status)) {
        return { ok: false, issue: cur, error: `Issue #${id} is ${cur.status}` };
      }
      if (!this.canTransition(cur.status, to)) {
        return { ok: false, issue: cur, error: `Issue #${id} cannot go from ${cur.status} to ${to}` };
      }
      const now = this.iso();
      const info = this.db
        .prepare('UPDATE issues SET status = ?, status_reason = ?, updated_at = ? WHERE id = ? AND status = ?')
        .run(to, opts.reason ?? null, now, cur.id, cur.status);
      if (info.changes !== 1) return { ok: false, issue: this.get(id), error: 'Concurrent update' };
      this.addEvent(cur.id, opts.event || 'status', opts.detail ?? (opts.reason ? { reason: opts.reason } : null), { from: cur.status, to });
      return { ok: true, issue: this.get(id), from: cur.status };
    });
    if (res.ok) {
      this.logger?.info(`issue #${id} ${res.from} -> ${to}${opts.reason ? ` (${opts.reason})` : ''}`);
      for (const fn of this.listeners) {
        try {
          fn(res.issue, res.from, to);
        } catch (err) {
          this.logger?.error('transition listener failed', err);
        }
      }
    }
    return res;
  }

  /** Updates non-status columns. */
  update(id, fields) {
    const allowed = [
      'root_cause', 'explanation', 'ai_provider', 'attempts', 'branch', 'base_branch', 'pr_number', 'pr_url', 'merge_sha',
      'revert_pr_number', 'revert_pr_url', 'tested', 'test_summary', 'files_changed', 'fix_runs', 'alert_bundled', 'status_reason',
    ];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return this.get(id);
    const sql = `UPDATE issues SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => (fields[k] !== null && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k] ?? null)), this.iso(), Number(id));
    return this.get(id);
  }
}

module.exports = { IssueService, normalizeReport, parseStack, normalizeMessage, normalizePath, urlPath, STATUSES, TRANSITIONS };
