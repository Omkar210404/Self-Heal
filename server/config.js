'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

/** Loads ROOT/.env into process.env (without overriding variables already set). */
function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return false;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || raw.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

const str = (v, d = '') => (v === undefined || v === null || String(v).trim() === '' ? d : String(v).trim());
const int = (v, d) => {
  const n = Number.parseInt(str(v), 10);
  return Number.isFinite(n) ? n : d;
};
const num = (v, d) => {
  const n = Number.parseFloat(str(v));
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d = false) => {
  const s = str(v).toLowerCase();
  if (!s) return d;
  return ['1', 'true', 'yes', 'on'].includes(s);
};
const list = (v, d = []) => {
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : d;
};
const digits = (v) => str(v).replace(/\D/g, '');

// Values in .env.example look like these; treat them as "not configured".
const PLACEHOLDER = /^(your[-_]|replace[-_]|choose[-_]|xxx)|X{6,}|^changeme$/i;
const secret = (v) => {
  const s = str(v);
  return s && !PLACEHOLDER.test(s) ? s : '';
};

/**
 * Builds the config object from an env map. Pure, so tests can pass their own env.
 * @param {Record<string,string|undefined>} env
 * @param {{mock?: boolean}} [opts]
 */
function loadConfig(env = process.env, opts = {}) {
  const mock = opts.mock ?? bool(env.MOCK_MODE);
  const port = int(env.PORT, 3000);
  const c = {
    root: ROOT,
    mock,
    port,
    host: str(env.HOST, '127.0.0.1'),
    publicUrl: str(env.PUBLIC_URL, `http://localhost:${port}`).replace(/\/+$/, ''),
    dataDir: path.resolve(ROOT, str(env.DATA_DIR, mock ? './data/mock' : './data')),
    logLevel: str(env.LOG_LEVEL, 'info'),

    projectKey: secret(env.PROJECT_KEY),
    allowedOrigins: list(env.ALLOWED_ORIGINS, ['*']),
    ingestRatePerMin: int(env.INGEST_RATE_LIMIT_PER_MIN, 120),
    ingestMaxBodyKb: int(env.INGEST_MAX_BODY_KB, 64),
    demoEnabled: mock || bool(env.DEMO_ENABLED),

    whatsapp: {
      token: secret(env.WHATSAPP_TOKEN),
      phoneNumberId: secret(env.WHATSAPP_PHONE_NUMBER_ID),
      appSecret: secret(env.WHATSAPP_APP_SECRET),
      verifyToken: secret(env.WHATSAPP_VERIFY_TOKEN),
      ownerNumber: PLACEHOLDER.test(str(env.OWNER_WHATSAPP_NUMBER)) ? '' : digits(env.OWNER_WHATSAPP_NUMBER),
      templateName: str(env.WHATSAPP_TEMPLATE_NAME),
      templateLang: str(env.WHATSAPP_TEMPLATE_LANG, 'en'),
      templateHasBodyParam: bool(env.WHATSAPP_TEMPLATE_HAS_BODY_PARAM, true),
      apiVersion: str(env.WHATSAPP_API_VERSION, 'v23.0'),
      graphUrl: str(env.WHATSAPP_GRAPH_URL, 'https://graph.facebook.com'),
      maxAlertsPerHour: int(env.MAX_ALERTS_PER_HOUR, 5),
      sendRetries: int(env.WHATSAPP_SEND_RETRIES, 5),
    },

    ai: {
      providers: list(env.AI_PROVIDERS, ['gemini', 'claude', 'ollama']).map((p) => p.toLowerCase()),
      anthropicKey: secret(env.ANTHROPIC_API_KEY),
      claudeModel: str(env.CLAUDE_MODEL, 'claude-sonnet-5-5'),
      anthropicUrl: str(env.ANTHROPIC_API_URL, 'https://api.anthropic.com'),
      geminiKey: secret(env.GEMINI_API_KEY),
      geminiModel: str(env.GEMINI_MODEL, 'gemini-flash-latest'),
      geminiUrl: str(env.GEMINI_API_URL, 'https://generativelanguage.googleapis.com'),
      ollamaUrl: str(env.OLLAMA_URL, 'http://127.0.0.1:11434'),
      ollamaModel: str(env.OLLAMA_MODEL),
      timeoutMs: int(env.AI_TIMEOUT_MS, 120000),
      maxOutputTokens: int(env.AI_MAX_OUTPUT_TOKENS, 4096),
      malformedRetries: int(env.AI_MALFORMED_RETRIES, 1),
      dailyMaxCostUsd: num(env.AI_DAILY_MAX_COST_USD, 2),
      dailyMaxCalls: int(env.AI_DAILY_MAX_CALLS, 60),
      prices: {
        claude: { input: num(env.CLAUDE_PRICE_INPUT_PER_MTOK, 3), output: num(env.CLAUDE_PRICE_OUTPUT_PER_MTOK, 15) },
        gemini: { input: num(env.GEMINI_PRICE_INPUT_PER_MTOK, 1.5), output: num(env.GEMINI_PRICE_OUTPUT_PER_MTOK, 7.5) },
        ollama: { input: num(env.OLLAMA_PRICE_INPUT_PER_MTOK, 0), output: num(env.OLLAMA_PRICE_OUTPUT_PER_MTOK, 0) },
      },
    },

    fix: {
      maxAttempts: Math.max(1, int(env.FIX_MAX_ATTEMPTS, 3)),
      maxFiles: int(env.FIX_MAX_FILES, 3),
      maxLines: int(env.FIX_MAX_LINES, 80),
      contextTokenBudget: int(env.CONTEXT_TOKEN_BUDGET, 12000),
      denylist: list(env.DENYLIST),
      readonly: list(env.READONLY_PATHS),
      pathPrefixes: list(env.REPO_PATH_PREFIXES, ['public/', 'src/', 'static/', 'app/']),
    },

    github: {
      token: secret(env.GITHUB_TOKEN),
      repo: PLACEHOLDER.test(str(env.GITHUB_REPO)) ? '' : str(env.GITHUB_REPO),
      baseBranch: str(env.GITHUB_BASE_BRANCH),
      apiUrl: str(env.GITHUB_API_URL, 'https://api.github.com').replace(/\/+$/, ''),
      mergeMethod: ['squash', 'merge', 'rebase'].includes(str(env.MERGE_METHOD)) ? str(env.MERGE_METHOD) : 'squash',
      authorName: str(env.GIT_AUTHOR_NAME, 'selfheal-bot'),
      authorEmail: str(env.GIT_AUTHOR_EMAIL, 'selfheal-bot@users.noreply.github.com'),
      testCommand: env.TEST_COMMAND === undefined ? 'npm test' : str(env.TEST_COMMAND),
      installCommand: str(env.INSTALL_COMMAND),
      testTimeoutMs: int(env.TEST_TIMEOUT_MS, 300000),
      mergeablePollMs: int(env.MERGEABLE_POLL_MS, 2000),
      mergeablePollTries: int(env.MERGEABLE_POLL_TRIES, 8),
    },

    dashboard: {
      password: secret(env.DASHBOARD_PASSWORD),
      sessionSecret: secret(env.SESSION_SECRET) || crypto.randomBytes(32).toString('hex'),
    },

    queue: {
      pollMs: int(env.QUEUE_POLL_MS, 500),
      backoffMs: int(env.QUEUE_BACKOFF_MS, 2000),
      sweepMs: int(env.SWEEP_INTERVAL_MS, 5 * 60 * 1000),
    },
  };

  if (mock) applyMockDefaults(c);
  return c;
}

