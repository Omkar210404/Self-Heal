'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GitHubHost, MockGitHubHost, TokenAuth, Workspace, runCommand, sandboxEnv } = require('../../server/repo');
const { loadConfig } = require('../../server/config');
const { memDb, tmpDir, rmrf, jsonResponse, stubFetch } = require('../helpers');

const TOKEN = 'test-gh-token-value';
const host = (fetch) => new GitHubHost({ repo: 'me/site', auth: new TokenAuth(TOKEN), fetch, pollMs: 1, pollTries: 3 });

test('GitHub: opens PRs, polls mergeability, merges with the head sha', async () => {
  const f = stubFetch(
    jsonResponse(201, { number: 7, html_url: 'https://github.com/me/site/pull/7' }),
    jsonResponse(200, { state: 'open', mergeable: null, head: { sha: 'abc' } }),
    jsonResponse(200, { state: 'open', mergeable: true, head: { sha: 'abc' }, html_url: 'u' }),
    jsonResponse(200, { sha: 'merged123', merged: true }),
  );
  const h = host(f);
  assert.deepEqual(await h.openPullRequest({ head: 'selfheal/issue-1', base: 'main', title: 't', body: 'b' }), { number: 7, url: 'https://github.com/me/site/pull/7' });
  const pr = await h.getPullRequest(7);
  assert.equal(pr.mergeable, true);
  assert.equal(f.calls.length, 3, 'polled until mergeable was computed');
  assert.deepEqual(await h.mergePullRequest(7, { sha: pr.headSha, method: 'squash' }), { sha: 'merged123' });
  assert.deepEqual(f.calls[3].body, { merge_method: 'squash', sha: 'abc' });
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/me/site/pulls');
});

test('GitHub: helpful errors, branch guard, token only in env (never in args or URL)', async () => {
  await assert.rejects(host(stubFetch(jsonResponse(403, { message: 'Resource not accessible' }))).getDefaultBranch(), /Pull requests: read\/write/);
  await assert.rejects(host(stubFetch(jsonResponse(204, null))).deleteBranch('main'), /only selfheal\/\* branches/);
  const h = host(stubFetch(jsonResponse(404, {})));
  assert.equal(await h.branchExists('selfheal/x'), false);
  assert.ok(!(await h.remoteUrl()).includes(TOKEN));
  const env = await h.gitEnv();
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.ok(Buffer.from(env.GIT_CONFIG_VALUE_0.split(' ').pop(), 'base64').toString().endsWith(TOKEN));
});

test('test commands run with a minimal env and a timeout', async () => {
  process.env.SELFHEAL_TEST_SECRET = 'should-not-leak';
  try {
    assert.equal(sandboxEnv().SELFHEAL_TEST_SECRET, undefined);
  } finally {
    delete process.env.SELFHEAL_TEST_SECRET;
  }
  const ok = await runCommand('node -e "console.log(42)"', { cwd: process.cwd(), timeoutMs: 10000 });
  assert.deepEqual([ok.passed, ok.output.trim()], [true, '42']);
  const slow = await runCommand('node -e "setTimeout(()=>{},10000)"', { cwd: process.cwd(), timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.passed, false);
});

test('mock GitHub: clone, push branch, PR, conflict detection, squash merge, file read', async () => {
  const dir = tmpDir();
  try {
    const config = loadConfig({ DATA_DIR: dir }, { mock: true });
    const h = new MockGitHubHost({ dataDir: dir, db: memDb(), seedDir: path.join(__dirname, '../../demo/site'), publicUrl: 'http://x' });
    await h.init();
    const ws = await Workspace.clone({ host: h, base: 'main', config });
    assert.ok(ws.listFiles().includes('cart.js'));
    assert.equal(ws.hasTests(), true);
    ws.write('cart.js', ws.read('cart.js').replace('if (coupon.percentOff)', 'if (coupon && coupon.percentOff)'));
    assert.equal((await ws.runTests()).passed, true, "the demo repo's own tests pass after the fix");
    await assert.rejects(ws.commitAndPush('main', 'x', ['cart.js']), /only selfheal\/\* branches/);
    await ws.commitAndPush('selfheal/issue-1', 'fix', ['cart.js']);
    ws.cleanup();
    const pr = await h.openPullRequest({ head: 'selfheal/issue-1', base: 'main', title: 'fix', body: '' });
    assert.equal((await h.getPullRequest(pr.number)).mergeable, true);

    await h.pushToBase('cart.js', 'conflicting change\n');
    assert.equal((await h.getPullRequest(pr.number)).mergeable, false);
    await assert.rejects(h.mergePullRequest(pr.number), /merge conflict/);
    rmrf(path.join(dir, 'mock-remote.git'));
    fs.rmSync(path.join(dir, 'mock-remote.git'), { recursive: true, force: true });
  } finally {
    rmrf(dir);
  }
});
