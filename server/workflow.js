'use strict';
/*
 * Ties it together: owner commands -> jobs -> issue status + WhatsApp messages.
 * Every failure path ends in a status change and a WhatsApp message (or a notify_failed event when
 * WhatsApp itself is down), and the sweeper re-queues anything left without a job.
 */
const { runFix } = require('./fix');
const { CostCapError, AllProvidersFailedError } = require('./ai');
const { Workspace, GitHubError } = require('./repo');
const { PermanentError } = require('./queue');
const msgs = require('./notify/messages');

const tail = (s, n = 1500) => (s && s.length > n ? '…' + s.slice(-n) : s || '');

class Workflow {
  constructor({ config, issues, queue, notifier, router, host, logger, secrets = [], clock = { now: () => Date.now() } }) {
    Object.assign(this, { config, issues, queue, notifier, router, host, logger, secrets, clock, db: issues.db });
    const lane = { lane: 'fix' };
    queue.register('fix', (p) => this.jobFix(p), { ...lane, maxAttempts: 2, onFail: (p, err) => this.failFix(p.issueId, p.run, 'unexpected error', err.message) });
    queue.register('merge', (p) => this.jobMerge(p), { ...lane, maxAttempts: 3, onFail: (p, err) => this.mergeBlocked(p.issueId, `Merge failed: ${err.message}`) });
    queue.register('reject', (p) => this.jobReject(p), { ...lane, maxAttempts: 3, onFail: (p, err) => this.logger.error(`closing PR for issue #${p.issueId} failed: ${err.message}`) });
    queue.register('rollback', (p) => this.jobRollback(p), { ...lane, maxAttempts: 2, onFail: (p, err) => this.rollbackFailed(p.issueId, err.message) });
    notifier.setCommandHandler((cmd) => this.handleCommand(cmd));
  }

  tell(kind, issueId, message, dedupeKey = null) {
    return this.notifier.send({ kind, issueId, message, dedupeKey });
  }

  onNewIssue(issue) {
    return this.notifier.alertIssue(issue);
  }

  // ------------------------------------------------------------------ commands
  async handleCommand({ action, id }) {
    if (action === 'help' || action === 'unknown') return msgs.help();
    const waiting = { fix: ['alerted', 'new'], ignore: ['alerted', 'new'], merge: ['fix_ready'], reject: ['fix_ready'], status: null, rollback: ['merged'] };
    if (id == null) {
      if (!waiting[action]) return msgs.needId(action, []);
      const cands = this.db.prepare(`SELECT * FROM issues WHERE status IN (${waiting[action].map(() => '?').join(',')}) ORDER BY updated_at DESC`).all(...waiting[action]);
      if (cands.length !== 1 || action === 'rollback') return msgs.needId(action, cands);
      id = cands[0].id;
    }
    const issue = this.issues.get(id);
    if (!issue) return msgs.notFound(id);
    switch (action) {
      case 'status': return msgs.status(issue, this.config);
      case 'fix': return this.approve(issue);
      case 'ignore': {
        const r = this.issues.transition(id, 'ignored', { from: ['new', 'alerted'], reason: 'Owner chose Ignore' });
        return r.ok ? msgs.ignored(issue) : msgs.wrongState(issue, 'ignore');
      }
      case 'merge':
        if (issue.status !== 'fix_ready') return msgs.wrongState(issue, 'merge');
        this.issues.addEvent(id, 'merge_requested');
        this.queue.enqueue('merge', { issueId: id }, { dedupeKey: `merge:${id}:${issue.fix_runs}:${Date.now()}` });
        return msgs.merging(issue);
      case 'reject': {
        const r = this.issues.transition(id, 'rejected', { from: ['fix_ready'], reason: 'Owner rejected the fix' });
        if (!r.ok) return msgs.wrongState(issue, 'reject');
        this.queue.enqueue('reject', { issueId: id });
        return null; // the job confirms once the PR is closed
      }
      case 'rollback':
        if (issue.status !== 'merged') return msgs.wrongState(issue, 'roll back');
        this.queue.enqueue('rollback', { issueId: id }, { dedupeKey: `rollback:${id}:${issue.merge_sha}` });
        return msgs.rollingBack(issue);
      default: return msgs.help();
    }
  }

