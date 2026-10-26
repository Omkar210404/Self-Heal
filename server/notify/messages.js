'use strict';
/*
 * Every WhatsApp text the owner can receive. Each builder returns
 * { text, buttons?, summary } where `summary` is a one-line version used
 * in the template message when the 24-hour window is closed.
 */

const short = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const where = (i) => (i.file ? `${i.file}${i.line ? ` line ${i.line}` : ''}` : 'unknown file');
const link = (base, i) => `${base}/dashboard/issues/${i.id}`;
const hhmm = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '');

function alert(issue, { publicUrl }) {
  const lines = [
    `🐞 *New error on your site* (issue #${issue.id})`,
    '',
    short(issue.title, 300),
    `📄 ${where(issue)}`,
    issue.page_url ? `🌐 ${short(issue.page_url, 120)}` : null,
    `🔁 Seen ${issue.count}× · first ${hhmm(issue.first_seen)}`,
    issue.release ? `🏷️ Release ${issue.release}` : null,
    '',
    'Fix it with AI? I will work on a separate branch, run your tests, and ask you again before anything is merged.',
    `Details: ${link(publicUrl, issue)}`,
  ].filter((l) => l !== null);
  return {
    text: lines.join('\n'),
    buttons: [
      { id: `fix:${issue.id}`, title: 'Fix it' },
      { id: `ignore:${issue.id}`, title: 'Ignore' },
    ],
    summary: `New error #${issue.id}: ${short(issue.title, 120)}`,
  };
}

function bundle(issues, { maxPerHour }) {
  const rows = issues.slice(0, 15).map((i) => `#${i.id} ${short(i.title, 70)} (×${i.count})`);
  if (issues.length > 15) rows.push(`…and ${issues.length - 15} more (see dashboard)`);
  return {
    text: [
      `📦 *${issues.length} more new error${issues.length === 1 ? '' : 's'}* (you get at most ${maxPerHour} separate alerts per hour, so these are bundled):`,
      '',
      ...rows,
      '',
      'Reply *FIX <id>* to fix one, or *IGNORE <id>* to ignore it.',
    ].join('\n'),
    summary: `${issues.length} more new errors on your site`,
  };
}

const fixing = (issue) => ({
  text: `🛠️ On it. Working on a fix for issue #${issue.id} on a separate branch. I'll message you when it's ready to review.`,
  summary: `Working on issue #${issue.id}`,
});

const ignored = (issue) => ({
  text: `🙈 Ignored issue #${issue.id}. You won't be asked about it again. Reply *FIX ${issue.id}* if you change your mind.`,
  summary: `Ignored issue #${issue.id}`,
});

function fixReady(issue, { prUrl, rootCause, files, tested, testSummary, attempt, maxAttempts, provider }) {
  const fileLines = files.map((f) => `• ${f.path} (+${f.added} −${f.removed})`).join('\n');
  const testLine = tested
    ? `🧪 Tests: ✅ passed on attempt ${attempt} of ${maxAttempts}${testSummary ? ` (${short(testSummary, 80)})` : ''}`
    : '🧪 Tests: ⚠️ *UNTESTED*: this repo has no test command, so nothing was run. Review the PR carefully.';
  return {
    text: [
      `✅ *Fix ready for issue #${issue.id}*${tested ? '' : ' (UNTESTED)'}`,
      '',
      `Cause: ${short(rootCause, 350)}`,
      '',
      `Files changed:\n${fileLines}`,
      testLine,
      `🤖 AI: ${provider}`,
      `🔗 PR: ${prUrl}`,
      '',
      'Merge it? Your normal deploy takes it live after the merge.',
    ].join('\n'),
    buttons: [
      { id: `merge:${issue.id}`, title: 'Merge' },
      { id: `reject:${issue.id}`, title: 'Reject' },
    ],
    summary: `Fix ready for issue #${issue.id}${tested ? '' : ' (UNTESTED)'}: review the PR`,
  };
}

function fixFailed(issue, { step, reason, publicUrl }) {
  return {
    text: [
      `❌ *Could not fix issue #${issue.id}*`,
      '',
      `Step: ${step}`,
      `Why: ${short(reason, 600)}`,
      '',
      `Nothing was merged. Reply *FIX ${issue.id}* to try again later.`,
      `Details: ${link(publicUrl, issue)}`,
    ].join('\n'),
    summary: `Could not fix issue #${issue.id}: ${short(reason, 100)}`,
  };
}

const merging = (issue) => ({ text: `⏳ Merging the fix for issue #${issue.id}…`, summary: `Merging issue #${issue.id}` });

const merged = (issue, { sha }) => ({
  text: [
    `🚀 *Merged the fix for issue #${issue.id}*${sha ? ` (${String(sha).slice(0, 7)})` : ''}.`,
    'Your site deploy (Vercel/Netlify/GitHub Actions) will take it live.',
    '',
    `If anything looks wrong, reply *ROLLBACK ${issue.id}* to revert it.`,
  ].join('\n'),
  summary: `Merged the fix for issue #${issue.id}`,
});

