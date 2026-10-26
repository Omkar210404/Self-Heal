'use strict';
/*
 * Server-rendered dashboard: login (DASHBOARD_PASSWORD), issues list, issue detail with full history,
 * read-only settings (secrets masked). In mock mode: a simulated WhatsApp phone and mock PR pages.
 */
const crypto = require('node:crypto');
const express = require('express');
const { maskedConfig } = require('../server/config');
const { RateLimiter } = require('../server/ratelimit');
const { STATUSES } = require('../server/issues');
const msgs = require('../server/notify/messages');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rich = (s) => esc(s).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, '<br>');
const when = (iso) => (iso ? esc(iso.replace('T', ' ').slice(0, 19)) + ' UTC' : '');
const COLORS = { new: '#8b95a1', alerted: '#e3b341', approved: '#58a6ff', fixing: '#58a6ff', fix_ready: '#a371f7', merged: '#3fb950', rejected: '#8b95a1', ignored: '#6e7681', fix_failed: '#f85149', rolled_back: '#db6d28' };
const badge = (s) => `<span class="badge" style="--c:${COLORS[s] || '#8b95a1'}">${esc(s.replace('_', ' '))}</span>`;

const CSS = `
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--text:#e6edf3;--muted:#8b949e;--accent:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;gap:18px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
header b{font-size:16px}header nav{display:flex;gap:14px;flex:1;flex-wrap:wrap}.mock{background:#5a3e00;color:#ffd47a;padding:2px 8px;border-radius:10px;font-size:12px}
main{max-width:1100px;margin:0 auto;padding:20px 16px}h1{font-size:20px;margin:0 0 14px}h2{font-size:15px;margin:22px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px;overflow-x:auto}
table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;border:1px solid var(--c);color:var(--c);font-size:12px;white-space:nowrap}
.muted{color:var(--muted)}pre{background:#0b0f14;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;max-height:420px;font-size:12px;white-space:pre-wrap;word-break:break-word}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.chips a{padding:3px 10px;border:1px solid var(--line);border-radius:14px;color:var(--text)}.chips a.on{border-color:var(--accent)}
.warn{border-color:#9e6a03;background:#2a1f05}.err{color:#f85149}
input,button,select{font:inherit;color:inherit;background:#0b0f14;border:1px solid var(--line);border-radius:8px;padding:8px 10px}button{cursor:pointer;background:#21262d}button:hover{border-color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.kv td:first-child{color:var(--muted);width:45%}
.phone{max-width:430px;margin:0 auto;background:#0b141a;border:1px solid var(--line);border-radius:18px;overflow:hidden}
.phone .top{background:#202c33;padding:12px 16px;font-weight:600}.chat{height:60vh;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:85%;padding:8px 10px;border-radius:8px;font-size:13.5px;word-wrap:break-word}.out{background:#202c33;align-self:flex-start}.in{background:#005c4b;align-self:flex-end}
.msg .meta{font-size:11px;color:#8696a0;margin-top:4px}.btns{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}.btns button{flex:1;background:#0b141a;color:#53bdeb;border-color:#2a3942}
.compose{display:flex;gap:6px;padding:10px;background:#202c33}.compose input{flex:1}
@media (max-width:600px){td,th{padding:6px 4px}.hide-sm{display:none}}`;

