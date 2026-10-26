'use strict';
/*
 * Redacts secrets, tokens, keys, emails and phone numbers BEFORE anything is sent to an AI.
 * Each distinct value becomes a stable placeholder like [REDACTED_EMAIL_1]. AI diffs are applied
 * to the redacted text, then restore() puts the original values back, so redaction never breaks a fix.
 */
const RULES = [
  ['SECRET', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['TOKEN', /sk-ant-[A-Za-z0-9_-]{8,}/g],
  ['TOKEN', /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g],
  ['TOKEN', /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g],
  ['TOKEN', /\bAIza[0-9A-Za-z_-]{20,}/g],
  ['TOKEN', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['TOKEN', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['TOKEN', /\bEAA[A-Za-z0-9]{20,}/g],
  ['TOKEN', /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g],
  ['TOKEN', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['TOKEN', /(?<=\bBearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi],
  ['SECRET', /(?<=[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi],
  ['SECRET', /(?<=[?&](?:key|token|access_token|api_key|apikey|secret|password|sig)=)[^&\s"'#]{4,}/gi],
  ['SECRET', /(?<=\b[\w-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|credential|private[_-]?key)[\w-]*["']?\s*[:=]\s*["'`])[^"'`\n]{6,}(?=["'`])/gi],
  ['SECRET', /(?<=^\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PWD|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)[^\s"'#]{6,}/gm],
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ['PHONE', /(?<![\w.$])\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,5}){2,4}(?![\w.])/g],
  ['PHONE', /(?<![\w.$-])\d{10,15}(?![\w.])/g, (v) => /^1[5-9]\d{11}$/.test(v) /* keep ms timestamps */],
];
const PLACEHOLDER = /\[REDACTED_[A-Z]+_\d+\]/;

function createRedactor(extraSecrets = []) {
  const byValue = new Map();
  const byPlaceholder = new Map();
  const secrets = [...new Set(extraSecrets.filter((s) => s && s.length >= 6))].sort((a, b) => b.length - a.length);
  const ph = (kind, v) => {
    if (!byValue.has(v)) {
      const p = `[REDACTED_${kind}_${byValue.size + 1}]`;
      byValue.set(v, p);
      byPlaceholder.set(p, v);
    }
    return byValue.get(v);
  };
  return {
    redact(text) {
      if (text == null) return text;
      let s = String(text);
      for (const v of secrets) s = s.split(v).join(ph('SECRET', v));
      for (const [kind, re, keep] of RULES) s = s.replace(re, (m) => (PLACEHOLDER.test(m) || keep?.(m) ? m : ph(kind, m)));
      return s;
    },
    restore(text) {
      return text == null ? text : String(text).replace(/\[REDACTED_[A-Z]+_\d+\]/g, (p) => byPlaceholder.get(p) ?? p);
    },
  };
}

module.exports = { createRedactor };