  approve(issue) {
    const r = this.issues.transition(issue.id, 'approved', { from: ['new', 'alerted', 'fix_failed', 'rejected', 'ignored', 'rolled_back'], reason: 'Owner approved a fix' });
    if (!r.ok) return msgs.wrongState(issue, 'fix');
    const run = issue.fix_runs + 1;
    this.issues.update(issue.id, { fix_runs: run, attempts: 0 });
    this.queue.enqueue('fix', { issueId: issue.id, run }, { dedupeKey: `fix:${issue.id}:${run}` });
    return msgs.fixing(issue);
  }

  // ------------------------------------------------------------------ fix
  async jobFix({ issueId, run }) {
    let issue = this.issues.get(issueId);
    if (!issue || issue.fix_runs !== run) return; // stale job
    if (issue.status === 'approved') issue = this.issues.transition(issueId, 'fixing', { from: ['approved'], reason: 'AI is working on a fix' }).issue;
    if (issue.status !== 'fixing') return;

    let ws;
    try {
      const base = this.config.github.baseBranch || (await this.host.getDefaultBranch());
      ws = await Workspace.clone({ host: this.host, base, config: this.config });
      await ws.install();
      const result = await runFix({
        issue, workspace: ws, router: this.router, config: this.config, secrets: this.secrets,
        onAttempt: (a) => this.recordAttempt(issueId, run, a),
      });
      if (result.outcome === 'unfixable') return this.failFix(issueId, run, 'AI diagnosis', `${result.rootCause} ${result.explanation || ''}`.trim(), result);
      if (result.outcome === 'tests_failed') {
        return this.failFix(issueId, run, 'tests', `Tests still failed after ${result.attempt} attempts. Last output: ${tail(this.logger.mask(result.testOutput), 400)}`);
      }
      // Tests passed (or the repo has none): branch, commit, push, PR.
      let branch = `selfheal/issue-${issueId}`;
      for (let n = 2; await this.host.branchExists(branch); n++) branch = `selfheal/issue-${issueId}-${n}`;
      const title = `${result.tested ? '' : '[UNTESTED] '}fix: ${msgs.short(issue.title, 60)} (selfheal #${issueId})`;
      await ws.commitAndPush(branch, `${title}\n\n${result.rootCause}`, result.files.map((f) => f.path));
      const pr = await this.host.openPullRequest({ head: branch, base, title, body: this.prBody(issue, result) });
      this.issues.update(issueId, {
        root_cause: result.rootCause, explanation: result.explanation, ai_provider: result.provider, attempts: result.attempt, branch, base_branch: base,
        pr_number: pr.number, pr_url: pr.url, tested: result.tested ? 1 : 0, test_summary: result.testSummary, files_changed: result.files,
      });
      const r = this.issues.transition(issueId, 'fix_ready', { from: ['fixing'], reason: `PR #${pr.number} opened${result.tested ? '' : ' (UNTESTED)'}`, detail: { pr: pr.url, branch } });
      this.tell('fix_ready', issueId, msgs.fixReady(r.issue, {
        prUrl: pr.url, rootCause: result.rootCause, files: result.files, tested: result.tested, testSummary: result.testSummary,
        attempt: result.attempt, maxAttempts: this.config.fix.maxAttempts, provider: result.provider,
      }), `fix_ready:${issueId}:${run}`);
    } catch (err) {
      if (err instanceof CostCapError) {
        this.issues.transition(issueId, 'approved', { from: ['fixing'], reason: 'Paused: daily AI limit reached', event: 'paused_cost_cap', detail: { resumeAt: new Date(err.resumeAt).toISOString() } });
        const day = new Date(this.clock.now()).toISOString().slice(0, 10);
        const a = this.config.ai;
        this.tell('cost_cap', issueId, msgs.costCap({ spentUsd: err.totals.costUsd, capUsd: a.dailyMaxCostUsd, calls: err.totals.calls, maxCalls: a.dailyMaxCalls, resumeAt: new Date(err.resumeAt).toISOString(), issueId }), `cost_cap:${day}`);
        return { defer: err.resumeAt, reason: 'daily AI limit reached' };
      }
      if (err instanceof AllProvidersFailedError) return this.failFix(issueId, run, 'AI providers', err.message);
      if (err instanceof GitHubError || /clone|push|install/i.test(err.message)) return this.failFix(issueId, run, 'GitHub / repository', err.message);
      throw err; // retried once by the queue, then onFail -> failFix
    } finally {
      ws?.cleanup();
    }
  }

