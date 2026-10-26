'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JobQueue, PermanentError } = require('../../server/queue');
const { openDb } = require('../../server/db');
const { memDb, memLogger, fakeClock, tmpDir, rmrf } = require('../helpers');

function q(db = memDb(), clock = fakeClock()) {
  return { clock, db, queue: new JobQueue({ db, logger: memLogger(), clock, backoffMs: 1000 }) };
}

test('runs jobs and marks them done', async () => {
  const { queue } = q();
  const seen = [];
  queue.register('hello', async (p) => seen.push(p.n));
  queue.enqueue('hello', { n: 1 });
  queue.enqueue('hello', { n: 2 });
  assert.equal(await queue.drain(), 2);
  assert.deepEqual(seen, [1, 2]);
  assert.ok(queue.list().every((j) => j.status === 'done'));
});

test('dedupeKey prevents duplicate jobs forever', async () => {
  const { queue } = q();
  let runs = 0;
  queue.register('alert', async () => runs++);
  assert.equal(queue.enqueue('alert', {}, { dedupeKey: 'alert:1' }).created, true);
  assert.equal(queue.enqueue('alert', {}, { dedupeKey: 'alert:1' }).created, false);
  await queue.drain();
  assert.equal(queue.enqueue('alert', {}, { dedupeKey: 'alert:1' }).created, false, 'even after it ran');
  await queue.drain();
  assert.equal(runs, 1);
});

test('retries with exponential backoff, then calls onFail', async () => {
  const { queue, clock } = q();
  let tries = 0;
  const failed = [];
  queue.register('flaky', async () => { tries++; throw new Error('nope'); }, { maxAttempts: 3, onFail: (p, err) => failed.push([p, err.message]) });
  const { job } = queue.enqueue('flaky', { x: 1 });
  await queue.drain();
  assert.equal(tries, 1);
  assert.equal(queue.get(job.id).status, 'queued');
  clock.advance(999);
  assert.equal(await queue.drain(), 0, 'not yet: backoff 1s');
  clock.advance(1);
  await queue.drain();
  assert.equal(tries, 2);
  clock.advance(1999);
  assert.equal(await queue.drain(), 0, 'backoff doubled to 2s');
  clock.advance(1);
  await queue.drain();
  assert.equal(tries, 3);
  assert.equal(queue.get(job.id).status, 'failed');
  assert.equal(queue.get(job.id).last_error, 'nope');
  assert.deepEqual(failed, [[{ x: 1 }, 'nope']]);
});

test('PermanentError skips retries', async () => {
  const { queue } = q();
  let fails = 0;
  queue.register('perm', async () => { throw new PermanentError('bad input'); }, { maxAttempts: 5, onFail: () => fails++ });
  queue.enqueue('perm', {});
  await queue.drain();
  assert.equal(fails, 1);
});

test('a handler can defer itself without using up attempts', async () => {
  const { queue, clock } = q();
  let runs = 0;
  queue.register('later', async () => { runs++; if (runs === 1) return { defer: clock.now() + 5000, reason: 'paused' }; return null; }, { maxAttempts: 1 });
  const { job } = queue.enqueue('later', {});
  await queue.drain();
  assert.equal(queue.get(job.id).status, 'queued');
  assert.equal(queue.get(job.id).attempts, 0);
  assert.equal(queue.get(job.id).last_error, 'paused');
  clock.advance(5000);
  await queue.drain();
  assert.equal(runs, 2);
  assert.equal(queue.get(job.id).status, 'done');
});

test('jobs survive a restart: running jobs are resumed', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'q.db');
  try {
    const db1 = openDb(file);
    const { queue: q1 } = q(db1);
    q1.register('work', async () => {});
    const { job } = q1.enqueue('work', { n: 7 });
    q1.claim('default'); // simulate a crash mid-job
    assert.equal(q1.get(job.id).status, 'running');
    db1.close();

    const db2 = openDb(file);
    const done = [];
    const q2 = new JobQueue({ db: db2, logger: memLogger(), pollMs: 10 });
    q2.register('work', async (p) => done.push(p.n));
    q2.start();
    for (let i = 0; i < 50 && !done.length; i++) await new Promise((r) => setTimeout(r, 10));
    await q2.stop();
    assert.deepEqual(done, [7]);
    assert.equal(q2.get(job.id).status, 'done');
    db2.close();
  } finally {
    rmrf(dir);
  }
});

test('lanes run independently: a slow job does not block another lane', async () => {
  const db = memDb();
  const queue = new JobQueue({ db, logger: memLogger(), pollMs: 5 });
  const order = [];
  let release;
  queue.register('slow', () => new Promise((r) => { release = r; }).then(() => order.push('slow')), { lane: 'fix' });
  queue.register('fast', async () => order.push('fast'), { lane: 'notify' });
  queue.start();
  queue.enqueue('slow', {});
  await new Promise((r) => setTimeout(r, 20));
  queue.enqueue('fast', {});
  for (let i = 0; i < 50 && !order.includes('fast'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ['fast']);
  release();
  for (let i = 0; i < 50 && order.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  await queue.stop();
  assert.deepEqual(order, ['fast', 'slow']);
});

test('active() finds pending jobs by payload', () => {
  const { queue } = q();
  queue.register('fix', async () => {});
  queue.enqueue('fix', { issueId: 3 });
  assert.equal(queue.active('fix', { issueId: 3 }).length, 1);
  assert.equal(queue.active('fix', { issueId: 4 }).length, 0);
  assert.throws(() => queue.enqueue('nope', {}), /Unknown job type/);
});