/** Mock mode needs no real keys: generate throwaway values so everything works locally. */
function applyMockDefaults(c) {
  const rand = () => crypto.randomBytes(16).toString('hex');
  c.projectKey ||= 'mock-' + rand();
  c.whatsapp.token = 'mock-token';
  c.whatsapp.phoneNumberId = 'mock-phone-id';
  c.whatsapp.appSecret = 'mock-app-secret-' + rand();
  c.whatsapp.verifyToken ||= 'mock-verify-' + rand();
  // Fake owner id for the simulated phone (not a phone number; mock only).
  c.whatsapp.ownerNumber = '10000000000001';
  c.whatsapp.templateName ||= 'selfheal_alert';
  c.ai.providers = ['mock-primary', 'mock-secondary'];
  c.github.repo = 'mock/demo-site';
  c.github.testCommand = c.github.testCommand || 'npm test';
  c.dashboard.password ||= 'mock-' + crypto.randomBytes(4).toString('hex');
  c.dashboard.generatedPassword = true;
}

/** Returns a list of human-readable problems that block startup in real mode. */
function validateConfig(c, { configuredAiProviders = [] } = {}) {
  const problems = [];
  if (c.mock) return problems;
  const need = (ok, msg) => { if (!ok) problems.push(msg); };
  need(c.projectKey && c.projectKey.length >= 16, 'PROJECT_KEY must be set to a random string of at least 16 characters');
  need(c.whatsapp.token, 'WHATSAPP_TOKEN is missing');
  need(c.whatsapp.phoneNumberId, 'WHATSAPP_PHONE_NUMBER_ID is missing');
  need(c.whatsapp.appSecret, 'WHATSAPP_APP_SECRET is missing (needed to verify webhook signatures)');
  need(c.whatsapp.verifyToken, 'WHATSAPP_VERIFY_TOKEN is missing');
  need(c.whatsapp.ownerNumber && c.whatsapp.ownerNumber.length >= 8, 'OWNER_WHATSAPP_NUMBER is missing (international format, digits only)');
  need(c.github.token, 'GITHUB_TOKEN is missing');
  need(/^[\w.-]+\/[\w.-]+$/.test(c.github.repo), 'GITHUB_REPO must look like owner/name');
  need(c.dashboard.password && c.dashboard.password.length >= 8, 'DASHBOARD_PASSWORD must be at least 8 characters');
  if (!configuredAiProviders.length) {
    problems.push(
      `No AI provider is configured. AI_PROVIDERS=${c.ai.providers.join(',')} but none has what it needs. ` +
        'Set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OLLAMA_MODEL (with Ollama running).'
    );
  }
  if (!c.whatsapp.templateName) problems.push('WHATSAPP_TEMPLATE_NAME is missing (needed when the 24-hour window is closed)');
  return problems;
}

