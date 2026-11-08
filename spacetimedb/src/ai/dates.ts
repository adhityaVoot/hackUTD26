// Day-number <-> calendar conversion for the AI layer.
// Day 0 is 2026-01-01 (UTC). If engine/calendar.ts settles on a different epoch, change DAY0_UTC_MS.
// Only Date.UTC and explicit-timestamp Date objects are used, so this stays deterministic in reducers.

const DAY_MS = 86_400_000;
const DAY0_UTC_MS = Date.UTC(2026, 0, 1);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayToDate(day: number): Date {
  return new Date(DAY0_UTC_MS + day * DAY_MS);
}

export function dayToIso(day: number): string {
  return dayToDate(day).toISOString().slice(0, 10);
}

/** "Nov 20, 2026" */
export function dayToLabel(day: number): string {
  const d = dayToDate(day);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "Aug 2027" */
export function dayToMonthLabel(day: number): string {
  const d = dayToDate(day);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Goal ETA label; NO_ETA means the goal isn't reached within the horizon. */
export const NO_ETA = -1_000_000;
export function etaLabel(day: number): string {
  return day === NO_ETA ? 'not within 5 years' : dayToLabel(day);
}

/** Month names as whole words. "may" only counts with a time word before it ("in May"). */
export function monthIndexIn(text: string): number {
  const q = text.toLowerCase();
  const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  for (let i = 0; i < 12; i++) {
    if (i === 4) {
      if (/\b(in|by|this|next|last|early|late|mid|before|after|until)\s+may\b/.test(q) || /\bmay\s+\d/.test(q)) return 4;
      continue;
    }
    const abbr = full[i].slice(0, 3);
    if (new RegExp(`\\b(${full[i]}|${abbr}|${i === 8 ? 'sept' : abbr})\\.?\\b`).test(q)) return i;
  }
  return -1;
}

/** Parses YYYY-MM-DD or YYYY-MM. Returns null for anything else. */
export function isoToDay(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(iso.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = m[3] ? Number(m[3]) : 1;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Math.round((Date.UTC(y, mo - 1, d) - DAY0_UTC_MS) / DAY_MS);
}

export function dayOfMonth(day: number): number {
  return dayToDate(day).getUTCDate();
}

export function daysInMonthOf(day: number): number {
  const d = dayToDate(day);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** True when an obligation with this cadence and anchor falls on `day`. */
export function occursOn(cadence: string, anchorDay: number, day: number): boolean {
  if (day < anchorDay) return false;
  switch (cadence) {
    case 'once':
      return day === anchorDay;
    case 'weekly':
      return (day - anchorDay) % 7 === 0;
    case 'biweekly':
      return (day - anchorDay) % 14 === 0;
    case 'semimonthly': {
      const a = Math.min(dayOfMonth(anchorDay), 28);
      const b = Math.min(a + 15, daysInMonthOf(day));
      const dom = dayOfMonth(day);
      return dom === a || dom === b;
    }
    case 'monthly':
    default: {
      const anchorDom = dayOfMonth(anchorDay);
      const dom = dayOfMonth(day);
      const dim = daysInMonthOf(day);
      return dom === Math.min(anchorDom, dim);
    }
  }
}

/** Average occurrences per month, for monthly-equivalent amounts. */
export function perMonth(cadence: string): number {
  switch (cadence) {
    case 'once':
      return 0;
    case 'weekly':
      return 52 / 12;
    case 'biweekly':
      return 26 / 12;
    case 'semimonthly':
      return 2;
    default:
      return 1;
  }
}

export function nextOccurrence(cadence: string, anchorDay: number, fromDay: number, limit = 400): number {
  for (let d = Math.max(fromDay, anchorDay); d < fromDay + limit; d++) {
    if (occursOn(cadence, anchorDay, d)) return d;
  }
  return -1;
}
