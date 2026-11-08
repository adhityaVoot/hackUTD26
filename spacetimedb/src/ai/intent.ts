// Rule-based intent parsing. Used when the model is switched off (kill switch), unreachable,
// or fails verification twice, so every feature still returns a working, engine-computed answer.

import { dayToDate, dayToIso, isoToDay, monthIndexIn } from './dates';
import type { Lever, TwinData } from './types';

export function parseMoney(text: string): number | null {
  const m = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?/i.exec(text) ?? /(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|dollars|bucks)\b/i.exec(text);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ''));
  if (m[2] && /^(k|thousand)$/i.test(m[2])) n *= 1000;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "in June" -> next June 1st; "next year" -> +12 months; "in 3 months"; default: 30 days out. */
export function parseWhen(text: string, today: number): number {
  const q = text.toLowerCase();
  const now = dayToDate(today);
  const iso = /(\d{4}-\d{2}(?:-\d{2})?)/.exec(q);
  if (iso) {
    const d = isoToDay(iso[1]);
    if (d !== null && d > today) return d;
  }
  const inN = /in (\d+|a|one|two|three|six) (day|week|month|year)s?/.exec(q);
  if (inN) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, six: 6 };
    const n = words[inN[1]] ?? Number(inN[1]);
    const mult = { day: 1, week: 7, month: 30, year: 365 }[inN[2] as 'day'];
    return today + n * mult;
  }
  const i = monthIndexIn(q);
  if (i >= 0) {
    let y = now.getUTCFullYear();
    if (i <= now.getUTCMonth()) y += 1;
    if (/next year/.test(q) && y === now.getUTCFullYear()) y += 1;
    return isoToDay(`${y}-${String(i + 1).padStart(2, '0')}-01`)!;
  }
  if (/next year/.test(q)) return isoToDay(`${now.getUTCFullYear() + 1}-06-01`)!;
  if (/next month/.test(q)) return today + 30;
  if (/next week/.test(q)) return today + 7;
  if (/this week|tomorrow/.test(q)) return today + 3;
  return today + 30;
}

export function parseDurationMonths(text: string, fallback = 2): number {
  const words: Record<string, number> = { one: 1, a: 1, two: 2, three: 3, four: 4, six: 6, twelve: 12 };
  const m = /(\d+|one|a|two|three|four|six|twelve) (month|week)s?/.exec(text.toLowerCase());
  if (!m) return fallback;
  const n = words[m[1]] ?? Number(m[1]);
  return m[2] === 'week' ? Math.max(1, Math.round(n / 4)) : n;
}

/** Sanitized text refers to people as "member B". */
export function parseMember(text: string, data: TwinData): string | null {
  const m = /member ([A-Z])\b/.exec(text);
  if (m && data.members.some(x => x.token === m[1])) return m[1];
  if (/\b(i|my|me)\b/i.test(text)) return data.members.find(x => x.isRequester)?.token ?? null;
  return null;
}

export function isRecurring(text: string): boolean {
  return /(per|a|each|every) month|\/mo\b|monthly|rent|apartment|lease|subscription|membership|daycare|insurance/i.test(text);
}

export function recurringCategory(text: string): string {
  const q = text.toLowerCase();
  if (/rent|apartment|lease|mortgage|house|move/.test(q)) return 'housing';
  if (/car|auto|lease/.test(q)) return 'auto';
  if (/daycare|childcare|nanny/.test(q)) return 'childcare';
  if (/gym|subscription|membership|stream/.test(q)) return 'subscriptions';
  if (/insurance/.test(q)) return 'insurance';
  if (/grocer|food/.test(q)) return 'groceries';
  if (/tuition|school|college/.test(q)) return 'education';
  return 'other';
}

/** Best-effort single lever from a free-text decision ("buy a $1,500 laptop", "bigger apartment, +$600/mo in June"). */
export function decisionLever(text: string, data: TwinData): Lever {
  const amount = parseMoney(text) ?? 1000;
  const when = parseWhen(text, data.today);
  const label = shortLabel(text);
  if (isRecurring(text)) {
    return { kind: 'recurring_change', category: recurringCategory(text), monthly_delta: amount, start_date: dayToIso(when), label };
  }
  return { kind: 'one_time', amount, date: dayToIso(when), label };
}

