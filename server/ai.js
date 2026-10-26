'use strict';
/*
 * AI providers behind one interface:  complete({ system, messages, maxTokens }) -> { text, inputTokens, outputTokens, model }
 * Claude (Anthropic), Gemini (Google), Ollama (local) and a Mock for tests/mock mode.
 * AIRouter tries providers in AI_PROVIDERS order, falls back on any failure, retries malformed
 * answers with feedback, records usage and enforces the daily cost/call cap.
 */

class AIProviderError extends Error {
  constructor(provider, kind, message) {
    super(`${provider}: ${message}`);
    this.name = 'AIProviderError';
    this.provider = provider;
    this.kind = kind; // auth | rate_limit | timeout | unavailable | bad_request | not_configured
  }
}

class CostCapError extends Error {
  constructor(totals, resumeAt) {
    super(`Daily AI limit reached ($${totals.costUsd.toFixed(2)}, ${totals.calls} calls)`);
    this.name = 'CostCapError';
    this.totals = totals;
    this.resumeAt = resumeAt;
  }
}

class AllProvidersFailedError extends Error {
  constructor(failures) {
    super(failures.length ? `All AI providers failed: ${failures.map((f) => f.reason).join(' | ')}` : 'No AI provider is configured');
    this.name = 'AllProvidersFailedError';
    this.failures = failures;
  }
}

/** POST JSON with a timeout; maps HTTP/network failures to AIProviderError kinds. */
async function postJson(fetch, provider, url, headers, body, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new AIProviderError(provider, 'timeout', `timed out after ${timeoutMs}ms`);
    throw new AIProviderError(provider, 'unavailable', `unreachable (${err?.cause?.code || err?.message})`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || `HTTP ${res.status}`;
    const kind =
      res.status === 401 || res.status === 403 || /api key/i.test(String(msg)) ? 'auth'
        : res.status === 429 ? 'rate_limit'
          : res.status >= 500 ? 'unavailable' : 'bad_request';
    throw new AIProviderError(provider, kind, `${kind.replace('_', ' ')}: ${String(msg).slice(0, 300)}`);
  }
  return json;
}

