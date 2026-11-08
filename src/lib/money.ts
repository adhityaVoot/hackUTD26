/** Day 0 matches engine/calendar.ts: 1 Nov 2026 UTC. */
const DEMO_START_UTC = Date.UTC(2026, 10, 1);
const DAY_MS = 86_400_000;

export function fmtCents(cents: bigint | number): string {
  const value = typeof cents === 'bigint' ? cents : BigInt(Math.round(cents));
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const dollars = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const remainder = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${dollars}.${remainder}`;
}

/** `ratio` is a fraction: 0.55 becomes 55%. */
export function fmtPct(ratio: number): string {
  const pct = Math.round(ratio * 1000) / 10;
  const text = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  return `${text}%`;
}

export function dayToDate(simDay: number): string {
  const date = new Date(DEMO_START_UTC + simDay * DAY_MS);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}
