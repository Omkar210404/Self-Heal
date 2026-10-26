'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBrowser } = require('../helpers/fake-browser');

const SRC = fs.readFileSync(path.join(__dirname, '../../snippet/src/selfheal.js'), 'utf8');
const DIST_PATH = path.join(__dirname, '../../snippet/dist/selfheal.min.js');
const DIST = fs.readFileSync(DIST_PATH, 'utf8');
const DATA = { endpoint: 'https://errors.example/api/errors', key: 'test-key', release: '1.2.3' };

test('minified snippet is under 5 KB', () => {
  assert.ok(fs.statSync(DIST_PATH).size < 5 * 1024);
});

for (const [label, code] of [['source', SRC], ['minified', DIST]]) {
  test.describe(`snippet (${label})`, () => {
    test('does nothing without endpoint and key', () => {
      const b = createBrowser({ dataset: {} });
      const originalFetch = b.win.fetch;
      b.load(code);
      assert.equal(b.win.fetch, originalFetch);
      assert.equal(b.win.__selfheal, undefined);
    });

    test('reads config from window.SelfHealConfig', async () => {
      const b = createBrowser({ config: { endpoint: '/api/errors', key: 'test-k' } });
      b.load(code);
      b.dispatch('error', { error: new Error('x'), message: 'x', filename: 'https://shop.example/a.js', lineno: 1, colno: 1 });
      b.runTimers();
      assert.equal(b.beacons.length, 1);
      assert.equal(b.beacons[0].url, 'https://shop.example/api/errors?key=test-k');
    });

    test('captures uncaught errors with full metadata', async () => {
      const b = createBrowser({ dataset: DATA });
      b.load(code);
      const err = new TypeError("Cannot read properties of undefined (reading 'x')");
      b.dispatch('error', { error: err, message: err.message, filename: 'https://shop.example/app.js?v=3', lineno: 10, colno: 5, target: b.win });
      b.runTimers();
      const [e] = await b.sent();
      assert.equal(e.type, 'error');
      assert.equal(e.name, 'TypeError');
      assert.match(e.message, /reading 'x'/);
      assert.ok(e.stack.includes('TypeError'));
      assert.equal(e.source, 'https://shop.example/app.js');
      assert.equal(e.line, 10);
      assert.equal(e.url, 'https://shop.example/checkout', 'query string and hash are stripped');
      assert.equal(e.userAgent, 'FakeBrowser/1.0');
      assert.equal(e.release, '1.2.3');
      assert.ok(!Number.isNaN(Date.parse(e.timestamp)));
      assert.equal(b.beacons[0].url, 'https://errors.example/api/errors?key=test-key');
      assert.equal(b.beacons[0].data.type, 'text/plain', 'text/plain avoids a CORS preflight');
    });

    test('ignores extension errors and opaque cross-origin "Script error."', () => {
      const b = createBrowser({ dataset: DATA });
      b.load(code);
      b.dispatch('error', { message: 'boom', filename: 'chrome-extension://abc/x.js' });
      b.dispatch('error', { message: 'Script error.', filename: '' });
      b.runTimers();
      assert.equal(b.beacons.length, 0);
    });

    test('captures unhandled promise rejections (Error and non-Error reasons)', async () => {
      const b = createBrowser({ dataset: DATA });
      b.load(code);
      b.dispatch('unhandledrejection', { reason: new Error('async fail') });
      b.dispatch('unhandledrejection', { reason: { code: 42 } });
      b.dispatch('unhandledrejection', { reason: undefined });
      b.runTimers();
      const sent = await b.sent();
      assert.equal(sent.length, 3);
      assert.equal(sent[0].message, 'async fail');
      assert.equal(sent[1].message, '{"code":42}');
      assert.equal(sent[2].message, 'Unhandled promise rejection');
    });

    test('captures failed resource loads', async () => {
      const b = createBrowser({ dataset: DATA });
      b.load(code);
      b.dispatch('error', { target: { tagName: 'IMG', src: 'https://shop.example/logo.png?x=1' } });
      b.runTimers();
      const [e] = await b.sent();
      assert.equal(e.type, 'resource');
      assert.equal(e.tag, 'img');
      assert.equal(e.source, 'https://shop.example/logo.png');
    });

    test('reports fetch 4xx/5xx and network errors, but not successes or its own endpoint', async () => {
      const b = createBrowser({ dataset: DATA });
      b.load(code);
      b.setFetch(async (url) => {
        if (String(url).includes('/boom')) return { status: 500 };
        if (String(url).includes('/missing')) return { status: 404 };
        if (String(url).includes('/down')) throw new TypeError('Failed to fetch');
        return { status: 200 };
      });
      const ok = await b.win.fetch('https://shop.example/ok');
      assert.equal(ok.status, 200, 'returns the original response');
      const r500 = await b.win.fetch('https://shop.example/boom?secret=1', { method: 'post' });
      assert.equal(r500.status, 500);
      await b.win.fetch('https://shop.example/missing');
      await assert.rejects(b.win.fetch('https://shop.example/down'), /Failed to fetch/, 'original rejection still reaches the caller');
      await b.win.fetch('https://errors.example/api/errors?key=x');
      await new Promise((r) => setImmediate(r));
      b.runTimers();
      const sent = await b.sent();
      assert.deepEqual(sent.map((e) => e.status), [500, 404, 0]);
      assert.equal(sent[0].method, 'POST');
      assert.equal(sent[0].requestUrl, 'https://shop.example/boom');
      assert.equal(sent[0].message, 'HTTP 500 POST https://shop.example/boom');
      assert.match(sent[2].message, /Network error GET .*Failed to fetch/);
    });

    test('does not report aborted fetches', async () => {
      const b = createBrowser({ dataset: DATA });
      b.load(code);
      b.setFetch(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
      await assert.rejects(b.win.fetch('https://shop.example/x'));
      await new Promise((r) => setImmediate(r));
      b.runTimers();
      assert.equal(b.beacons.length, 0);
    });

    test('reports failed XHR but not aborted or successful ones', async () => {
      const b = createBrowser({ dataset: DATA });
      b.load(code);
      const x1 = new b.XHR(); x1.open('GET', 'https://shop.example/api/items'); x1.send(); x1.respond(503);
      const x2 = new b.XHR(); x2.open('GET', 'https://shop.example/api/ok'); x2.send(); x2.respond(200);
      const x3 = new b.XHR(); x3.open('GET', 'https://shop.example/api/slow'); x3.send(); x3.abort();
      assert.ok(x1._sent && x2._sent && x3._sent, 'original send still runs');
      b.runTimers();
      const sent = await b.sent();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].status, 503);
      assert.equal(sent[0].type, 'http');
    });

    test('dedupes repeated errors client-side (max 3 per kind) and caps the total', async () => {
      const b = createBrowser({ dataset: DATA });
      b.load(code);
      for (let i = 0; i < 10; i++) b.dispatch('error', { error: new Error('same'), message: 'same', filename: 'https://shop.example/a.js', lineno: 1 });
      for (let i = 0; i < 100; i++) b.dispatch('error', { error: new Error('e' + i), message: 'e' + i, filename: 'https://shop.example/a.js', lineno: i });
      b.runTimers();
      const sent = await b.sent();
      assert.equal(sent.filter((e) => e.message === 'same').length, 3);
      assert.equal(sent.length, 50);
    });

    test('batches up to 10 per request and flushes a full batch immediately', async () => {
      const b = createBrowser({ dataset: DATA });
      b.load(code);
      for (let i = 0; i < 10; i++) b.dispatch('error', { error: new Error('b' + i), message: 'b' + i, filename: 'https://shop.example/a.js', lineno: i });
      assert.equal(b.beacons.length, 1, 'sent without waiting for the timer');
      assert.equal((await b.sent()).length, 10);
    });

    test('flushes on pagehide', async () => {
      const b = createBrowser({ dataset: DATA });
      b.load(code);
      b.dispatch('error', { error: new Error('leaving'), message: 'leaving' });
      b.dispatch('pagehide', {});
      assert.equal(b.beacons.length, 1);
    });

    test('falls back to fetch keepalive when sendBeacon is missing or refuses', async () => {
      for (const opts of [{ beacon: false }, { beaconReturns: false }]) {
        const b = createBrowser({ dataset: DATA, ...opts });
        b.load(code);
        b.dispatch('error', { error: new Error('fb'), message: 'fb' });
        b.runTimers();
        const call = b.fetchCalls.find(([u]) => String(u).startsWith('https://errors.example/api/errors'));
        assert.ok(call, 'used fetch');
        assert.equal(call[1].keepalive, true);
        assert.equal(call[1].mode, 'no-cors');
        assert.equal(JSON.parse(call[1].body).errors[0].message, 'fb');
      }
    });

    test('never throws into the host page, even when the browser APIs misbehave', async () => {
      const b = createBrowser({ dataset: DATA, beaconThrows: true });
      b.setFetch(() => Promise.reject(new Error('offline')));
      b.load(code);
      assert.doesNotThrow(() => {
        b.dispatch('error', null);
        b.dispatch('error', {});
        b.dispatch('error', { error: { get message() { throw new Error('evil'); } } });
        b.dispatch('unhandledrejection', null);
        b.dispatch('unhandledrejection', { get reason() { throw new Error('evil'); } });
        b.runTimers();
      });
      await new Promise((r) => setImmediate(r));
      // addEventListener itself throwing must not break loading either.
      const b2 = createBrowser({ dataset: DATA });
      b2.win.addEventListener = () => { throw new Error('nope'); };
      assert.doesNotThrow(() => b2.load(code));
    });

    test('loads only once even if included twice', () => {
      const b = createBrowser({ dataset: DATA });
      b.load(code);
      const wrapped = b.win.fetch;
      b.load(code);
      assert.equal(b.win.fetch, wrapped);
    });
  });
}