const mergeBlocked = (issue, { reason, prUrl }) => ({
  text: [
    `⚠️ *Could not merge issue #${issue.id}*`,
    '',
    short(reason, 500),
    prUrl ? `PR: ${prUrl}` : null,
    '',
    'Nothing was forced. Resolve it on GitHub, then reply *MERGE ' + issue.id + '*, or *REJECT ' + issue.id + '* to drop the fix.',
  ].filter((l) => l !== null).join('\n'),
  summary: `Could not merge issue #${issue.id}: ${short(reason, 100)}`,
});

const rejected = (issue) => ({
  text: `🗑️ Rejected the fix for issue #${issue.id}. The PR was closed and its branch removed. Reply *FIX ${issue.id}* to try a new fix.`,
  summary: `Rejected the fix for issue #${issue.id}`,
});

const rollingBack = (issue) => ({ text: `⏪ Rolling back issue #${issue.id}: opening a revert PR…`, summary: `Rolling back issue #${issue.id}` });

const rolledBack = (issue, { prUrl }) => ({
  text: `⏪ *Rolled back issue #${issue.id}.* The revert PR was merged: ${prUrl}\nYour deploy will publish the previous code.`,
  summary: `Rolled back issue #${issue.id}`,
});

const rollbackFailed = (issue, { reason }) => ({
  text: `❌ *Rollback of issue #${issue.id} failed*\n\nWhy: ${short(reason, 600)}\n\nNothing was changed on your main branch. You can revert the merge manually on GitHub.`,
  summary: `Rollback of issue #${issue.id} failed`,
});

function costCap({ spentUsd, capUsd, calls, maxCalls, resumeAt, issueId }) {
  return {
    text: [
      '⏸️ *Daily AI limit reached. Fixing is paused.*',
      '',
      `Today: $${spentUsd.toFixed(2)} of $${capUsd} · ${calls} of ${maxCalls} AI calls.`,
      issueId ? `Issue #${issueId} will resume automatically at ${hhmm(resumeAt)}.` : `Fixing resumes at ${hhmm(resumeAt)}.`,
      'Raise AI_DAILY_MAX_COST_USD / AI_DAILY_MAX_CALLS in .env if you want more.',
    ].join('\n'),
    summary: 'Daily AI limit reached, fixing paused until tomorrow',
  };
}

function help() {
  return {
    text: [
      '🤖 *selfheal commands* (not case-sensitive)',
      '',
      '*YES <id>* or *FIX <id>*: fix an issue',
      '*NO <id>* or *IGNORE <id>*: ignore it',
      '*MERGE <id>*: merge a ready fix',
      '*REJECT <id>*: drop a ready fix',
      '*ROLLBACK <id>*: revert a merged fix',
      '*STATUS <id>*: where an issue is at',
      '',
      'If you leave out the id and only one issue is waiting, I use that one.',
    ].join('\n'),
    summary: 'selfheal commands',
  };
}

const STATUS_WORDS = {
  new: 'new (not alerted yet)',
  alerted: 'waiting for your Fix it / Ignore',
  approved: 'approved, waiting in the fix queue',
  fixing: 'being fixed right now',
  fix_ready: 'fix ready: waiting for your Merge / Reject',
  merged: 'fixed and merged',
  rejected: 'fix rejected',
  ignored: 'ignored',
  fix_failed: 'fix failed',
  rolled_back: 'rolled back',
};

const status = (issue, { publicUrl }) => ({
  text: [
    `ℹ️ *Issue #${issue.id}*: ${STATUS_WORDS[issue.status] || issue.status}`,
    short(issue.title, 200),
    issue.status_reason ? `Note: ${short(issue.status_reason, 300)}` : null,
    issue.pr_url ? `PR: ${issue.pr_url}` : null,
    `Seen ${issue.count}×, last ${hhmm(issue.last_seen)}`,
    link(publicUrl, issue),
  ].filter((l) => l !== null).join('\n'),
  summary: `Issue #${issue.id}: ${issue.status}`,
});

const notFound = (id) => ({ text: `🤔 I can't find issue #${id}. Reply *HELP* for commands.`, summary: 'Issue not found' });

const wrongState = (issue, action) => ({
  text: `🤔 Can't ${action} issue #${issue.id}: it is ${STATUS_WORDS[issue.status] || issue.status}.`,
  summary: `Can't ${action} issue #${issue.id}`,
});

const needId = (action, candidates) => ({
  text:
    candidates.length === 0
      ? `🤔 There is no issue waiting for *${action.toUpperCase()}*. Reply *HELP* for commands.`
      : `🤔 Several issues are waiting (${candidates.map((c) => '#' + c.id).join(', ')}). Reply *${action.toUpperCase()} <id>*, e.g. *${action.toUpperCase()} ${candidates[0].id}*.`,
  summary: 'Which issue?',
});

const testMessage = () => ({ text: '👋 selfheal test message: WhatsApp is set up correctly.', summary: 'selfheal test message' });

module.exports = {
  alert, bundle, fixing, ignored, fixReady, fixFailed, merging, merged, mergeBlocked, rejected,
  rollingBack, rolledBack, rollbackFailed, costCap, help, status, notFound, wrongState, needId, testMessage, short,
};
