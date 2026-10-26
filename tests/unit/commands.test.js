'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand } = require('../../server/notify/commands');

test('button ids', () => {
  assert.deepEqual(parseCommand('fix:12'), { action: 'fix', id: 12, raw: 'fix:12' });
  assert.equal(parseCommand('merge:3').action, 'merge');
  assert.equal(parseCommand('reject:3').action, 'reject');
  assert.equal(parseCommand('ignore:3').action, 'ignore');
});

test('text commands are case-insensitive, with optional id and #', () => {
  const cases = [
    ['YES 4', 'fix', 4], ['yes', 'fix', null], ['Fix #7', 'fix', 7], ['no 4', 'ignore', 4], ['Ignore 2', 'ignore', 2],
    ['MERGE 9', 'merge', 9], ['merge', 'merge', null], ['reject 9', 'reject', 9], ['rollback 5', 'rollback', 5],
    ['ROLLBACK #5', 'rollback', 5], ['revert 5', 'rollback', 5], ['status 3', 'status', 3], ['help', 'help', null],
    ['  Merge   12.  ', 'merge', 12], ['hi', 'help', null],
  ];
  for (const [input, action, id] of cases) {
    const c = parseCommand(input);
    assert.equal(c.action, action, input);
    assert.equal(c.id, id, input);
  }
});

test('anything else is unknown', () => {
  for (const s of ['', null, undefined, 'what is this', 'no idea what this is', 'merge it please', 'deploy 4']) {
    assert.equal(parseCommand(s).action, 'unknown', String(s));
  }
});
