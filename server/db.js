'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  file TEXT,
  line INTEGER,
  col INTEGER,
  stack TEXT,
  page_url TEXT,
  user_agent TEXT,
  release TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  status_reason TEXT,
  cycle INTEGER NOT NULL DEFAULT 1,
  fix_runs INTEGER NOT NULL DEFAULT 0,
  alert_bundled INTEGER NOT NULL DEFAULT 0,
  root_cause TEXT,
  explanation TEXT,
  ai_provider TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  branch TEXT,
  base_branch TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  merge_sha TEXT,
  revert_pr_number INTEGER,
  revert_pr_url TEXT,
  tested INTEGER,
  test_summary TEXT,
  files_changed TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS issues_status ON issues(status);

CREATE TABLE IF NOT EXISTS occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS occurrences_issue ON occurrences(issue_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER REFERENCES issues(id),
  type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_issue ON events(issue_id);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  lane TEXT NOT NULL DEFAULT 'default',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_at INTEGER NOT NULL,
  dedupe_key TEXT UNIQUE,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, lane, run_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  issue_id INTEGER,
  kind TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_provider_id ON messages(provider_message_id);
CREATE INDEX IF NOT EXISTS messages_kind_time ON messages(kind, created_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_usage_day ON ai_usage(day);

CREATE TABLE IF NOT EXISTS fix_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  run INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  provider TEXT,
  root_cause TEXT,
  explanation TEXT,
  changes TEXT,
  test_passed INTEGER,
  test_output TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

/** Opens (or creates) the SQLite database and applies the schema. */
function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  /** Runs fn inside a transaction (nested calls join the outer one). */
  let depth = 0;
  db.tx = (fn) => {
    if (depth > 0) return fn();
    depth++;
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    } finally {
      depth--;
    }
  };
  db.kvGet = (key) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
  db.kvSet = (key, value) => db.prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value == null ? null : String(value));
  return db;
}

module.exports = { openDb };
