'use strict';
/*
 * Repository access.
 * - Workspace: a temporary clone where fixes are applied and the repo's own tests run
 *   (with a minimal environment: none of selfheal's secrets are visible to the repo's code).
 * - GitHubHost: GitHub REST API with a fine-grained token. Auth goes through `auth.getToken()`
 *   so a GitHub App installation token can replace it later.
 * - MockGitHubHost: same interface on top of a local bare git repo, for mock mode and tests.
 * Rules: never push to the base branch, never force-push, only delete selfheal/* branches.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function git(args, { cwd, env = {}, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !allowFail) return reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim().slice(0, 1000)}`));
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Env for the repo's install/test commands: nothing from selfheal's own environment except basics. */
function sandboxEnv() {
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramData', 'LANG'];
  const env = { CI: 'true', NODE_ENV: 'test', FORCE_COLOR: '0' };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/** Runs a shell command with a timeout; output is capped to the last 64 KB. */
function runCommand(command, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, env: sandboxEnv(), windowsHide: true, detached: process.platform !== 'win32' });
    let out = '';
    const add = (d) => { out = (out + d).slice(-64 * 1024); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* already gone */ }
    }, timeoutMs);
    const done = (code) => {
      clearTimeout(timer);
      resolve({ passed: code === 0 && !timedOut, exitCode: code, timedOut, output: timedOut ? `${out}\n[timed out after ${timeoutMs}ms]` : out, durationMs: Date.now() - started });
    };
    child.on('error', (err) => { add(String(err.message)); done(-1); });
    child.on('close', done);
  });
}

