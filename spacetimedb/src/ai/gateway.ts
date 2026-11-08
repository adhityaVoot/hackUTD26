// The single outbound gateway for model calls (spec: "One outbound gateway").
//  - sanitizeUserText: the requester's own question, with names swapped for member tokens.
//  - scanOutbound: blocks any payload that contains a real name, nickname, email, phone,
//    SSN or account-number-shaped string.
//  - checkNumbers: every number in model-written text must appear in engine output.

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const ACCOUNT_NUMBER = /\b\d{8,19}\b/;
const HEX_ID = /\b[0-9a-f]{24}\b/i; // Nessie ids

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Cleans the requester's own free text before it goes to the model. */
export function sanitizeUserText(text: string, nameToToken: Map<string, string>, maxLen = 600): string {
  let s = text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLen);
  s = s
    .replace(new RegExp(EMAIL.source, 'gi'), '[email]')
    .replace(new RegExp(SSN.source, 'g'), '[id]')
    .replace(new RegExp(PHONE.source, 'g'), '[phone]')
    .replace(new RegExp(ACCOUNT_NUMBER.source, 'g'), '[number]');
  // Longest names first so "Mary Ann" wins over "Mary".
  const names = [...nameToToken.keys()].sort((a, b) => b.length - a.length);
  for (const n of names) {
    if (!n) continue;
    const tok = nameToToken.get(n)!;
    s = s.replace(new RegExp(`\\b${escapeRe(n)}(?:'s)?\\b`, 'gi'), m => (m.toLowerCase().endsWith("'s") ? `member ${tok}'s` : `member ${tok}`));
  }
  return s.replace(/\s+/g, ' ').trim();
}

export interface ScanResult {
  ok: boolean;
  reason: string;
}

/** Final check on the exact bytes about to leave the module. */
export function scanOutbound(payload: string, names: string[], properWords: string[] = []): ScanResult {
  if (EMAIL.test(payload)) return { ok: false, reason: 'email address in payload' };
  if (SSN.test(payload)) return { ok: false, reason: 'SSN-shaped value in payload' };
  if (PHONE.test(payload)) return { ok: false, reason: 'phone number in payload' };
  if (ACCOUNT_NUMBER.test(payload)) return { ok: false, reason: 'account-number-shaped value in payload' };
  if (HEX_ID.test(payload)) return { ok: false, reason: 'bank identifier in payload' };
  for (const n of names) {
    if (n.length < 2) continue;
    if (new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(payload)) return { ok: false, reason: 'a real name or nickname in payload' };
  }
  for (const w of properWords) {
    if (new RegExp(`\\b${escapeRe(w)}\\b`).test(payload)) return { ok: false, reason: 'an account nickname in payload' };
  }
  return { ok: true, reason: '' };
}

// ---------- Number check ----------

const NUMBER = /-?\$?\d[\d,]*(?:\.\d+)?%?/g;

function parseNumber(tok: string): number {
  return Number(tok.replace(/[$,%]/g, ''));
}

/** Collects every number appearing anywhere in a JSON-able value (numbers and inside strings). */
export function collectNumbers(value: unknown, into: Set<number> = new Set()): Set<number> {
  if (typeof value === 'number' && Number.isFinite(value)) {
    into.add(value);
    into.add(Math.abs(value));
  } else if (typeof value === 'string') {
    for (const m of value.match(NUMBER) ?? []) {
      const n = parseNumber(m);
      if (Number.isFinite(n)) {
        into.add(n);
        into.add(Math.abs(n));
      }
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, into);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectNumbers(v, into);
  }
  return into;
}

function close(n: number, allowed: Set<number>): boolean {
  if (allowed.has(n)) return true;
  for (const a of allowed) {
    // Rounding the model may reasonably do: $1,234.56 -> $1,235 / $1.2k, 0.643 -> 64%.
    if (Math.abs(a - n) <= Math.max(1, Math.abs(a) * 0.01)) return true;
    if (Math.abs(a * 100 - n) <= 1) return true; // fraction rendered as a percent
    if (Math.abs(a) >= 1000 && Math.abs(a / 1000 - n) <= 0.1) return true; // "$3.2k"
  }
  return false;
}

export interface NumberCheck {
  ok: boolean;
  unsupported: number[];
}

/**
 * Every number in `text` must be present in `allowed` (engine output, the question, the date
 * labels). Small counting numbers (0-12) and years are always fine.
 */
export function checkNumbers(text: string, allowed: Set<number>): NumberCheck {
  const unsupported: number[] = [];
  for (const m of text.match(NUMBER) ?? []) {
    const n = Math.abs(parseNumber(m));
    if (!Number.isFinite(n)) continue;
    if (n <= 12 && Number.isInteger(n) && !m.includes('$')) continue;
    if (n >= 2024 && n <= 2035 && Number.isInteger(n)) continue;
    if (!close(n, allowed)) unsupported.push(n);
  }
  return { ok: unsupported.length === 0, unsupported };
}
