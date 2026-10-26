'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, maskPhone } = require('../../server/logger');
const { FAKE_OWNER } = require('../helpers');

test('masks known secrets, token patterns and phone numbers', () => {
  const lines = [];
  const secret = 'test-secret-value-123';
  const log = createLogger({ level: 'debug', secrets: [secret], sink: (l) => lines.push(l) });
  const gh = 'gh' + 'p_' + 'A'.repeat(36);
  const ant = 'sk-' + 'ant-' + 'B'.repeat(30);
  log.info(`sending to ${FAKE_OWNER} with ${secret}`, { auth: `Bearer ${'C'.repeat(40)}`, gh, ant, url: 'https://x/api?key=abc123def&y=1' });
  const out = lines.join('\n');
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes(FAKE_OWNER));
  assert.ok(out.includes('•'.repeat(FAKE_OWNER.length - 2) + FAKE_OWNER.slice(-2)));
  assert.ok(!out.includes(gh));
  assert.ok(!out.includes(ant));
  assert.ok(!out.includes('C'.repeat(40)));
  assert.ok(out.includes('Bearer ***'));
  assert.ok(out.includes('key=***'));
});

test('leaves dates, times and small numbers alone', () => {
  assert.equal(maskPhone('2026-10-26T10:00:00Z line 42 of 1234567'), '2026-10-26T10:00:00Z line 42 of 1234567');
  const intl = '+' + '44 ' + '7700 ' + '900' + '123';
  assert.equal(maskPhone(intl), '•'.repeat(10) + '23');
});

test('respects level and never throws on odd input', () => {
  const lines = [];
  const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
  log.info('hidden');
  const circular = {}; circular.self = circular;
  assert.doesNotThrow(() => log.error('odd', circular));
  log.warn('shown', new Error('boom'));
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('Error: boom'));
});

test('addSecrets masks values learned later', () => {
  const lines = [];
  const log = createLogger({ sink: (l) => lines.push(l) });
  log.addSecrets(['learned-secret-x']);
  log.info('value learned-secret-x');
  assert.ok(!lines[0].includes('learned-secret-x'));
});