function testSummary(output) {
  const pick = (re) => output.match(re)?.[0];
  return pick(/# pass \d+[\s\S]*?# fail \d+/)?.replace(/\s+/g, ' ') || pick(/Tests?:\s+.*\d+ passed.*/) || pick(/\d+ passing.*/) || pick(/\d+ passed.*/) || 'exit code 0';
}

class Workspace {
  constructor({ dir, host, config }) {
    Object.assign(this, { dir, host, config, gh: config.github });
  }

  static async clone({ host, base, config }) {
    const root = path.join(config.dataDir, 'work');
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, 'clone-'));
    const url = await host.remoteUrl();
    const shallow = /^https?:/.test(url) ? ['--depth', '50'] : [];
    try {
      await git(['clone', '--quiet', '--no-tags', ...shallow, '--branch', base, '--single-branch', url, dir], { env: await host.gitEnv() });
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`Could not clone the repository: ${err.message}`);
    }
    return new Workspace({ dir, host, config });
  }

  abs(p) { return path.join(this.dir, ...p.split('/')); }
  listFiles() {
    // Sync on purpose: context gathering is synchronous.
    return require('node:child_process').execFileSync('git', ['ls-files', '-z'], { cwd: this.dir, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
  }
  read(p) { try { return fs.readFileSync(this.abs(p), 'utf8'); } catch { return null; } }
  write(p, content) { fs.mkdirSync(path.dirname(this.abs(p)), { recursive: true }); fs.writeFileSync(this.abs(p), content); }
  async reset() { await git(['checkout', '--', '.'], { cwd: this.dir }); }

  hasTests() {
    const cmd = this.gh.testCommand;
    if (!cmd) return false;
    if (/^(npm|yarn|pnpm)( run)? test\b/.test(cmd)) {
      try {
        const t = JSON.parse(this.read('package.json') || '{}').scripts?.test;
        return !!t && !/no test specified/.test(t);
      } catch { return false; }
    }
    return true;
  }

  async install() {
    if (!this.gh.installCommand) return;
    const r = await runCommand(this.gh.installCommand, { cwd: this.dir, timeoutMs: this.gh.testTimeoutMs });
    if (!r.passed) throw new Error(`Install command "${this.gh.installCommand}" failed:\n${r.output.slice(-2000)}`);
  }

  async runTests() {
    const r = await runCommand(this.gh.testCommand, { cwd: this.dir, timeoutMs: this.gh.testTimeoutMs });
    return { ...r, summary: r.passed ? testSummary(r.output) : `failed (exit ${r.exitCode})` };
  }

  author() { return ['-c', `user.name=${this.gh.authorName}`, '-c', `user.email=${this.gh.authorEmail}`]; }

  /** Commits the given files on a new branch and pushes it (never to the base branch, never forced). */
  async commitAndPush(branch, message, files) {
    if (!branch.startsWith('selfheal/')) throw new Error(`Refusing to push to ${branch}: only selfheal/* branches are allowed`);
    await git(['checkout', '-q', '-b', branch], { cwd: this.dir });
    await git(['add', '--', ...files], { cwd: this.dir });
    await git([...this.author(), 'commit', '-q', '-m', message], { cwd: this.dir });
    await git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: this.dir, env: await this.host.gitEnv() });
    return (await git(['rev-parse', 'HEAD'], { cwd: this.dir })).stdout.trim();
  }

  /** Reverts a merged commit on a new branch. Throws if the revert conflicts. */
  async revertOnBranch(sha, branch, message) {
    await git(['checkout', '-q', '-b', branch], { cwd: this.dir });
    const parents = (await git(['rev-list', '--parents', '-n', '1', sha], { cwd: this.dir })).stdout.trim().split(' ').length - 1;
    const r = await git([...this.author(), 'revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), sha], { cwd: this.dir, allowFail: true });
    if (!r.ok) {
      await git(['revert', '--abort'], { cwd: this.dir, allowFail: true });
      throw new Error(`The revert conflicts with later changes on the base branch: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
    await git([...this.author(), 'commit', '--amend', '-q', '-m', message], { cwd: this.dir });
    await git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: this.dir, env: await this.host.gitEnv() });
  }

  cleanup() {
    try { fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp dir, best effort */ }
  }
}

/** Fine-grained personal access token. A GitHub App would implement the same getToken(). */
class TokenAuth {
  constructor(token) { this.token = token; }
  async getToken() { return this.token; }
}

class GitHubHost {
  constructor({ repo, apiUrl = 'https://api.github.com', auth, fetch = globalThis.fetch, pollMs = 2000, pollTries = 8 }) {
    Object.assign(this, { name: 'github', repo, apiUrl, auth, fetch, pollMs, pollTries });
    this.webUrl = apiUrl === 'https://api.github.com' ? 'https://github.com' : apiUrl.replace(/\/api\/v3\/?$/, '');
  }

  async api(method, route, body) {
    let res;
    try {
      res = await this.fetch(`${this.apiUrl}/repos/${this.repo}${route}`, {
        method,
        headers: { Authorization: `Bearer ${await this.auth.getToken()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'selfheal', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw new GitHubError(`GitHub unreachable: ${err.message}`, 0);
    }
    if (res.status === 204) return null;
    let j = null;
    try { j = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const hints = {
        401: ' (GITHUB_TOKEN is invalid or expired)',
        403: ' (the token needs Contents: read/write and Pull requests: read/write on this repository)',
        404: ` (repository ${this.repo} not found, or the token has no access to it)`,
      };
      throw new GitHubError(`GitHub ${method} ${route} failed: ${res.status} ${j?.message || ''}${hints[res.status] || ''}`, res.status);
    }
    return j;
  }

  async remoteUrl() { return `${this.webUrl}/${this.repo}.git`; }
  async gitEnv() {
    const basic = Buffer.from(`x-access-token:${await this.auth.getToken()}`).toString('base64');
    // Passed via env so the token is never on a command line or written to .git/config.
    return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${this.webUrl}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
  }
  async getDefaultBranch() { return (await this.api('GET', '')).default_branch; }
  async branchExists(branch) {
    try { await this.api('GET', `/branches/${encodeURIComponent(branch)}`); return true; } catch (e) { if (e.status === 404) return false; throw e; }
  }
  async openPullRequest({ head, base, title, body }) {
    const j = await this.api('POST', '/pulls', { head, base, title, body, maintainer_can_modify: false });
    return { number: j.number, url: j.html_url };
  }
  /** Polls until GitHub has computed mergeability (or gives up with mergeable: null). */
  async getPullRequest(number) {
    let j;
    for (let i = 0; i < this.pollTries; i++) {
      j = await this.api('GET', `/pulls/${number}`);
      if (j.state !== 'open' || j.mergeable !== null) break;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    return { number, state: j.state, merged: !!j.merged, mergeable: j.mergeable, mergeableState: j.mergeable_state, headSha: j.head?.sha, mergeCommitSha: j.merge_commit_sha, url: j.html_url };
  }
  async mergePullRequest(number, { sha, method = 'squash', title }) {
    const j = await this.api('PUT', `/pulls/${number}/merge`, { merge_method: method, sha, commit_title: title });
    return { sha: j.sha };
  }
  async closePullRequest(number) { await this.api('PATCH', `/pulls/${number}`, { state: 'closed' }); }
  async deleteBranch(branch) {
    if (!branch?.startsWith('selfheal/')) throw new Error(`Refusing to delete ${branch}: only selfheal/* branches are deleted`);
    await this.api('DELETE', `/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
  }
}

/** Mock GitHub: a local bare repo (seeded from demo/site) + PRs stored in SQLite. Merges are real git merges. */
class MockGitHubHost {
  constructor({ dataDir, db, seedDir, publicUrl }) {
    Object.assign(this, { name: 'mock-github', db, seedDir, publicUrl, bare: path.join(dataDir, 'mock-remote.git'), tmpRoot: path.join(dataDir, 'work') });
    db.exec(`CREATE TABLE IF NOT EXISTS mock_prs (number INTEGER PRIMARY KEY AUTOINCREMENT, head TEXT, base TEXT, title TEXT, body TEXT,
      state TEXT DEFAULT 'open', merged INTEGER DEFAULT 0, merge_sha TEXT, created_at TEXT)`);
  }

  async init() {
    if (fs.existsSync(path.join(this.bare, 'HEAD'))) return;
    fs.mkdirSync(this.bare, { recursive: true });
    await git(['init', '--quiet', '--bare', '-b', 'main', this.bare]);
    const dir = this.tmp();
    await git(['init', '--quiet', '-b', 'main', dir]);
    fs.cpSync(this.seedDir, dir, { recursive: true, filter: (s) => !s.includes('node_modules') });
    await git(['add', '-A'], { cwd: dir });
    await git(['-c', 'user.name=demo', '-c', 'user.email=demo@localhost', 'commit', '-q', '-m', 'Initial demo site'], { cwd: dir });
    await git(['push', '-q', this.bare, 'main'], { cwd: dir });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  tmp() { fs.mkdirSync(this.tmpRoot, { recursive: true }); return fs.mkdtempSync(path.join(this.tmpRoot, 'mock-')); }
  async remoteUrl() { return this.bare; }
  async gitEnv() { return {}; }
  async getDefaultBranch() { return 'main'; }
  async branchExists(b) { return (await git(['--git-dir', this.bare, 'rev-parse', '--verify', '-q', `refs/heads/${b}`], { allowFail: true })).ok; }
  pr(n) { return this.db.prepare('SELECT * FROM mock_prs WHERE number = ?').get(n); }
  url(n) { return `${this.publicUrl}/dashboard/mock/prs/${n}`; }

  async openPullRequest({ head, base, title, body }) {
    if (!(await this.branchExists(head))) throw new GitHubError(`Branch ${head} does not exist`, 422);
    const info = this.db.prepare('INSERT INTO mock_prs (head, base, title, body, created_at) VALUES (?, ?, ?, ?, ?)').run(head, base, title, body, new Date().toISOString());
    const number = Number(info.lastInsertRowid);
    return { number, url: this.url(number) };
  }

  /** Tries the squash merge in a temp clone. push=false only checks for conflicts. */
  async squash(pr, push) {
    const dir = this.tmp();
    try {
      await git(['clone', '-q', '--branch', pr.base, this.bare, dir]);
      await git(['fetch', '-q', 'origin', pr.head], { cwd: dir });
      const r = await git(['merge', '--squash', 'FETCH_HEAD'], { cwd: dir, allowFail: true });
      if (!r.ok) return { conflict: true };
      if (!push) return { conflict: false };
      await git(['-c', 'user.name=selfheal-bot', '-c', 'user.email=selfheal@localhost', 'commit', '-q', '-m', `${pr.title} (#${pr.number})`], { cwd: dir });
      await git(['push', '-q', 'origin', `HEAD:${pr.base}`], { cwd: dir });
      return { conflict: false, sha: (await git(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim() };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async getPullRequest(number) {
    const pr = this.pr(number);
    if (!pr) throw new GitHubError(`PR #${number} not found`, 404);
    const headSha = (await git(['--git-dir', this.bare, 'rev-parse', `refs/heads/${pr.head}`], { allowFail: true })).stdout.trim() || null;
    const mergeable = pr.state === 'open' ? !(await this.squash(pr, false)).conflict : null;
    return { number, state: pr.state, merged: !!pr.merged, mergeable, headSha, mergeCommitSha: pr.merge_sha, url: this.url(number) };
  }

  async mergePullRequest(number) {
    const pr = this.pr(number);
    if (!pr || pr.state !== 'open') throw new GitHubError(`PR #${number} is not open`, 405);
    const r = await this.squash(pr, true);
    if (r.conflict) throw new GitHubError('Pull request is not mergeable: merge conflict', 405);
    this.db.prepare("UPDATE mock_prs SET state = 'closed', merged = 1, merge_sha = ? WHERE number = ?").run(r.sha, number);
    return { sha: r.sha };
  }

  async closePullRequest(number) { this.db.prepare("UPDATE mock_prs SET state = 'closed' WHERE number = ?").run(number); }
  async deleteBranch(branch) {
    if (!branch?.startsWith('selfheal/')) throw new Error(`Refusing to delete ${branch}: only selfheal/* branches are deleted`);
    await git(['--git-dir', this.bare, 'update-ref', '-d', `refs/heads/${branch}`]);
  }

  /** Reads a file from a branch (the mock "deploy" serves the demo site from main). */
  async readFile(ref, p) {
    return new Promise((resolve) => execFile('git', ['--git-dir', this.bare, 'show', `${ref}:${p}`], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, out) => resolve(err ? null : out)));
  }
  async head(ref = 'main') { return (await git(['--git-dir', this.bare, 'rev-parse', ref])).stdout.trim(); }
  async diff(number) {
    const pr = this.pr(number);
    if (!pr) return '';
    if (pr.merged) return (await git(['--git-dir', this.bare, 'show', '--format=', pr.merge_sha], { allowFail: true })).stdout;
    return (await git(['--git-dir', this.bare, 'diff', `${pr.base}...${pr.head}`], { allowFail: true })).stdout;
  }
  /** Test helper: someone else pushes to the base branch. */
  async pushToBase(file, content, message = 'Someone else changed main') {
    const dir = this.tmp();
    try {
      await git(['clone', '-q', '--branch', 'main', this.bare, dir]);
      fs.writeFileSync(path.join(dir, file), content);
      await git(['-c', 'user.name=other', '-c', 'user.email=other@localhost', 'commit', '-qam', message], { cwd: dir });
      await git(['push', '-q', 'origin', 'main'], { cwd: dir });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

module.exports = { Workspace, GitHubHost, MockGitHubHost, TokenAuth, GitHubError, runCommand, sandboxEnv, git, testSummary };
