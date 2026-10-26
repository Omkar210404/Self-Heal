/*!
 * selfheal browser snippet. No dependencies.
 * <script src="/selfheal.min.js" data-endpoint="https://your-server/api/errors" data-key="PROJECT_KEY" data-release="1.0.0" async></script>
 * Everything is wrapped in try/catch: it must never break or slow the host page.
 */
(function (w, d) {
  try {
    if (!w || w.__selfheal) return;
    var cs = d && d.currentScript;
    var ds = (cs && cs.dataset) || {};
    var cfg = w.SelfHealConfig || {};
    var endpoint = cfg.endpoint || ds.endpoint;
    var key = cfg.key || ds.key;
    if (!endpoint || !key) return;
    var release = cfg.release || ds.release || '';
    var loc = w.location || {};
    var nav = w.navigator || {};
    try { endpoint = new URL(endpoint, loc.href).href; } catch (e) {}
    var target = endpoint + (endpoint.indexOf('?') < 0 ? '?' : '&') + 'key=' + encodeURIComponent(key);

    var MAX_PER_KEY = 3, MAX_TOTAL = 50, BATCH = 10, WAIT = 2000;
    var queue = [], seen = {}, total = 0, timer = 0;
    var origFetch = w.fetch, XHR = w.XMLHttpRequest;
    w.__selfheal = { v: '1.0.0' };

    var str = function (v, n) {
      try { v = v == null ? '' : typeof v === 'string' ? v : v.message || JSON.stringify(v) || String(v); } catch (e) { v = String(v); }
      return v.length > n ? v.slice(0, n) : v;
    };
    // Drop the query string and fragment: they often carry tokens or personal data.
    var clean = function (u) { return str(u, 2000).split(/[?#]/)[0]; };
    var own = function (u) { return clean(u).indexOf(clean(endpoint)) === 0; };

    var flush = function () {
      try {
        clearTimeout(timer);
        timer = 0;
        while (queue.length) {
          var body = JSON.stringify({ errors: queue.splice(0, BATCH) });
          var sent = false;
          try { sent = nav.sendBeacon && nav.sendBeacon(target, new Blob([body], { type: 'text/plain' })); } catch (e) {}
          if (!sent && origFetch) {
            origFetch.call(w, target, { method: 'POST', body: body, keepalive: true, mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } })['catch'](function () {});
          }
        }
      } catch (e) {}
    };

    var report = function (e) {
      try {
        if (total >= MAX_TOTAL) return;
        var k = e.type + '|' + e.message + '|' + (e.source || '') + '|' + (e.line || '');
        seen[k] = (seen[k] || 0) + 1;
        if (seen[k] > MAX_PER_KEY) return;
        total++;
        e.message = str(e.message, 500);
        if (e.stack) e.stack = str(e.stack, 4000);
        if (e.source) e.source = clean(e.source);
        e.url = clean(loc.href);
        e.userAgent = str(nav.userAgent, 300);
        e.timestamp = new Date().toISOString();
        if (release) e.release = str(release, 100);
        queue.push(e);
        if (queue.length >= BATCH) flush();
        else if (!timer) timer = setTimeout(flush, WAIT);
      } catch (x) {}
    };

    var on = function (t, f, c) { try { w.addEventListener(t, f, c); } catch (e) {} };

    // Uncaught errors + failed resource loads (resource errors only reach capture listeners).
    on('error', function (ev) {
      try {
        var t = ev.target;
        if (t && t !== w && t.tagName) {
          var src = t.src || t.href || '';
          if (src) report({ type: 'resource', message: 'Failed to load ' + t.tagName.toLowerCase() + ' ' + clean(src), source: src, tag: t.tagName.toLowerCase() });
          return;
        }
        var er = ev.error;
        var file = ev.filename || '';
        if (/^(chrome|moz|safari|ms-browser)-extension:/.test(file)) return;
        if (!file && ev.message === 'Script error.') return; // cross-origin, no detail available
        report({ type: 'error', name: str(er && er.name, 100), message: str((er && er.message) || ev.message || 'Unknown error', 500), stack: er && er.stack, source: file, line: ev.lineno, col: ev.colno });
      } catch (x) {}
    }, true);

    on('unhandledrejection', function (ev) {
      try {
        var r = ev.reason;
        report({ type: 'unhandledrejection', name: str(r && r.name, 100), message: str(r, 500) || 'Unhandled promise rejection', stack: r && r.stack });
      } catch (x) {}
    });

    var http = function (method, u, status, extra, stack) {
      report({ type: 'http', method: String(method || 'GET').toUpperCase(), status: status, requestUrl: clean(u),
        message: (status ? 'HTTP ' + status : 'Network error') + ' ' + String(method || 'GET').toUpperCase() + ' ' + clean(u) + (extra ? ': ' + extra : ''), stack: stack });
    };

    if (origFetch) {
      w.fetch = function (input, init) {
        var p = origFetch.apply(this, arguments);
        try {
          var u = typeof input === 'string' ? input : (input && input.url) || String(input);
          if (!own(u)) {
            var m = (init && init.method) || (input && input.method) || 'GET';
            var st = new Error().stack;
            p.then(function (res) {
              try { if (res && res.status >= 400) http(m, u, res.status, '', st); } catch (x) {}
            }, function (er) {
              try { if (!er || er.name !== 'AbortError') http(m, u, 0, str(er, 200), st); } catch (x) {}
            });
          }
        } catch (x) {}
        return p;
      };
    }

    if (XHR && XHR.prototype) {
      var po = XHR.prototype.open, ps = XHR.prototype.send;
      XHR.prototype.open = function (m, u) {
        try { this.__sh = { m: m, u: String(u) }; } catch (x) {}
        return po.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        try {
          var x = this, i = x.__sh;
          if (i && !own(i.u)) {
            var st = new Error().stack, aborted = false;
            x.addEventListener('abort', function () { aborted = true; });
            x.addEventListener('loadend', function () {
              try { if (!aborted && (x.status >= 400 || x.status === 0)) http(i.m, i.u, x.status, '', st); } catch (e) {}
            });
          }
        } catch (e) {}
        return ps.apply(this, arguments);
      };
    }

    on('pagehide', flush);
    on('visibilitychange', function () { try { if (d.visibilityState === 'hidden') flush(); } catch (e) {} });
    w.__selfheal.flush = flush;
    w.__selfheal.report = function (err, extra) {
      try { report({ type: 'error', name: str(err && err.name, 100), message: str(err, 500), stack: err && err.stack, manual: true, extra: str(extra, 500) }); } catch (e) {}
    };
  } catch (e) {}
})(typeof window !== 'undefined' ? window : undefined, typeof document !== 'undefined' ? document : undefined);