class ClaudeProvider {
  constructor({ apiKey, model, baseUrl = 'https://api.anthropic.com', timeoutMs = 120000, fetch = globalThis.fetch }) {
    Object.assign(this, { name: 'claude', apiKey, model, baseUrl, timeoutMs, fetch });
  }
  isConfigured() { return !!this.apiKey; }
  async complete({ system, messages, maxTokens = 4096 }) {
    const j = await postJson(this.fetch, this.name, `${this.baseUrl}/v1/messages`, { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      { model: this.model, max_tokens: maxTokens, system, messages }, this.timeoutMs);
    const text = (j?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    if (!text) throw new AIProviderError(this.name, 'unavailable', 'empty response');
    return { text, model: j.model || this.model, inputTokens: j.usage?.input_tokens || 0, outputTokens: j.usage?.output_tokens || 0 };
  }
}

class GeminiProvider {
  constructor({ apiKey, model, baseUrl = 'https://generativelanguage.googleapis.com', timeoutMs = 120000, fetch = globalThis.fetch }) {
    Object.assign(this, { name: 'gemini', apiKey, model, baseUrl, timeoutMs, fetch });
  }
  isConfigured() { return !!this.apiKey; }
  /** GEMINI_MODEL may list backups ("a,b"): the next model is tried when one is overloaded, rate limited or retired. */
  async complete(req) {
    const models = String(this.model).split(',').map((m) => m.trim()).filter(Boolean);
    for (let i = 0; ; i++) {
      try {
        return await this.completeWith(models[i], req);
      } catch (err) {
        if (i + 1 >= models.length || !['unavailable', 'rate_limit', 'bad_request'].includes(err.kind)) throw err;
      }
    }
  }

  async completeWith(model, { system, messages, maxTokens = 4096 }) {
    const j = await postJson(this.fetch, this.name, `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': this.apiKey }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens, temperature: 0.2 },
    }, this.timeoutMs);
    if (j?.promptFeedback?.blockReason) throw new AIProviderError(this.name, 'bad_request', `blocked: ${j.promptFeedback.blockReason}`);
    const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) throw new AIProviderError(this.name, 'unavailable', `empty response (${j?.candidates?.[0]?.finishReason || 'no candidates'})`);
    return { text, model, inputTokens: j.usageMetadata?.promptTokenCount || 0, outputTokens: j.usageMetadata?.candidatesTokenCount || 0 };
  }
}

class OllamaProvider {
  constructor({ url = 'http://127.0.0.1:11434', model, timeoutMs = 120000, fetch = globalThis.fetch }) {
    Object.assign(this, { name: 'ollama', url: url.replace(/\/+$/, ''), model, timeoutMs, fetch });
  }
  isConfigured() { return !!this.model; }
  async complete({ system, messages, maxTokens = 4096 }) {
    let j;
    try {
      j = await postJson(this.fetch, this.name, `${this.url}/api/chat`, {}, {
        model: this.model, stream: false, format: 'json', options: { temperature: 0.2, num_predict: maxTokens },
        messages: [{ role: 'system', content: system }, ...messages],
      }, this.timeoutMs);
    } catch (err) {
      if (err.kind === 'unavailable') err.message += ` (is Ollama running at ${this.url}?)`;
      if (err.kind === 'bad_request' && /not found/i.test(err.message)) err.message += ` (run: ollama pull ${this.model})`;
      throw err;
    }
    const text = j?.message?.content || '';
    if (!text) throw new AIProviderError(this.name, 'unavailable', 'empty response');
    return { text, model: this.model, inputTokens: j.prompt_eval_count || 0, outputTokens: j.eval_count || 0 };
  }
}

/**
 * Fake AI for mock mode and tests. Reads the files from the prompt and fixes known demo bugs.
 * modes: 'wrong-then-right' (default: first attempt fails tests, retry passes), 'right', 'always-wrong',
 *        'down', 'malformed', 'malformed-once', 'unfixable'
 */
const MOCK_RULES = [
  {
    find: 'if (coupon.percentOff) {',
    wrong: 'if (coupon.percentOff > 0) {',
    right: 'if (coupon && coupon.percentOff) {',
    cause: 'calculateTotal() reads coupon.percentOff without checking that a coupon was passed, so checkout without a coupon throws a TypeError.',
  },
];

class MockAIProvider {
  constructor({ name = 'mock', mode = 'wrong-then-right' } = {}) {
    Object.assign(this, { name, mode, calls: 0, once: false });
  }
  isConfigured() { return true; }
  async complete({ messages }) {
    this.calls++;
    const prompt = messages[0].content;
    const usage = (text) => ({ text, model: 'mock', inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(text.length / 4) });
    if (this.mode === 'down') throw new AIProviderError(this.name, 'unavailable', 'mock provider is down (simulated)');
    if (this.mode === 'malformed' || (this.mode === 'malformed-once' && !this.once)) {
      this.once = true;
      return usage('Sure! I think the bug is in cart.js, you should add a check.');
    }
    const previous = (prompt.match(/^### Attempt \d+/gm) || []).length;
    for (const [, path, mode, content] of prompt.matchAll(/^===== FILE: (.+?) \((may change|read-only)[^)]*\) =====\n([\s\S]*?)\n===== END FILE =====/gm)) {
      if (mode !== 'may change' || this.mode === 'unfixable') continue;
      for (const rule of MOCK_RULES) {
        const lines = content.split('\n');
        const idx = lines.findIndex((l) => l.includes(rule.find));
        if (idx < 0) continue;
        const wrong = this.mode === 'always-wrong' || (this.mode === 'wrong-then-right' && previous === 0);
        const newLine = lines[idx].replace(rule.find, wrong ? rule.wrong : rule.right);
        return usage(JSON.stringify({
          fixable: true,
          root_cause: rule.cause,
          explanation: wrong ? 'Only call the discount branch when percentOff is positive.' : 'Guard against a missing coupon before reading percentOff.',
          changes: [{ path, diff: lineDiff(path, lines, idx, newLine) }],
        }));
      }
    }
    return usage(JSON.stringify({ fixable: false, root_cause: 'The mock AI has no rule for this error.', explanation: 'Mock mode only knows the demo bugs.', changes: [] }));
  }
}

/** Unified diff replacing one line, with 3 lines of context. */
function lineDiff(path, lines, idx, newLine) {
  const a = Math.max(0, idx - 3);
  const b = Math.min(lines.length, idx + 4);
  const body = [];
  for (let i = a; i < b; i++) {
    if (i === idx) body.push('-' + lines[i], '+' + newLine);
    else body.push(' ' + lines[i]);
  }
  return `--- a/${path}\n+++ b/${path}\n@@ -${a + 1},${b - a} +${a + 1},${b - a} @@\n${body.join('\n')}\n`;
}

/** Daily usage (UTC day) and cost cap. */
class UsageTracker {
  constructor({ db, config, clock = { now: () => Date.now() } }) {
    Object.assign(this, { db, ai: config.ai, clock });
  }
  day(ms = this.clock.now()) { return new Date(ms).toISOString().slice(0, 10); }
  record({ provider, model, inputTokens = 0, outputTokens = 0, ok, error = null }) {
    const price = this.ai.prices[provider] || { input: 0, output: 0 };
    const cost = ok ? (inputTokens * price.input + outputTokens * price.output) / 1e6 : 0;
    this.db.prepare('INSERT INTO ai_usage (day, provider, model, input_tokens, output_tokens, cost_usd, ok, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.day(), provider, model || null, inputTokens, outputTokens, cost, ok ? 1 : 0, error, new Date(this.clock.now()).toISOString());
  }
  today() {
    const r = this.db.prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost FROM ai_usage WHERE day = ? AND ok = 1').get(this.day());
    return { calls: r.calls, costUsd: r.cost };
  }
  resumeAt() {
    const d = new Date(this.clock.now());
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  check() {
    const t = this.today();
    if (t.calls >= this.ai.dailyMaxCalls || t.costUsd >= this.ai.dailyMaxCostUsd) throw new CostCapError(t, this.resumeAt());
  }
}

class AIRouter {
  constructor({ providers, usage, logger, malformedRetries = 1, maxTokens = 4096 }) {
    Object.assign(this, { providers, usage, logger, malformedRetries, maxTokens });
  }
  configured() { return this.providers.filter((p) => p.isConfigured()); }

  /**
   * Gets a response that passes validate(text) -> {ok, value} | {ok:false, errors}.
   * Throws CostCapError (stop, don't try others) or AllProvidersFailedError.
   */
  async generate({ system, prompt, validate }) {
    const failures = [];
    for (const p of this.configured()) {
      let messages = [{ role: 'user', content: prompt }];
      for (let i = 0; i <= this.malformedRetries; i++) {
        this.usage.check();
        let res;
        try {
          res = await p.complete({ system, messages, maxTokens: this.maxTokens });
        } catch (err) {
          const reason = this.logger.mask(err.message || String(err));
          this.usage.record({ provider: p.name, ok: false, error: reason });
          failures.push({ provider: p.name, kind: err.kind || 'error', reason });
          this.logger.warn(`AI provider ${p.name} failed, trying the next one: ${reason}`);
          break;
        }
        this.usage.record({ provider: p.name, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, ok: true });
        const v = validate(res.text);
        if (v.ok) return { value: v.value, provider: p.name, model: res.model, failures };
        failures.push({ provider: p.name, kind: 'malformed', reason: `${p.name}: invalid response (${v.errors.slice(0, 3).join('; ')})` });
        this.logger.warn(`AI provider ${p.name} returned an invalid fix: ${v.errors.join('; ')}`);
        messages = [...messages, { role: 'assistant', content: res.text.slice(0, 20000) },
          { role: 'user', content: `Your response was rejected:\n- ${v.errors.join('\n- ')}\nReply again with ONLY the JSON object described in the instructions.` }];
      }
    }
    throw new AllProvidersFailedError(failures);
  }
}

/** Builds provider instances from config, in AI_PROVIDERS order. */
function createProviders(config, { fetch = globalThis.fetch, mockModes = {} } = {}) {
  const a = config.ai;
  const make = {
    claude: () => new ClaudeProvider({ apiKey: a.anthropicKey, model: a.claudeModel, baseUrl: a.anthropicUrl, timeoutMs: a.timeoutMs, fetch }),
    gemini: () => new GeminiProvider({ apiKey: a.geminiKey, model: a.geminiModel, baseUrl: a.geminiUrl, timeoutMs: a.timeoutMs, fetch }),
    ollama: () => new OllamaProvider({ url: a.ollamaUrl, model: a.ollamaModel, timeoutMs: a.timeoutMs, fetch }),
  };
  return a.providers
    .map((n) => (make[n] ? make[n]() : n.startsWith('mock') ? new MockAIProvider({ name: n, mode: mockModes[n] }) : null))
    .filter(Boolean);
}

module.exports = {
  AIProviderError, CostCapError, AllProvidersFailedError, ClaudeProvider, GeminiProvider, OllamaProvider, MockAIProvider,
  UsageTracker, AIRouter, createProviders, lineDiff,
};