  recordAttempt(issueId, run, a) {
    this.db.prepare(`INSERT INTO fix_attempts (issue_id, run, attempt, provider, root_cause, explanation, changes, test_passed, test_output, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(issueId, run, a.attempt, a.provider, a.rootCause, a.explanation, JSON.stringify(a.changes),
      a.testPassed == null ? null : a.testPassed ? 1 : 0, tail(this.logger.mask(a.testOutput || ''), 8000), a.error || null, new Date(this.clock.now()).toISOString());
    this.issues.addEvent(issueId, 'fix_attempt', { attempt: a.attempt, provider: a.provider, tests: a.testPassed == null ? 'not run' : a.testPassed ? 'passed' : 'failed' });
    this.issues.update(issueId, { attempts: a.attempt, root_cause: a.rootCause, explanation: a.explanation, ai_provider: a.provider });
  }

  failFix(issueId, run, step, reason, extra = {}) {
    const clean = this.logger.mask(String(reason));
    const r = this.issues.transition(issueId, 'fix_failed', { from: ['approved', 'fixing'], reason: `${step}: ${msgs.short(clean, 900)}` });
    if (extra.rootCause) this.issues.update(issueId, { root_cause: extra.rootCause, explanation: extra.explanation });
    if (r.ok || r.issue) this.tell('fix_failed', issueId, msgs.fixFailed(r.issue || { id: issueId }, { step, reason: clean, publicUrl: this.config.publicUrl }), `fix_failed:${issueId}:${run}`);
  }

  prBody(issue, r) {
    const files = r.files.map((f) => `- \`${f.path}\` (+${f.added} −${f.removed})`).join('\n');
    const tests = r.tested
      ? `✅ \`${this.config.github.testCommand}\` passed on attempt ${r.attempt} of ${this.config.fix.maxAttempts} (${r.testSummary}).\n\n<details><summary>Test output</summary>\n\n\`\`\`\n${tail(this.logger.mask(r.testOutput), 3000)}\n\`\`\`\n</details>`
      : '⚠️ **UNTESTED**: this repository has no test command, so no tests were run. Review carefully before merging.';
    return [
      `## selfheal fix for issue #${issue.id}`,
      '',
      `**Error:** \`${this.logger.mask(issue.title)}\``,
      `**Where:** \`${issue.file || 'unknown'}${issue.line ? `:${issue.line}` : ''}\` · seen ${issue.count}× · first ${issue.first_seen} · last ${issue.last_seen}`,
      issue.page_url ? `**Page:** ${this.logger.mask(issue.page_url)}` : '',
      '',
      '### Root cause', r.rootCause, '',
      '### What changed', r.explanation, '', files, '',
      '### Tests', tests, '',
      '---',
      `Opened by selfheal (AI: ${r.provider}) after the owner approved the fix on WhatsApp. It is merged only after a second approval.`,
      `Issue: ${this.config.publicUrl}/dashboard/issues/${issue.id}`,
    ].filter((l) => l !== null).join('\n');
  }

  // ------------------------------------------------------------------ merge / reject
  mergeBlocked(issueId, reason) {
    const issue = this.issues.get(issueId);
    this.issues.addEvent(issueId, /conflict/i.test(reason) ? 'merge_conflict' : 'merge_failed', { reason });
    this.tell('merge_blocked', issueId, msgs.mergeBlocked(issue, { reason, prUrl: issue?.pr_url }));
  }

  async jobMerge({ issueId }) {
    const issue = this.issues.get(issueId);
    if (!issue || issue.status !== 'fix_ready') return;
    const pr = await this.host.getPullRequest(issue.pr_number);
    if (pr.merged) return this.markMerged(issue, pr.mergeCommitSha);
    if (pr.state !== 'open') {
      this.issues.transition(issueId, 'fix_failed', { from: ['fix_ready'], reason: 'The PR was closed on GitHub without merging' });
      return this.tell('fix_failed', issueId, msgs.fixFailed(issue, { step: 'merge', reason: 'The pull request was closed on GitHub without merging.', publicUrl: this.config.publicUrl }));
    }
    if (pr.mergeable === false) return this.mergeBlocked(issueId, 'The PR has a merge conflict with the latest base branch (someone changed the same lines).');
    if (pr.mergeable == null) return this.mergeBlocked(issueId, 'GitHub has not finished checking whether the PR can be merged. Reply MERGE again in a minute.');
    let res;
    try {
      res = await this.host.mergePullRequest(issue.pr_number, { sha: pr.headSha, method: this.config.github.mergeMethod, title: `fix: selfheal issue #${issueId} (#${issue.pr_number})` });
    } catch (err) {
      if (err instanceof GitHubError && [405, 409, 422].includes(err.status)) return this.mergeBlocked(issueId, err.message);
      throw err;
    }
    return this.markMerged(issue, res.sha);
  }

