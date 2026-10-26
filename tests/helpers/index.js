'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { openDb } = require('../../server/db');
const { createLogger } = require('../../server/logger');

/** Owner ids for tests are generated, never typed: no phone-like literals in the repo. */
const FAKE_OWNER = String(10 ** 13 + 1);
const FAKE_STRANGER = String(10 ** 13 + 2);

function tmpDir(prefix = 'selfheal-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows can hold files briefly; temp dirs are cleaned by the OS eventually */
  }
}

function memDb() {
  return openDb(':memory:');
}

/** Logger that keeps lines in memory (already masked) instead of printing. */
function memLogger(secrets = []) {
  const lines = [];
  const logger = createLogger({ level: 'debug', secrets, sink: (line) => lines.push(line) });
  logger.lines = lines;
  return logger;
}

function fakeClock(start = Date.parse('2026-01-15T10:00:00Z')) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; },
    set(ms) { t = ms; },
  };
}

/** Starts an express app (or node handler) on a random port. */
async function listen(app) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** A minimal fetch Response stand-in for stubbing provider HTTP calls. */
function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Records fetch calls and replies with queued responses (or a function). */
function stubFetch(...responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? safeJson(init.body) : undefined });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (typeof next === 'function') return next(String(url), init, calls.length);
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

module.exports = { FAKE_OWNER, FAKE_STRANGER, tmpDir, rmrf, memDb, memLogger, fakeClock, listen, jsonResponse, stubFetch };
