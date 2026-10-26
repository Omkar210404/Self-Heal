'use strict';
/**
 * Turns an owner reply (button id or free text) into a command.
 * Text commands are case-insensitive: YES/NO/MERGE/REJECT/ROLLBACK <issue-id>, plus STATUS and HELP.
 * @returns {{action: string, id: number|null, raw: string}}
 */
const WORDS = {
  fix: ['YES', 'Y', 'FIX', 'APPROVE', 'OK'],
  ignore: ['NO', 'N', 'IGNORE', 'SKIP'],
  merge: ['MERGE', 'SHIP'],
  reject: ['REJECT', 'DECLINE'],
  rollback: ['ROLLBACK', 'REVERT', 'UNDO'],
  status: ['STATUS', 'INFO'],
  help: ['HELP', '?', 'MENU', 'HI', 'HELLO', 'COMMANDS'],
};
const LOOKUP = new Map(Object.entries(WORDS).flatMap(([action, words]) => words.map((w) => [w, action])));

function parseCommand(input) {
  const raw = String(input ?? '').trim();
  const btn = /^(fix|ignore|merge|reject|rollback|status):(\d+)$/i.exec(raw);
  if (btn) return { action: btn[1].toLowerCase(), id: Number(btn[2]), raw };

  const parts = raw.replace(/[.!,]+$/g, '').split(/\s+/).filter(Boolean);
  if (!parts.length) return { action: 'unknown', id: null, raw };
  const action = LOOKUP.get(parts[0].toUpperCase());
  if (!action) return { action: 'unknown', id: null, raw };
  let id = null;
  const idMatch = parts.slice(1).join(' ').match(/^#?(\d{1,9})\b/);
  if (idMatch) id = Number(idMatch[1]);
  else if (parts.length > 1) return { action: 'unknown', id: null, raw }; // e.g. "no idea what this is"
  return { action, id, raw };
}

module.exports = { parseCommand };