export function shortLabel(text: string): string {
  const s = text
    .replace(/[?!.]+\s*$/, '')
    .replace(/member [A-Z]('s)?/g, '')
    .replace(/\$\s?\d[\d,]*(\.\d+)?\s*(k|thousand)?/gi, '')
    .replace(/\b(next|this|in|by) (week|month|year|january|february|march|april|may|june|july|august|september|october|november|december)\b/gi, '')
    .replace(/\b(per|a) month\b|\bmore\b|\bfor\s*$/gi, '')
    .replace(/^(can|could|should|what if|what happens if|if)\s+(we|i)\s+(afford to\s+)?/i, '')
    .replace(/[^A-Za-z0-9 $,'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(\s+(for|in|on|at|by|to|of|and|with|a|the|,))+$/i, '')
    .trim();
  const capped = s.slice(0, 48);
  return capped ? capped[0].toUpperCase() + capped.slice(1) : 'Decision';
}

// ---------- Stress tests ----------

export interface StressPlan {
  name: string;
  severity: 'mild' | 'expected' | 'severe';
  levers: Lever[];
}

export function stressPlans(text: string, data: TwinData): StressPlan[] {
  const q = text.toLowerCase();
  const start = dayToIso(data.today + 7);
  const member = parseMember(text, data) ?? data.members.find(m => !m.isRequester)?.token ?? data.members[0].token;
  const months = parseDurationMonths(text, 2);
  const endAfter = (m: number) => dayToIso(data.today + 7 + Math.round(m * 30.4375));
  const money = parseMoney(text);

  if (/job|laid off|layoff|fired|unemploy|income|furlough|paycheck/.test(q)) {
    const plans: StressPlan[] = [
      { name: `Member ${member}'s income stops for ${months} months`, severity: 'expected', levers: [{ kind: 'income_change', member, percent: -100, start_date: start, end_date: endAfter(months), label: 'Income stops' }] },
      { name: `Income stops for ${months * 2} months`, severity: 'severe', levers: [{ kind: 'income_change', member, percent: -100, start_date: start, end_date: endAfter(months * 2), label: 'Longer job search' }] },
      { name: `Income drops by half for ${months} months`, severity: 'mild', levers: [{ kind: 'income_change', member, percent: -50, start_date: start, end_date: endAfter(months), label: 'Part-time income' }] },
    ];
    return plans;
  }
  if (/medical|hospital|surgery|injur|er visit|health/.test(q)) {
    const base = money ?? 4000;
    return [
      { name: 'Medical bill', severity: 'expected', levers: [{ kind: 'one_time', amount: base, date: start, label: 'Medical bill' }] },
      { name: 'Medical bill plus lost work', severity: 'severe', levers: [{ kind: 'one_time', amount: base, date: start, label: 'Medical bill' }, { kind: 'income_change', member, percent: -50, start_date: start, end_date: endAfter(1), label: 'Unpaid leave' }] },
      { name: 'Smaller bill', severity: 'mild', levers: [{ kind: 'one_time', amount: Math.round(base / 3), date: start, label: 'Medical copays' }] },
    ];
  }
  if (/rent|landlord|lease/.test(q)) {
    const inc = money ?? 300;
    return [
      { name: 'Rent goes up', severity: 'expected', levers: [{ kind: 'recurring_change', category: 'housing', monthly_delta: inc, start_date: start, label: 'Rent increase' }] },
      { name: 'Rent goes up more', severity: 'severe', levers: [{ kind: 'recurring_change', category: 'housing', monthly_delta: inc * 2, start_date: start, label: 'Larger rent increase' }] },
      { name: 'Smaller increase', severity: 'mild', levers: [{ kind: 'recurring_change', category: 'housing', monthly_delta: Math.round(inc / 2), start_date: start, label: 'Small rent increase' }] },
    ];
  }
  // Generic shock: car, roof, appliance, travel emergency...
  const base = money ?? 2500;
  return [
    { name: 'Emergency expense', severity: 'expected', levers: [{ kind: 'one_time', amount: base, date: start, label: shortLabel(text) }] },
    { name: 'Two emergencies in a month', severity: 'severe', levers: [{ kind: 'one_time', amount: base, date: start, label: shortLabel(text) }, { kind: 'one_time', amount: Math.round(base * 0.6), date: dayToIso(data.today + 21), label: 'Second surprise bill' }] },
    { name: 'Smaller version', severity: 'mild', levers: [{ kind: 'one_time', amount: Math.round(base / 2), date: start, label: shortLabel(text) }] },
  ];
}

// ---------- Life events ----------

export interface Assumption {
  label: string;
  amount: number;
  timing: string; // "one-time on Jun 1, 2027" | "monthly from ..."
  confidence: 'low' | 'medium' | 'high';
  why: string;
  lever: Lever;
}

/** Typical US planning numbers. These are assumptions the household edits, and are shown as such. */
export function lifeEventAssumptions(text: string, data: TwinData): { event: string; assumptions: Assumption[] } {
  const q = text.toLowerCase();
  const when = parseWhen(text, data.today);
  const at = dayToIso(when);
  const before = (days: number) => dayToIso(Math.max(data.today + 7, when - days));
  const mk = (label: string, lever: Lever, why: string, confidence: Assumption['confidence'] = 'medium'): Assumption => {
    const amount = 'amount' in lever ? (lever.amount as number) : 'monthly_delta' in lever ? (lever.monthly_delta as number) : 0;
    const timing = lever.kind === 'one_time' ? `one-time, ${lever.date}` : lever.kind === 'recurring_change' ? `monthly from ${lever.start_date}` : 'change';
    return { label, amount, timing, confidence, why, lever };
  };
  const money = parseMoney(text);

  if (/marr|wedding|engag/.test(q)) {
    const wedding = money ?? 18000;
    return {
      event: 'Wedding',
      assumptions: [
        mk('Venue and catering deposit', { kind: 'one_time', amount: Math.round(wedding * 0.3), date: before(240), label: 'Venue deposit' }, 'Venues usually take about a third up front, months ahead.'),
        mk('Wedding balance', { kind: 'one_time', amount: Math.round(wedding * 0.7), date: before(14), label: 'Wedding balance' }, 'Most vendors are paid in the final weeks.'),
        mk('Rings', { kind: 'one_time', amount: 3500, date: before(180), label: 'Rings' }, 'Bought well before the date.', 'low'),
        mk('Honeymoon', { kind: 'one_time', amount: 4500, date: dayToIso(when + 7), label: 'Honeymoon' }, 'Usually right after the wedding.', 'low'),
        mk('Combined insurance savings', { kind: 'recurring_change', category: 'insurance', monthly_delta: -60, start_date: dayToIso(when + 30), label: 'Combined auto insurance' }, 'Married couples often pay less for car insurance.', 'low'),
      ],
    };
  }
  if (/baby|pregnan|child|newborn/.test(q)) {
    return {
      event: 'New baby',
      assumptions: [
        mk('Delivery out-of-pocket', { kind: 'one_time', amount: money ?? 3000, date: at, label: 'Delivery costs' }, 'Typical out-of-pocket with insurance.'),
        mk('Nursery and gear', { kind: 'one_time', amount: 2000, date: before(60), label: 'Nursery and gear' }, 'Crib, car seat, stroller before arrival.'),
        mk('Childcare', { kind: 'recurring_change', category: 'childcare', monthly_delta: 1200, start_date: dayToIso(when + 90), label: 'Childcare' }, 'Starts when parental leave ends.', 'medium'),
        mk('Diapers, formula, extras', { kind: 'recurring_change', category: 'kids', monthly_delta: 250, start_date: at, label: 'Baby supplies' }, 'Ongoing monthly costs.', 'high'),
      ],
    };
  }
  if (/house|home|down ?payment|condo/.test(q) && /buy|purchas|down/.test(q)) {
    const price = money ?? 350000;
    return {
      event: 'Home purchase',
      assumptions: [
        mk('Down payment', { kind: 'one_time', amount: Math.round(price * 0.1), date: at, label: 'Down payment' }, '10% down on the expected price.'),
        mk('Closing costs', { kind: 'one_time', amount: Math.round(price * 0.03), date: at, label: 'Closing costs' }, 'Usually 2-4% of the price.'),
        mk('Moving and furnishing', { kind: 'one_time', amount: 3000, date: dayToIso(when + 14), label: 'Moving and furnishing' }, 'Movers plus basics.', 'low'),
        mk('Housing cost change', { kind: 'recurring_change', category: 'housing', monthly_delta: 450, start_date: dayToIso(when + 30), label: 'Mortgage vs rent difference' }, 'Mortgage, tax and insurance minus current rent.', 'low'),
      ],
    };
  }
  if (/move|apartment|relocat/.test(q)) {
    return {
      event: 'Move',
      assumptions: [
        mk('Security deposit', { kind: 'one_time', amount: money ?? 2200, date: before(14), label: 'Security deposit' }, 'Usually one month of rent.'),
        mk('Movers', { kind: 'one_time', amount: 1500, date: at, label: 'Movers' }, 'Local move with a crew.', 'low'),
        mk('Higher rent', { kind: 'recurring_change', category: 'housing', monthly_delta: 500, start_date: at, label: 'Rent difference' }, 'A bigger place usually costs more.', 'low'),
      ],
    };
  }
  if (/college|tuition|university|school/.test(q)) {
    return {
      event: 'College',
      assumptions: [
        mk('Tuition per semester', { kind: 'one_time', amount: money ?? 6000, date: at, label: 'Tuition' }, 'In-state public tuition after aid.'),
        mk('Housing and food', { kind: 'recurring_change', category: 'education', monthly_delta: 900, start_date: at, label: 'Student living costs' }, 'Room, board and books.', 'low'),
      ],
    };
  }
  if (/car|vehicle/.test(q)) {
    return {
      event: 'New car',
      assumptions: [
        mk('Down payment', { kind: 'one_time', amount: money ?? 4000, date: at, label: 'Car down payment' }, 'About 10-15% of the price.'),
        mk('Car payment', { kind: 'recurring_change', category: 'auto', monthly_delta: 520, start_date: dayToIso(when + 30), label: 'Car payment' }, 'A 60-month loan on a mid-price car.'),
        mk('Insurance increase', { kind: 'recurring_change', category: 'insurance', monthly_delta: 60, start_date: at, label: 'Insurance increase' }, 'Newer cars cost more to insure.', 'low'),
      ],
    };
  }
  return {
    event: shortLabel(text),
    assumptions: [mk('Upfront cost', { kind: 'one_time', amount: money ?? 2000, date: at, label: shortLabel(text) }, 'A placeholder until you add details.', 'low')],
  };
}

// ---------- Coach routing (rule-based backup for the Nemotron router) ----------

export function classifyMessage(text: string): 'twin' | 'ripple' | 'stress' | 'life_event' | 'memory' | 'opportunity' | 'health' | 'briefing' {
  const q = text.toLowerCase();
  if (/\bwhy did we|did we (decide|agree)|last (year|month|time)|remember when|what did we (decide|agree)/.test(q)) return 'memory';
  if (/\blos(e|es|ing|t) (his|her|my|their|our|a|the) job|laid off|layoff|job loss|fired|unemploy|medical|hospital|emergency|car (broke|repair)|rent (goes|went) up|what if .*(lose|lost)/.test(q)) return 'stress';
  if (/marr|wedding|baby|pregnan|buy(ing)? a (house|home)|down ?payment|retire|college|moving to|relocat/.test(q)) return 'life_event';
  if (/save money|where can we save|cut costs|opportunit|subscriptions?|wasting|cheaper/.test(q)) return 'opportunity';
  if (/how are we doing|our (score|health|vitals)|explain .*(score|vitals|runway|utilization)|financial health/.test(q)) return 'health';
  if (/coming up|next (few )?weeks|outlook|bills due|upcoming|this month look/.test(q)) return 'briefing';
  if (/what happens if|knock-on|ripple|consequences|effect of/.test(q)) return 'ripple';
  return 'twin';
}
