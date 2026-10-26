'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, validateConfig, secretValues, maskedConfig, loadDotEnv } = require('../../server/config');
const { tmpDir, rmrf, FAKE_OWNER } = require('../helpers');

const REAL = {
  NOTIFY_CHANNEL: 'whatsapp',
  PROJECT_KEY: 'k'.repeat(24),
  WHATSAPP_TOKEN: 'wa-tok-'.padEnd(30, 'z'),
  WHATSAPP_PHONE_NUMBER_ID: 'pid-1',
  WHATSAPP_APP_SECRET: 'app-secret-zz',
  WHATSAPP_VERIFY_TOKEN: 'verify-zz',
  OWNER_WHATSAPP_NUMBER: `+${FAKE_OWNER}`,
  WHATSAPP_TEMPLATE_NAME: 'selfheal_alert',
  GITHUB_TOKEN: 'gh-tok-zzzzzzzz',
  GITHUB_REPO: 'someone/site',
  DASHBOARD_PASSWORD: 'long-enough-pw',
};

test('defaults and parsing', () => {
  const c = loadConfig({ ...REAL, PORT: '4000', FIX_MAX_FILES: '2', AI_PROVIDERS: 'Claude, gemini', MERGE_METHOD: 'weird' });
  assert.equal(c.port, 4000);
  assert.equal(c.fix.maxFiles, 2);
  assert.deepEqual(c.ai.providers, ['claude', 'gemini']);
  assert.equal(c.github.mergeMethod, 'squash', 'invalid merge method falls back');
  assert.equal(c.whatsapp.ownerNumber, FAKE_OWNER, 'owner number normalized to digits');
  assert.equal(c.github.testCommand, 'npm test');
  assert.equal(c.mock, false);
});

test('empty TEST_COMMAND means the repo has no tests', () => {
  assert.equal(loadConfig({ TEST_COMMAND: '' }).github.testCommand, '');
});

test('placeholder values from .env.example count as not configured', () => {
  const c = loadConfig({ WHATSAPP_TOKEN: 'your-whatsapp-access-token', OWNER_WHATSAPP_NUMBER: '91XXXXXXXXXX', GITHUB_REPO: 'your-github-user/your-site-repo' });
  assert.equal(c.whatsapp.token, '');
  assert.equal(c.whatsapp.ownerNumber, '');
  assert.equal(c.github.repo, '');
});

test('validateConfig lists every missing piece in real mode', () => {
  const emailProblems = validateConfig(loadConfig({}), { configuredAiProviders: [] }).join('\n');
  for (const k of ['OWNER_EMAIL', 'SMTP_USER', 'SMTP_PASS', 'PROJECT_KEY', 'DASHBOARD_PASSWORD']) assert.ok(emailProblems.includes(k), k);
  assert.ok(!emailProblems.includes('GITHUB_TOKEN'), 'no GitHub token = local test repo');
  assert.equal(loadConfig({}).repoMode, 'local');
  const problems = validateConfig(loadConfig({ NOTIFY_CHANNEL: 'whatsapp', GITHUB_REPO: 'not-a-repo' }), { configuredAiProviders: [] });
  const text = problems.join('\n');
  for (const k of ['PROJECT_KEY', 'WHATSAPP_TOKEN', 'WHATSAPP_APP_SECRET', 'OWNER_WHATSAPP_NUMBER', 'GITHUB_TOKEN', 'GITHUB_REPO', 'DASHBOARD_PASSWORD', 'No AI provider']) {
    assert.ok(text.includes(k), `mentions ${k}`);
  }
  assert.deepEqual(validateConfig(loadConfig(REAL), { configuredAiProviders: ['claude'] }), []);
});

test('mock mode needs no keys', () => {
  const c = loadConfig({}, { mock: true });
  assert.equal(c.mock, true);
  assert.deepEqual(validateConfig(c), []);
  assert.ok(c.projectKey.startsWith('mock-'));
  assert.deepEqual(c.ai.providers, ['mock-primary', 'mock-secondary']);
  assert.ok(c.demoEnabled);
});

test('secretValues and maskedConfig never expose secrets', () => {
  const c = loadConfig(REAL);
  const secrets = secretValues(c);
  assert.ok(secrets.includes(REAL.WHATSAPP_TOKEN));
  assert.ok(secrets.includes(FAKE_OWNER));
  const shown = JSON.stringify(maskedConfig(c));
  for (const v of secrets) assert.ok(!shown.includes(v), 'secret not shown');
  assert.ok(shown.includes(FAKE_OWNER.slice(-2)), 'last two digits of the number are shown');
});

test('loadDotEnv reads quoted values and comments without overriding the environment', () => {
  const dir = tmpDir();
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '# comment\nSH_TEST_A="quoted value"\nSH_TEST_B=plain # trailing\nSH_TEST_C=keep\n');
  process.env.SH_TEST_C = 'already-set';
  try {
    assert.equal(loadDotEnv(file), true);
    assert.equal(process.env.SH_TEST_A, 'quoted value');
    assert.equal(process.env.SH_TEST_B, 'plain');
    assert.equal(process.env.SH_TEST_C, 'already-set');
  } finally {
    delete process.env.SH_TEST_A; delete process.env.SH_TEST_B; delete process.env.SH_TEST_C;
    rmrf(dir);
  }
  assert.equal(loadDotEnv(path.join(dir, 'missing.env')), false);
});
