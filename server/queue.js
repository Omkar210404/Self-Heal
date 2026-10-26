'use strict';
/*
 * Small SQLite-backed job queue.
 * - Jobs are rows, so they survive restarts; jobs that were "running" when the
 *   process died are put back in the queue on start().
 * - Each lane runs one job at a time, so a long AI fix never blocks WhatsApp sends.
 * - A handler can throw (retry with exponential backoff up to max_attempts) or
 *   return { defer: msTimestamp } to run again later without using an attempt.
 * - When a job fails for good, the type's onFail hook runs so nothing is left silently stuck.
 */

class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentError';
    this.permanent = true;
  }
}

class JobQueue {
  constructor({ db, logger, clock = { now: () => Date.now() }, pollMs = 500, backoffMs = 2000 }) {
    this.db = db;
    this.logger = logger;
    this.clock = clock;
    this.pollMs = pollMs;
    this.backoffMs = backoffMs;
    this.types = new Map();
    this.lanes = new Map(); // lane -> { timer, busy: Promise|null }
    this.running = false;
  }

  /**
   * @param {string} type
   * @param {(payload: any, job: object) => Promise<any>} handler
   * @param {{lane?: string, maxAttempts?: number, onFail?: (payload: any, err: Error, job: object) => Promise<void>|void}} [opts]
   */
  register(type, handler, opts = {}) {
    this.types.set(type, { handler, lane: opts.lane || 'default', maxAttempts: opts.maxAttempts ?? 3, onFail: opts.onFail });
  }

  iso() {
    return new Date(this.clock.now()).toISOString();
  }

  /**
   * Adds a job. With a dedupeKey, a second enqueue with the same key is ignored
   * (returns the existing job) — this is how duplicate alerts are prevented.
   */
  enqueue(type, payload = {}, { runAt, dedupeKey, maxAttempts } = {}) {
    const t = this.types.get(type);
    if (!t) throw new Error(`Unknown job type: ${type}`);
    const now = this.iso();
    const info = this.db
      .prepare(
        `INSERT INTO jobs (type, lane, payload, status, attempts, max_attempts, run_at, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`
      )
      .run(type, t.lane, JSON.stringify(payload), maxAttempts ?? t.maxAttempts, runAt ?? this.clock.now(), dedupeKey ?? null, now, now);
    if (info.changes === 0) {
      return { job: this.db.prepare('SELECT * FROM jobs WHERE dedupe_key = ?').get(dedupeKey), created: false };
    }
    this.kick(t.lane);
    return { job: this.get(Number(info.lastInsertRowid)), created: true };
  }

  get(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) || null;
  }

  /** Jobs that are queued or running for a type (optionally matching a payload field). */
  active(type, match = {}) {
    return this.db
      .prepare("SELECT * FROM jobs WHERE type = ? AND status IN ('queued','running')")
      .all(type)
      .filter((j) => {
        const p = JSON.parse(j.payload);
        return Object.entries(match).every(([k, v]) => p[k] === v);
      });
  }

  list({ limit = 100 } = {}) {
    return this.db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit);
  }

  /** Puts jobs left "running" by a crash back in the queue, then starts polling. */
  start() {
    const n = this.db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(this.iso()).changes;
    if (n) this.logger?.warn(`queue: resumed ${n} job(s) interrupted by a restart`);
    this.running = true;
    const lanes = new Set([...this.types.values()].map((t) => t.lane));
    for (const lane of lanes) this.kick(lane);
  }

  async stop() {
    this.running = false;
    const busy = [];
    for (const l of this.lanes.values()) {
      clearTimeout(l.timer);
      if (l.busy) busy.push(l.busy);
    }
    await Promise.allSettled(busy);
  }

  kick(lane) {
    if (!this.running) return;
    const l = this.lanes.get(lane) || { timer: null, busy: null };
    this.lanes.set(lane, l);
    if (l.busy) return;
    clearTimeout(l.timer);
    l.timer = setTimeout(() => this.tick(lane), 0);
  }

  async tick(lane) {
    const l = this.lanes.get(lane);
    if (!this.running || !l || l.busy) return;
    l.busy = (async () => {
      try {
        while (this.running && (await this.runOne(lane))) {
          /* keep draining */
        }
      } catch (err) {
        this.logger?.error(`queue lane ${lane} crashed`, err);
      }
    })();
    await l.busy;
    l.busy = null;
    if (this.running) l.timer = setTimeout(() => this.tick(lane), this.pollMs);
  }

  claim(lane) {
    const now = this.clock.now();
    return (
      this.db
        .prepare(
          `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
           WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND lane = ? AND run_at <= ? ORDER BY run_at, id LIMIT 1)
           RETURNING *`
        )
        .get(this.iso(), lane, now) || null
    );
  }

  /** Runs one ready job in a lane. Returns true if a job was run. */
  async runOne(lane) {
    const job = this.claim(lane);
    if (!job) return false;
    const t = this.types.get(job.type);
    const payload = JSON.parse(job.payload);
    if (!t) {
      this.finish(job.id, 'failed', `No handler for job type ${job.type}`);
      return true;
    }
    try {
      const result = await t.handler(payload, job);
      if (result && typeof result.defer === 'number') {
        this.db
          .prepare("UPDATE jobs SET status = 'queued', attempts = attempts - 1, run_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
          .run(result.defer, result.reason || 'deferred', this.iso(), job.id);
      } else {
        this.finish(job.id, 'done', null);
      }
    } catch (err) {
      const msg = this.logger ? this.logger.mask(err?.message || String(err)) : String(err?.message || err);
      const final = err?.permanent || job.attempts >= job.max_attempts;
      if (!final) {
        const delay = this.backoffMs * 2 ** (job.attempts - 1);
        this.db
          .prepare("UPDATE jobs SET status = 'queued', run_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
          .run(this.clock.now() + delay, msg, this.iso(), job.id);
        this.logger?.warn(`job ${job.type}#${job.id} failed (attempt ${job.attempts}/${job.max_attempts}), retrying in ${delay}ms: ${msg}`);
      } else {
        this.finish(job.id, 'failed', msg);
        this.logger?.error(`job ${job.type}#${job.id} failed permanently: ${msg}`);
        if (t.onFail) {
          try {
            await t.onFail(payload, err, job);
          } catch (hookErr) {
            this.logger?.error(`onFail hook for ${job.type}#${job.id} failed`, hookErr);
          }
        }
      }
    }
    return true;
  }

  finish(id, status, error) {
    this.db.prepare('UPDATE jobs SET status = ?, last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?').run(status, error, this.iso(), this.iso(), id);
  }

  /**
   * Test helper: runs every job that is ready now (across all lanes) until none are left.
   * Jobs scheduled in the future are not run unless the clock is advanced.
   */
  async drain({ maxJobs = 1000 } = {}) {
    let n = 0;
    const lanes = [...new Set([...this.types.values()].map((t) => t.lane))];
    let progressed = true;
    while (progressed && n < maxJobs) {
      progressed = false;
      for (const lane of lanes) {
        if (await this.runOne(lane)) {
          progressed = true;
          n++;
        }
      }
    }
    return n;
  }
}

module.exports = { JobQueue, PermanentError };
