'use strict';
// Minimal fake browser for running the snippet inside node:vm.
const vm = require('node:vm');

function createBrowser({ dataset = {}, config, beacon = true, beaconThrows = false, beaconReturns = true, href = 'https://shop.example/checkout?token=abc#x' } = {}) {
  const listeners = {};
  const timers = [];
  const beacons = [];
  const fetchCalls = [];
  let fetchImpl = async () => ({ status: 200 });

  class FakeXHR {
    constructor() { this.status = 0; this._l = {}; }
    open(method, url) { this._method = method; this._url = url; }
    send() { this._sent = true; }
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
    _fire(t) { for (const f of this._l[t] || []) f({ type: t }); }
    respond(status) { this.status = status; this._fire('load'); this._fire('loadend'); }
    abort() { this.status = 0; this._fire('abort'); this._fire('loadend'); }
  }

  const win = {
    location: { href },
    navigator: { userAgent: 'FakeBrowser/1.0' },
    XMLHttpRequest: FakeXHR,
    Blob,
    URL,
    JSON,
    Date,
    Error,
    Promise,
    encodeURIComponent,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fetch: (...args) => { fetchCalls.push(args); return fetchImpl(...args); },
  };
  if (beacon) {
    win.navigator.sendBeacon = (url, data) => {
      if (beaconThrows) throw new Error('beacon broke');
      beacons.push({ url, data });
      return beaconReturns;
    };
  }
  if (config) win.SelfHealConfig = config;
  win.window = win;
  win.document = { currentScript: { dataset }, visibilityState: 'visible' };
  vm.createContext(win);

  return {
    win,
    beacons,
    fetchCalls,
    XHR: FakeXHR,
    setFetch(fn) { fetchImpl = fn; },
    load(code) { vm.runInContext(code, win); },
    dispatch(type, event) { for (const f of listeners[type] || []) f(event); },
    runTimers() { while (timers.length) timers.shift()(); },
    async sent() {
      const out = [];
      for (const b of beacons) out.push(...JSON.parse(await b.data.text()).errors);
      return out;
    },
  };
}

module.exports = { createBrowser };
