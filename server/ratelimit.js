'use strict';

/** Fixed-window in-memory rate limiter keyed by any string (usually the client IP). */
class RateLimiter {
  constructor({ limit, windowMs = 60_000, clock = { now: () => Date.now() }, maxKeys = 10_000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  /** @returns {{allowed: boolean, remaining: number, retryAfterMs: number}} */
  take(key) {
    const now = this.clock.now();
    let e = this.hits.get(key);
    if (!e || now - e.start >= this.windowMs) {
      if (this.hits.size >= this.maxKeys) this.prune(now);
      e = { start: now, count: 0 };
      this.hits.set(key, e);
    }
    e.count++;
    const allowed = e.count <= this.limit;
    return { allowed, remaining: Math.max(0, this.limit - e.count), retryAfterMs: allowed ? 0 : e.start + this.windowMs - now };
  }

  prune(now) {
    for (const [k, e] of this.hits) if (now - e.start >= this.windowMs) this.hits.delete(k);
    // Still too many keys (attack): drop the oldest half.
    if (this.hits.size >= this.maxKeys) {
      const keys = [...this.hits.keys()].slice(0, Math.floor(this.maxKeys / 2));
      for (const k of keys) this.hits.delete(k);
    }
  }

  /** Express middleware. */
  middleware(keyFn = (req) => req.ip || 'unknown') {
    return (req, res, next) => {
      const r = this.take(keyFn(req));
      if (r.allowed) return next();
      res.set('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
      res.status(429).json({ error: 'Too many requests' });
    };
  }
}

module.exports = { RateLimiter };