/** All secret values, used by the logger and redactor to mask them. */
function secretValues(c) {
  return [
    c.projectKey,
    c.whatsapp.token,
    c.whatsapp.appSecret,
    c.whatsapp.verifyToken,
    c.whatsapp.ownerNumber,
    c.ai.anthropicKey,
    c.ai.geminiKey,
    c.github.token,
    c.dashboard.password,
    c.dashboard.sessionSecret,
  ].filter((v) => v && v.length >= 6);
}

/** Config for display in the dashboard: secrets masked. */
function maskedConfig(c) {
  const m = (v) => (v ? (v.length > 8 ? `${'•'.repeat(6)}${v.slice(-2)}` : '•'.repeat(6)) : '(not set)');
  const phone = (v) => (v ? `${'•'.repeat(Math.max(0, v.length - 2))}${v.slice(-2)}` : '(not set)');
  return {
    General: {
      'Mock mode': c.mock ? 'ON' : 'off',
      'Public URL': c.publicUrl,
      Listen: `${c.host}:${c.port}`,
      'Data dir': c.dataDir,
      'Demo site': c.demoEnabled ? 'enabled' : 'disabled',
    },
    Ingestion: {
      PROJECT_KEY: m(c.projectKey),
      'Allowed origins': c.allowedOrigins.join(', '),
      'Rate limit / min / IP': c.ingestRatePerMin,
      'Max body KB': c.ingestMaxBodyKb,
    },
    WhatsApp: {
      WHATSAPP_TOKEN: m(c.whatsapp.token),
      WHATSAPP_PHONE_NUMBER_ID: m(c.whatsapp.phoneNumberId),
      WHATSAPP_APP_SECRET: m(c.whatsapp.appSecret),
      WHATSAPP_VERIFY_TOKEN: m(c.whatsapp.verifyToken),
      OWNER_WHATSAPP_NUMBER: phone(c.whatsapp.ownerNumber),
      Template: `${c.whatsapp.templateName || '(not set)'} (${c.whatsapp.templateLang})`,
      'Max alerts / hour': c.whatsapp.maxAlertsPerHour,
      'Graph API version': c.whatsapp.apiVersion,
    },
    AI: {
      'Provider order': c.ai.providers.join(' → '),
      ANTHROPIC_API_KEY: m(c.ai.anthropicKey),
      'Claude model': c.ai.claudeModel,
      GEMINI_API_KEY: m(c.ai.geminiKey),
      'Gemini model': c.ai.geminiModel,
      'Ollama': c.ai.ollamaModel ? `${c.ai.ollamaModel} @ ${c.ai.ollamaUrl}` : '(disabled)',
      'Daily cost cap (USD)': c.ai.dailyMaxCostUsd,
      'Daily call cap': c.ai.dailyMaxCalls,
    },
    'Fix limits': {
      'Max attempts': c.fix.maxAttempts,
      'Max files per fix': c.fix.maxFiles,
      'Max changed lines per fix': c.fix.maxLines,
      'Context token budget': c.fix.contextTokenBudget,
      'Extra denylist': c.fix.denylist.join(', ') || '(none)',
      'Extra read-only': c.fix.readonly.join(', ') || '(none)',
    },
    GitHub: {
      GITHUB_TOKEN: m(c.github.token),
      Repository: c.github.repo || '(not set)',
      'Base branch': c.github.baseBranch || '(repo default)',
      'Merge method': c.github.mergeMethod,
      'Test command': c.github.testCommand || '(none: PRs marked UNTESTED)',
      'Install command': c.github.installCommand || '(none)',
    },
    Dashboard: {
      DASHBOARD_PASSWORD: m(c.dashboard.password),
    },
  };
}

module.exports = { loadConfig, loadDotEnv, validateConfig, secretValues, maskedConfig, ROOT };
