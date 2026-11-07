import type { Cadence } from './types';

/** Sim day 0. Sunday. */
export const DEMO_START_DATE = '2026-11-01';

const DAY_MS = 86_400_000;

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function parseIso(iso: string): Ymd {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

function formatIso(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function utcMillis(iso: string): number {
  const { y, m, d } = parseIso(iso);
  return Date.UTC(y, m - 1, d);
}

export function simDayToIso(day: number): string {
  const dt = new Date(utcMillis(DEMO_START_DATE) + day * DAY_MS);
  return formatIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function isoToSimDay(iso: string): number {
  return Math.round((utcMillis(iso) - utcMillis(DEMO_START_DATE)) / DAY_MS);
}

function parts(day: number): Ymd {
  return parseIso(simDayToIso(day));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Friday and Saturday. Day 0 (2026-11-01) is Sunday. */
export function isWeekend(day: number): boolean {
  const dow = new Date(utcMillis(simDayToIso(day))).getUTCDay();
  return dow === 5 || dow === 6;
}

function ceilDiv(n: number, d: number): number {
  if (n >= 0) return Math.floor((n + d - 1) / d);
  return -Math.floor(-n / d);
}

function semiMonthDoms(year: number, month: number, dom: number): number[] {
  const dim = daysInMonth(year, month);
  const first = Math.min(dom, dim);
  const second = dom + 15 <= dim ? dom + 15 : dim;
  return first === second ? [first] : [first, second].sort((a, b) => a - b);
}

/**
 * Days in `[fromDay, toDay]` when a cadence fires.
 * Monthly repeats the anchor's calendar day (clamped in short months).
 * Semimonthly adds the day 15 days later, clamped to the month.
 * Biweekly steps 14 days from the anchor. Once is the anchor alone.
 */
export function expandCadence(
  cadence: Cadence,
  anchorDay: number,
  fromDay: number,
  toDay: number,
): number[] {
  if (toDay < fromDay) return [];
  if (cadence === 'once') {
    return anchorDay >= fromDay && anchorDay <= toDay ? [anchorDay] : [];
  }
  if (cadence === 'biweekly') {
    const out: number[] = [];
    for (
      let day = anchorDay + ceilDiv(fromDay - anchorDay, 14) * 14;
      day <= toDay;
      day += 14
    ) {
      if (day >= fromDay) out.push(day);
    }
    return out;
  }

  const from = parts(fromDay);
  const to = parts(toDay);
  const dom = parts(anchorDay).d;
  const out: number[] = [];
  for (let y = from.y, m = from.m; y < to.y || (y === to.y && m <= to.m); ) {
    const doms = cadence === 'monthly' ? [Math.min(dom, daysInMonth(y, m))] : semiMonthDoms(y, m, dom);
    for (const dayOfMonth of doms) {
      const day = isoToSimDay(formatIso(y, m, dayOfMonth));
      if (day >= fromDay && day <= toDay) out.push(day);
    }
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
