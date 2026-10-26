'use strict';
// Logger that masks phone numbers, tokens and known secret values in every line.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const TOKEN_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bEAA[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
  /([?&](?:key|token|access_token|api_key)=)[^&\s"']+/gi,
];
// 8-15 digit runs, or +country numbers with spaces/dashes, look like phone numbers; keep the last 2 digits.
// (Dates like 2026-10-26 have no leading + and are not contiguous, so they are left alone.)
const PHONE = /(?<![\w.])(?:\+\d[\d -]{6,16}\d|\d{8,15})(?![\w.])/g;

function maskPhone(s) {
  return s.replace(PHONE, (m) => {
    const d = m.replace(/\D/g, '');
    if (d.length < 8 || d.length > 15) return m;
    return '•'.repeat(d.length - 2) + d.slice(-2);
  });
}

function createMasker(secrets = []) {
  const list = [...new Set(secrets.filter((s) => s && s.length >= 6))].sort((a, b) => b.length - a.length);
  return function mask(input) {
    let s = typeof input === 'string' ? input : safeStringify(input);
    for (const v of list) s = s.split(v).join('***');
    for (const re of TOKEN_PATTERNS) s = s.replace(re, (m, p1) => (typeof p1 === 'string' && m.startsWith(p1) ? p1 + '***' : '***'));
    return maskPhone(s);
  };
}

function safeStringify(v) {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v, (k, val) => (val instanceof Error ? `${val.name}: ${val.message}` : val));
  } catch {
    return String(v);
  }
}

/**
 * @param {{level?: string, secrets?: string[], sink?: (line: string, level: string) => void}} opts
 */
function createLogger({ level = 'info', secrets = [], sink } = {}) {
  let mask = createMasker(secrets);
  const min = LEVELS[level] ?? LEVELS.info;
  const out = sink || ((line, lvl) => (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n'));
  const log = (lvl) => (msg, meta) => {
    if (LEVELS[lvl] < min) return;
    try {
      let line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}`;
      if (meta !== undefined) line += ' ' + safeStringify(meta);
      out(mask(line), lvl);
    } catch {
      /* logging must never throw */
    }
  };
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    mask: (s) => mask(s),
    addSecrets(more) { secrets = secrets.concat(more); mask = createMasker(secrets); },
  };
}

module.exports = { createLogger, createMasker, maskPhone };
