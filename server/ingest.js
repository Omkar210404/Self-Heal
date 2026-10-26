'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { RateLimiter } = require('./ratelimit');
const { normalizeReport } = require('./issues');

const MAX_ERRORS_PER_REQUEST = 50;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * POST /api/errors
 * Body (JSON, sent as text/plain by the snippet to avoid a CORS preflight): { errors: [report, ...] }
 * Key: ?key=, X-Selfheal-Key header, or body.key.
 */
function createIngestRouter({ config, issues, onIssue, logger, clock }) {
  const router = express.Router();
  const limiter = new RateLimiter({ limit: config.ingestRatePerMin, windowMs: 60_000, clock });
  const allowAll = config.allowedOrigins.includes('*');

  const cors = (req, res, next) => {
    const origin = req.get('origin');
    if (origin && (allowAll || config.allowedOrigins.includes(origin))) {
      res.set('Access-Control-Allow-Origin', allowAll ? '*' : origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, X-Selfheal-Key');
      res.set('Access-Control-Max-Age', '86400');
    }
    next();
  };

  router.options('/api/errors', cors, (req, res) => res.sendStatus(204));

  router.post(
    '/api/errors',
    cors,
    limiter.middleware(),
    express.text({ type: () => true, limit: `${config.ingestMaxBodyKb}kb` }),
    (req, res) => {
      const origin = req.get('origin');
      if (origin && !allowAll && !config.allowedOrigins.includes(origin)) {
        return res.status(403).json({ error: 'Origin not allowed' });
      }
      let body;
      try {
        body = typeof req.body === 'string' && req.body.length ? JSON.parse(req.body) : {};
      } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
      }
      const key = req.query.key || req.get('x-selfheal-key') || body.key;
      if (!key || !config.projectKey || !safeEqual(key, config.projectKey)) {
        return res.status(401).json({ error: 'Invalid project key' });
      }
      const list = Array.isArray(body.errors) ? body.errors : body && (body.message || body.stack) ? [body] : [];
      if (!list.length) return res.status(400).json({ error: 'No errors in body' });
      if (list.length > MAX_ERRORS_PER_REQUEST) return res.status(413).json({ error: `At most ${MAX_ERRORS_PER_REQUEST} errors per request` });

      let accepted = 0;
      const ids = new Set();
      for (const raw of list) {
        const report = normalizeReport(raw);
        if (!report) continue;
        try {
          const result = issues.ingest(report);
          accepted++;
          ids.add(result.issue.id);
          if (result.isNew || result.reopened) {
            Promise.resolve()
              .then(() => onIssue?.(result.issue, result))
              .catch((err) => logger.error(`alerting for issue #${result.issue.id} failed`, err));
          }
        } catch (err) {
          logger.error('failed to store error report', err);
        }
      }
      res.status(202).json({ accepted, issues: [...ids] });
    }
  );

  return router;
}

module.exports = { createIngestRouter, safeEqual };
