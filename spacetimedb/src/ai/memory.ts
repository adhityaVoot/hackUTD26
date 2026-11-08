// Financial Memory: deterministic retrieval over the household's decision log.
// Nemotron only sees the few entries retrieved here, never the whole log.

import { dayToDate, dayToLabel, monthIndexIn } from './dates';
import { sanitizeUserText } from './gateway';
import { looksLikeInjection } from './snapshot';

export interface MemoryRow {
  id: bigint;
  day: number;
  outcome: string; // merged | declined | deferred | note
  title: string;
  reasoning: string;
  tags: string;
  amountCents: bigint;
  scenarioId: bigint;
}

export interface MemoryItem {
  memory: string; // mem_<n>, a per-job reference the model cites
  date: string;
  outcome: string;
  title: string;
  reasoning: string;
  amount: number;
}

const STOP = new Set(
  'a an and are as at be but by did do does for from had has have how i in is it its last me my of on or our so that the their them then there they this to was we were what when where which who why will with you your us decide decided decision choose chose'.split(
    ' ',
  ),
);

function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/, '');
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/** Month the question refers to ("last November" -> most recent past November), as [year, monthIndex]. */
function referencedMonth(query: string, today: number): [number, number] | null {
  const q = query.toLowerCase();
  const idx = monthIndexIn(q);
  if (idx === -1) return null;
  const now = dayToDate(today);
  let year = now.getUTCFullYear();
  if (idx > now.getUTCMonth() || (/\blast\b/.test(q) && idx === now.getUTCMonth())) year -= 1;
  return [year, idx];
}

export function searchMemory(
  rows: MemoryRow[],
  query: string,
  today: number,
  nameToToken: Map<string, string>,
  limit = 5,
): MemoryItem[] {
  const qt = new Set(tokens(query));
  const month = referencedMonth(query, today);
  const df = new Map<string, number>();
  const docTokens = rows.map(r => {
    const t = new Set([...tokens(r.title), ...tokens(r.tags), ...tokens(r.reasoning)]);
    for (const w of t) df.set(w, (df.get(w) ?? 0) + 1);
    return t;
  });
  const n = Math.max(1, rows.length);

  const scored = rows.map((r, i) => {
    let score = 0;
    const titleTags = new Set([...tokens(r.title), ...tokens(r.tags)]);
    for (const w of qt) {
      if (!docTokens[i].has(w)) continue;
      const idf = Math.log(1 + n / (df.get(w) ?? 1));
      score += idf * (titleTags.has(w) ? 2 : 1);
    }
    if (month) {
      const d = dayToDate(r.day);
      if (d.getUTCFullYear() === month[0] && d.getUTCMonth() === month[1]) score += 3;
    }
    score += Math.max(0, 0.3 - (today - r.day) / 3650); // small recency tiebreak
    return { r, score };
  });

  return scored
    .filter(s => s.score > 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s, i) => ({
      memory: `mem_${i + 1}`,
      date: dayToLabel(s.r.day),
      outcome: s.r.outcome,
      title: looksLikeInjection(s.r.title) ? '[title withheld: flagged]' : sanitizeUserText(s.r.title, nameToToken, 120),
      reasoning: looksLikeInjection(s.r.reasoning)
        ? '[note withheld: flagged as a possible prompt injection]'
        : sanitizeUserText(s.r.reasoning, nameToToken, 500),
      amount: Math.round(Number(s.r.amountCents) / 100),
    }));
}