function createDashboard(services) {
  const { config, issues, notifier, usage, router, queue, provider, host, db } = services;
  const r = express.Router();
  const secret = config.dashboard.sessionSecret;
  const hmac = (s) => crypto.createHmac('sha256', secret).update(s).digest('hex');
  const loginLimiter = new RateLimiter({ limit: 10, windowMs: 15 * 60_000 });
  const secure = config.publicUrl.startsWith('https://');

  const cookie = (req) => (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === 'sh_session')?.[1] || '';
  const authed = (req) => {
    const [exp, sig] = cookie(req).split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const want = hmac(exp);
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  };
  const csrf = (req) => hmac('csrf:' + cookie(req));
  const form = (req, action, inner, attrs = '') => `<form method="post" action="${action}" ${attrs}><input type="hidden" name="csrf" value="${csrf(req)}">${inner}</form>`;

  const page = (req, title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · selfheal</title><style>${CSS}</style></head><body>
<header><b>🩹 selfheal</b>${config.mock ? '<span class="mock">MOCK MODE</span>' : ''}<nav><a href="/dashboard">Issues</a><a href="/dashboard/settings">Settings</a>
${config.mock ? '<a href="/dashboard/phone">📱 Fake phone</a><a href="/demo/" target="_blank">Demo site</a>' : ''}</nav>
${authed(req) ? form(req, '/dashboard/logout', '<button>Log out</button>') : ''}</header><main>${body}</main></body></html>`;

  r.use(express.urlencoded({ extended: false, limit: '20kb' }));
  r.use((req, res, next) => { res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store' }); next(); });

  r.get('/login', (req, res) => res.send(page(req, 'Log in', `<div class="panel" style="max-width:360px;margin:40px auto">
    <h1>Log in</h1><form method="post" action="/dashboard/login"><input type="password" name="password" placeholder="Dashboard password" autofocus style="width:100%;margin-bottom:10px">
    <button style="width:100%">Log in</button></form>${req.query.e ? '<p class="err">Wrong password.</p>' : ''}
    ${config.mock ? '<p class="muted">Mock mode: the password is printed in the terminal where you ran <code>npm run mock</code>.</p>' : ''}</div>`)));

  r.post('/login', (req, res) => {
    if (!loginLimiter.take(req.ip).allowed) return res.status(429).send('Too many attempts. Try again in 15 minutes.');
    const a = crypto.createHash('sha256').update(String(req.body?.password || '')).digest();
    const b = crypto.createHash('sha256').update(config.dashboard.password).digest();
    if (!config.dashboard.password || !crypto.timingSafeEqual(a, b)) return res.redirect('/dashboard/login?e=1');
    const exp = String(Date.now() + 12 * 3600_000);
    res.set('Set-Cookie', `sh_session=${exp}.${hmac(exp)}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=43200${secure ? '; Secure' : ''}`);
    res.redirect('/dashboard');
  });

  // Everything below needs a session; POSTs also need the CSRF token.
  r.use((req, res, next) => {
    if (!authed(req)) return req.method === 'GET' ? res.redirect('/dashboard/login') : res.status(401).send('Log in first');
    if (req.method === 'POST' && req.body?.csrf !== csrf(req)) return res.status(403).send('Bad CSRF token');
    next();
  });

  r.post('/logout', (req, res) => {
    res.set('Set-Cookie', 'sh_session=; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=0');
    res.redirect('/dashboard/login');
  });

  r.get('/', (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const counts = issues.counts();
    const list = issues.list({ status, limit: 200 });
    const failures = notifier.failures(5);
    const chips = `<div class="chips"><a href="/dashboard" class="${status ? '' : 'on'}">All</a>${STATUSES.filter((s) => counts[s]).map((s) => `<a href="?status=${s}" class="${status === s ? 'on' : ''}">${esc(s.replace('_', ' '))} (${counts[s]})</a>`).join('')}</div>`;
    const banner = failures.length ? `<div class="panel warn">⚠️ ${failures.length} WhatsApp message(s) not delivered: ${failures.map((m) => `#${m.id} ${esc(m.kind)}${m.issue_id ? ` (issue <a href="/dashboard/issues/${m.issue_id}">#${m.issue_id}</a>)` : ''}: ${esc(m.status === 'awaiting_window' ? 'waiting for you to reply (24-hour window)' : m.error)}`).join('<br>')}</div>` : '';
    const rows = list.map((i) => `<tr><td><a href="/dashboard/issues/${i.id}">#${i.id}</a></td><td>${badge(i.status)}</td>
      <td><a href="/dashboard/issues/${i.id}">${esc(msgs.short(i.title, 110))}</a><div class="muted">${esc(i.file || '')}${i.line ? ':' + i.line : ''}</div></td>
      <td>${i.count}×</td><td class="hide-sm muted">${when(i.last_seen)}</td><td class="hide-sm">${i.pr_url ? `<a href="${esc(i.pr_url)}" target="_blank">PR #${i.pr_number}</a>` : ''}</td></tr>`).join('');
    res.send(page(req, 'Issues', `<h1>Issues</h1>${banner}${chips}<div class="panel">${list.length ? `<table><tr><th>#</th><th>Status</th><th>Error</th><th>Count</th><th class="hide-sm">Last seen</th><th class="hide-sm">PR</th></tr>${rows}</table>`
      : `<p class="muted">No errors yet. ${config.mock ? 'Open the <a href="/demo/" target="_blank">demo site</a> and press <b>Checkout</b>.' : 'Install the snippet on your site (see README).'}</p>`}</div>`));
  });

  r.get('/issues/:id', (req, res) => {
    const i = issues.get(req.params.id);
    if (!i) return res.status(404).send(page(req, 'Not found', '<h1>Issue not found</h1>'));
    const files = i.files_changed ? JSON.parse(i.files_changed) : [];
    const attempts = db.prepare('SELECT * FROM fix_attempts WHERE issue_id = ? ORDER BY id').all(i.id);
    const occ = issues.occurrences(i.id).slice(0, 5);
    const kv = (rows) => `<table class="kv">${rows.filter(([, v]) => v !== '' && v != null).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
    res.send(page(req, `Issue #${i.id}`, `<h1>#${i.id} ${esc(i.title)} ${badge(i.status)}</h1>
      ${i.status_reason ? `<div class="panel ${i.status === 'fix_failed' ? 'warn' : ''}">${esc(i.status_reason)}</div>` : ''}
      <div class="grid"><div class="panel">${kv([['Kind', esc(i.kind)], ['Where', esc(`${i.file || '?'}${i.line ? ':' + i.line : ''}`)], ['Count', i.count], ['First seen', when(i.first_seen)], ['Last seen', when(i.last_seen)], ['Page', esc(i.page_url)], ['Release', esc(i.release)], ['Browser', esc(i.user_agent)]])}</div>
      <div class="panel">${kv([['AI provider', esc(i.ai_provider)], ['Attempts', i.attempts || ''], ['Tests', i.tested == null ? '' : i.tested ? `✅ ${esc(i.test_summary)}` : '⚠️ UNTESTED'], ['Branch', esc(i.branch)], ['Pull request', i.pr_url ? `<a href="${esc(i.pr_url)}" target="_blank">#${i.pr_number}</a>` : ''], ['Merge commit', esc(i.merge_sha?.slice(0, 10))], ['Revert PR', i.revert_pr_url ? `<a href="${esc(i.revert_pr_url)}" target="_blank">#${i.revert_pr_number}</a>` : ''], ['Files', files.map((f) => `${esc(f.path)} (+${f.added} −${f.removed})`).join('<br>')]])}</div></div>
      ${i.root_cause ? `<h2>AI diagnosis</h2><div class="panel"><p><b>Root cause:</b> ${esc(i.root_cause)}</p><p><b>Explanation:</b> ${esc(i.explanation)}</p></div>` : ''}
      ${attempts.length ? `<h2>Fix attempts</h2>${attempts.map((a) => `<div class="panel"><b>Run ${a.run} · attempt ${a.attempt}</b> · ${esc(a.provider)} · tests: ${a.test_passed == null ? 'not run' : a.test_passed ? '✅ passed' : '❌ failed'}
        ${JSON.parse(a.changes || '[]').map((c) => `<pre>${esc(c.diff)}</pre>`).join('')}${a.test_output ? `<details><summary>Test output</summary><pre>${esc(a.test_output)}</pre></details>` : ''}</div>`).join('')}` : ''}
      ${i.stack ? `<h2>Stack trace</h2><pre>${esc(i.stack)}</pre>` : ''}
      <h2>History</h2><div class="panel"><table>${issues.events(i.id).map((e) => `<tr><td class="muted" style="white-space:nowrap">${when(e.created_at)}</td><td>${e.to_status ? `${badge(e.from_status || 'new')} → ${badge(e.to_status)}` : esc(e.type)}</td><td class="muted">${esc(e.detail || '')}</td></tr>`).join('')}</table></div>
      <h2>WhatsApp messages</h2><div class="panel"><table>${notifier.forIssue(i.id).map((m) => `<tr><td class="muted" style="white-space:nowrap">${when(m.created_at)}</td><td>${esc(m.kind)}</td><td>${esc(m.status)}</td><td class="muted">${esc(m.error || '')}</td></tr>`).join('') || '<tr><td class="muted">None</td></tr>'}</table></div>
      <h2>Recent occurrences</h2><div class="panel"><table>${occ.map((o) => `<tr><td class="muted" style="white-space:nowrap">${when(o.created_at)}</td><td>${esc(o.data.pageUrl)}</td><td class="muted hide-sm">${esc(o.data.userAgent)}</td></tr>`).join('')}</table></div>`));
  });

  r.get('/settings', (req, res) => {
    const today = usage.today();
    const cfg = maskedConfig(config);
    const status = {
      'Configured AI providers (in order)': router.configured().map((p) => p.name).join(' → ') || '<span class="err">none</span>',
      'AI usage today (UTC)': `$${today.costUsd.toFixed(3)} of $${config.ai.dailyMaxCostUsd} · ${today.calls} of ${config.ai.dailyMaxCalls} calls`,
      'Webhook URL for Meta': esc(`${config.publicUrl}/webhook/whatsapp`),
      'Last message from you': when(notifier.ownerLastInboundAt()) || 'never (24-hour window closed: alerts will use the template)',
      'Queued / running jobs': queue.list({ limit: 500 }).filter((j) => ['queued', 'running'].includes(j.status)).length,
    };
    const table = (title, obj) => `<div class="panel"><h2 style="margin-top:0">${esc(title)}</h2><table class="kv">${Object.entries(obj).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${typeof v === 'string' && v.includes('<') ? v : esc(v)}</td></tr>`).join('')}</table></div>`;
    res.send(page(req, 'Settings', `<h1>Settings <span class="muted" style="font-size:13px">(read-only: edit .env and restart)</span></h1>
      ${req.query.sent ? '<div class="panel">✅ Test message queued. Check WhatsApp (or the issue list banner if it fails).</div>' : ''}
      <div class="panel">${form(req, '/dashboard/settings/test-message', '<button>📨 Send a test WhatsApp message</button> <span class="muted">Checks your token, phone number id and recipient.</span>')}</div>
      <div class="grid">${table('Status', status)}${Object.entries(cfg).map(([k, v]) => table(k, v)).join('')}</div>`));
  });

  r.post('/settings/test-message', (req, res) => {
    notifier.send({ kind: 'test', message: msgs.testMessage() });
    res.redirect('/dashboard/settings?sent=1');
  });

  if (config.mock) {
    const chat = (req) => notifier.recent(80).filter((m) => m.status !== 'ignored').map((m) => {
      const p = JSON.parse(m.payload);
      if (m.direction === 'in') return `<div class="msg in">${esc(p.buttonId ? `[tapped] ${p.buttonId}` : p.text)}<div class="meta">${when(m.created_at)}</div></div>`;
      if (['queued', 'retrying'].includes(m.status)) return `<div class="msg out muted">⏳ sending… ${esc(m.kind)}${m.error ? ` (${esc(m.error)})` : ''}</div>`;
      const btns = (p.buttons || []).map((b) => `<button name="buttonId" value="${esc(b.id)}">${esc(b.title)}</button>`).join('');
      const text = m.kind === 'template' ? `📄 <i>Template message</i><br>${rich(p.text)}` : rich(p.text);
      return `<div class="msg out">${text}${btns ? form(req, '/dashboard/phone/reply', `<div class="btns">${btns}</div>`) : ''}<div class="meta">${when(m.created_at)} · ${esc(m.status)}${m.error ? ` · ${esc(m.error)}` : ''}</div></div>`;
    }).join('') || '<p class="muted">No messages yet. Trigger an error on the demo site.</p>';

    r.get('/phone', (req, res) => {
      if (req.query.partial) return res.send(chat(req));
      res.send(page(req, 'Fake phone', `<h1>📱 Simulated WhatsApp</h1><p class="muted">What the owner's phone would show. Replies go through the real signed-webhook code path.</p>
        <div class="phone"><div class="top">selfheal bot</div><div class="chat" id="chat">${chat(req)}</div>
        ${form(req, '/dashboard/phone/reply', '<input name="text" placeholder="Type e.g. YES 1, MERGE 1, ROLLBACK 1" autocomplete="off"><button>Send</button>', 'class="compose"')}</div>
        <div class="panel" style="max-width:430px;margin:12px auto">${form(req, '/dashboard/phone/sim', `<b>Simulate problems</b><br>
          <label><input type="checkbox" name="down" ${provider.down ? 'checked' : ''}> WhatsApp API down</label><br>
          <label><input type="checkbox" name="closed" ${provider.windowOpen ? '' : 'checked'}> 24-hour window closed</label><br><button style="margin-top:6px">Apply</button>`)}</div>
        <script>const c=document.getElementById('chat');c.scrollTop=c.scrollHeight;let last=c.innerHTML;
        setInterval(async()=>{try{const h=await (await fetch('/dashboard/phone?partial=1')).text();if(h!==last){last=h;c.innerHTML=h;c.scrollTop=c.scrollHeight;}}catch(e){}},2000);</script>`));
    });

    r.post('/phone/reply', async (req, res) => {
      const { buttonId, text } = req.body || {};
      if (buttonId || text?.trim()) {
        const { raw, signature } = provider.buildInbound({ from: config.whatsapp.ownerNumber, text: text?.trim(), buttonId });
        await notifier.processWebhook(raw, signature);
      }
      res.redirect('/dashboard/phone');
    });

    r.post('/phone/sim', (req, res) => {
      provider.setDown(!!req.body.down);
      provider.windowOpen = !req.body.closed;
      res.redirect('/dashboard/phone');
    });

    r.get('/mock/prs/:n', async (req, res) => {
      const pr = host.pr(Number(req.params.n));
      if (!pr) return res.status(404).send(page(req, 'PR', '<h1>PR not found</h1>'));
      res.send(page(req, `PR #${pr.number}`, `<h1>Mock PR #${pr.number}: ${esc(pr.title)} ${badge(pr.merged ? 'merged' : pr.state === 'open' ? 'fix_ready' : 'rejected')}</h1>
        <div class="panel muted">${esc(pr.head)} → ${esc(pr.base)}</div><div class="panel"><pre>${esc(pr.body)}</pre></div><h2>Diff</h2><pre>${esc(await host.diff(pr.number))}</pre>`));
    });
  }

  return r;
}

module.exports = { createDashboard };
