'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createIngestRouter } = require('../../server/ingest');
const { IssueService } = require('../../server/issues');
const { RateLimiter } = require('../../server/ratelimit');
const { loadConfig } = require('../../server/config');
const { memDb, memLogger, fakeClock, listen } = require('../helpers');

const KEY = 'test-project-key-0123456789';

async function setup(env = {}) {
  const config = loadConfig({ PROJECT_KEY: KEY, ...env });
  const logger = memLogger();
  const issues = new IssueService({ db: memDb(), logger });
  const alerted = [];
  const app = express();
  app.use(createIngestRouter({ config, issues, logger, onIssue: (i) => alerted.push(i.id) }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.type || 'error' }));
  const srv = await listen(app);
  return { ...srv, issues, alerted };
}

const body = (errors) => JSON.stringify({ errors });
const err = (msg = 'boom', line = 1) => ({ type: 'error', name: 'Error', message: msg, source: 'https://s.example/a.js', line, url: 'https://s.example/' });

test('accepts text/plain JSON from the snippet with ?key=', async (t) => {
  const s = await setup();
  t.after(s.close);
  const r = await fetch(`${s.url}/api/errors?key=${KEY}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body([err(), err(), err('other')]) });
  assert.equal(r.status, 202);
  const j = await r.json();
  assert.equal(j.accepted, 3);
  assert.equal(j.issues.length, 2);
  await new Promise((r2) => setImmediate(r2));
  assert.equal(s.alerted.length, 2, 'only new issues trigger an alert');
});

test('accepts the key as a header and a single error object', async (t) => {
  const s = await setup();
  t.after(s.close);
  const r = await fetch(`${s.url}/api/errors`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Selfheal-Key': KEY }, body: JSON.stringify(err()) });
  assert.equal(r.status, 202);
});

test('rejects a missing or wrong key', async (t) => {
  const s = await setup();
  t.after(s.close);
  assert.equal((await fetch(`${s.url}/api/errors`, { method: 'POST', body: body([err()]) })).status, 401);
  assert.equal((await fetch(`${s.url}/api/errors?key=wrong`, { method: 'POST', body: body([err()]) })).status, 401);
  assert.equal(s.issues.list().length, 0);
});

test('rejects bad JSON, empty batches and too many errors', async (t) => {
  const s = await setup();
  t.after(s.close);
  const post = (b) => fetch(`${s.url}/api/errors?key=${KEY}`, { method: 'POST', body: b });
  assert.equal((await post('{nope')).status, 400);
  assert.equal((await post(body([]))).status, 400);
  assert.equal((await post(body(Array.from({ length: 51 }, () => err())))).status, 413);
});

test('enforces the body size limit', async (t) => {
  const s = await setup({ INGEST_MAX_BODY_KB: '1' });
  t.after(s.close);
  const r = await fetch(`${s.url}/api/errors?key=${KEY}`, { method: 'POST', body: body([err('x'.repeat(4000))]) });
  assert.equal(r.status, 413);
});

test('rate limits per IP', async (t) => {
  const s = await setup({ INGEST_RATE_LIMIT_PER_MIN: '3' });
  t.after(s.close);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(`${s.url}/api/errors?key=${KEY}`, { method: 'POST', body: body([err()]) })).status);
  assert.deepEqual(codes, [202, 202, 202, 429, 429]);
});

test('CORS: allowed origins get headers, others are refused', async (t) => {
  const s = await setup({ ALLOWED_ORIGINS: 'https://good.example' });
  t.after(s.close);
  const pre = await fetch(`${s.url}/api/errors`, { method: 'OPTIONS', headers: { Origin: 'https://good.example' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://good.example');
  const bad = await fetch(`${s.url}/api/errors?key=${KEY}`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: body([err()]) });
  assert.equal(bad.status, 403);
});

test('RateLimiter windows reset and prune', () => {
  const clock = fakeClock();
  const rl = new RateLimiter({ limit: 2, windowMs: 1000, clock, maxKeys: 4 });
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('a').allowed, true);
  const third = rl.take('a');
  assert.equal(third.allowed, false);
  assert.equal(third.retryAfterMs, 1000);
  clock.advance(1000);
  assert.equal(rl.take('a').allowed, true);
  for (let i = 0; i < 10; i++) rl.take('k' + i);
  assert.ok(rl.hits.size <= 4);
});