  async markMerged(issue, sha) {
    this.issues.update(issue.id, { merge_sha: sha });
    const r = this.issues.transition(issue.id, 'merged', { from: ['fix_ready'], reason: 'Owner approved the merge', detail: { sha } });
    try { await this.host.deleteBranch(issue.branch); } catch (err) { this.logger.warn(`could not delete ${issue.branch}: ${err.message}`); }
    this.tell('merged', issue.id, msgs.merged(r.issue || issue, { sha }), `merged:${issue.id}:${sha}`);
  }

  async jobReject({ issueId }) {
    const issue = this.issues.get(issueId);
    if (!issue) return;
    if (issue.pr_number) await this.host.closePullRequest(issue.pr_number);
    if (issue.branch) { try { await this.host.deleteBranch(issue.branch); } catch (err) { this.logger.warn(`could not delete ${issue.branch}: ${err.message}`); } }
    this.tell('rejected', issueId, msgs.rejected(issue), `rejected:${issueId}:${issue.fix_runs}`);
  }

  // ------------------------------------------------------------------ rollback
  async jobRollback({ issueId }) {
    const issue = this.issues.get(issueId);
    if (!issue || issue.status !== 'merged') return;
    if (!issue.merge_sha) throw new PermanentError('No merge commit recorded for this issue');
    const base = issue.base_branch || (await this.host.getDefaultBranch());
    let branch = `selfheal/revert-issue-${issueId}`;
    for (let n = 2; await this.host.branchExists(branch); n++) branch = `selfheal/revert-issue-${issueId}-${n}`;
    const ws = await Workspace.clone({ host: this.host, base, config: this.config });
    try {
      try {
        await ws.revertOnBranch(issue.merge_sha, branch, `Revert selfheal fix for issue #${issueId}`);
      } catch (err) {
        throw new PermanentError(err.message);
      }
    } finally {
      ws.cleanup();
    }
    const title = `Revert: selfheal fix for issue #${issueId}`;
    const pr = await this.host.openPullRequest({ head: branch, base, title, body: `Reverts the selfheal fix for issue #${issueId} (${issue.pr_url}).\n\nRequested by the owner with ROLLBACK ${issueId} on WhatsApp.` });
    this.issues.update(issueId, { revert_pr_number: pr.number, revert_pr_url: pr.url });
    const state = await this.host.getPullRequest(pr.number);
    if (state.mergeable === false) throw new PermanentError(`The revert PR has a merge conflict: ${pr.url}`);
    await this.host.mergePullRequest(pr.number, { sha: state.headSha, method: this.config.github.mergeMethod, title });
    try { await this.host.deleteBranch(branch); } catch (err) { this.logger.warn(`could not delete ${branch}: ${err.message}`); }
    const r = this.issues.transition(issueId, 'rolled_back', { from: ['merged'], reason: `Reverted by PR #${pr.number}`, detail: { pr: pr.url } });
    this.tell('rolled_back', issueId, msgs.rolledBack(r.issue, { prUrl: pr.url }), `rolled_back:${issueId}`);
  }

  rollbackFailed(issueId, reason) {
    const issue = this.issues.get(issueId);
    this.issues.addEvent(issueId, 'rollback_failed', { reason });
    this.tell('rollback_failed', issueId, msgs.rollbackFailed(issue, { reason: this.logger.mask(reason) }));
  }

  // ------------------------------------------------------------------ sweeper
  /** Makes sure nothing is silently stuck (e.g. after a crash between steps). */
  sweep() {
    for (const i of this.db.prepare("SELECT * FROM issues WHERE status IN ('approved', 'fixing')").all()) {
      if (this.queue.active('fix', { issueId: i.id }).length) continue;
      if (i.status === 'fixing') this.failFix(i.id, i.fix_runs, 'interrupted', 'The fix job stopped unexpectedly (server restart or crash). Reply FIX to try again.');
      else this.queue.enqueue('fix', { issueId: i.id, run: i.fix_runs }, { dedupeKey: `fix:${i.id}:${i.fix_runs}:sweep` });
    }
    for (const i of this.db.prepare("SELECT * FROM issues WHERE status = 'new' AND alert_bundled = 0").all()) this.notifier.alertIssue(i);
  }
}

module.exports = { Workflow };
