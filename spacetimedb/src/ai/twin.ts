// The household "digital twin": a deterministic expected-value projection with an analytic
// uncertainty band. Every number Nemotron is allowed to say comes from here.
//
// This is deliberately lighter than the Monte Carlo engine in engine/forecast.ts: it runs in
// well under a millisecond per scenario, so the agent can try several forks inside one
// procedure call. When the Monte Carlo engine lands, Sentinel and the Vitals Board should use
// it; the agent can keep using this for quick what-ifs or delegate to it.

import { dayToIso, dayToLabel, etaLabel, isoToDay, NO_ETA, occursOn, perMonth } from './dates';
import type {
  Band,
  ForecastPoint,
  GoalProjection,
  GoalShift,
  Lever,
  ResolvedLever,
  TwinData,
  TwinDiff,
  TwinResult,
  VitalDelta,
  VitalKey,
  VitalValue,
} from './types';

export const FORECAST_DAYS = 60;
export const GOAL_HORIZON_DAYS = 365 * 5;
export const MAX_LEVER_DAYS = 365 * 2;
export const MAX_LEVER_AMOUNT = 1_000_000;
const CRUNCH_THRESHOLD = 0.25;

const LIQUID_KINDS = new Set(['checking', 'savings']);
const DEBT_KINDS = new Set(['credit_card', 'auto_loan', 'personal_loan', 'mortgage']);
const DEBT_OBLIGATIONS = new Set(['mortgage', 'auto_loan', 'card_payment', 'personal_loan', 'loan']);
const ESSENTIAL_CATEGORIES = new Set(['groceries', 'gas', 'utilities', 'housing', 'insurance']);

export const SPEND_CATEGORIES = [
  'groceries',
  'dining',
  'gas',
  'shopping',
  'entertainment',
  'utilities',
  'housing',
  'auto',
  'insurance',
  'subscriptions',
  'kids',
  'travel',
  'health',
  'education',
  'childcare',
  'other',
];

// ---------- Lever validation ----------

export class LeverError extends Error {}

function num(v: unknown, name: string): number {
  const n = typeof v === 'string' ? Number(v.replace(/[$,]/g, '')) : Number(v);
  if (!Number.isFinite(n)) throw new LeverError(`${name} must be a number`);
  return n;
}

function day(data: TwinData, iso: unknown, name: string, optional = false): number {
  if ((iso === undefined || iso === null || iso === '') && optional) return -1;
  if (typeof iso !== 'string' || !iso) throw new LeverError(`${name} is missing; give it as YYYY-MM-DD`);
  // Accept 2026-11-14T00:00:00Z and 2026/11/14 too.
  const d = isoToDay(iso.trim().slice(0, 10).replace(/\//g, '-'));
  if (d === null) throw new LeverError(`${name} "${iso}" is not a date; use YYYY-MM-DD`);
  // "March" written as last March: roll forward a year at a time (models often assume the wrong year).
  let rolled = d;
  for (let y = 1; d < data.today - 30 && rolled < data.today && y <= 3; y++) rolled = isoToDay(`${Number(iso.slice(0, 4)) + y}${iso.trim().slice(4, 10)}`) ?? rolled;
  if (rolled >= data.today) {
    const snappedRolled = Math.max(rolled, data.today + 1);
    if (snappedRolled > data.today + MAX_LEVER_DAYS) throw new LeverError(`${name} is more than 2 years out`);
    return snappedRolled;
  }
  // Dates in the past snap to tomorrow: "this month" questions are common.
  const snapped = Math.max(d, data.today + 1);
  if (snapped > data.today + MAX_LEVER_DAYS) throw new LeverError(`${name} is more than 2 years out`);
  return snapped;
}

function endHint(end: unknown, start: number): string {
  const e = String(end);
  const nextYear = /^\d{4}-/.test(e) ? `${Number(e.slice(0, 4)) + 1}${e.slice(4, 10)}` : '';
  return `end_date ${e} must be after start_date ${dayToIso(start)}${nextYear ? `. Did you mean ${nextYear}?` : ''}`;
}

function amount(v: unknown, name: string, allowNegative = false, cap = MAX_LEVER_AMOUNT): number {
  const n = num(v, name);
  if (!allowNegative && n <= 0) throw new LeverError(`${name} must be positive`);
  if (Math.abs(n) > cap) throw new LeverError(`${name} $${Math.round(Math.abs(n)).toLocaleString('en-US')} is beyond what this household could plausibly spend (limit $${Math.round(cap).toLocaleString('en-US')})`);
  return Math.round(n * 100) / 100;
}

/** Sanity cap for one amount: the larger of $1M and 20x (household cash + a year of income). */
export function leverCap(data: TwinData): number {
  const cash = data.accounts.filter(a => LIQUID_KINDS.has(a.kind)).reduce((t, a) => t + Math.max(0, a.balance), 0);
  const yearIncome = data.obligations.filter(o => o.kind === 'income').reduce((t, o) => t + o.amount * perMonth(o.cadence) * 12, 0);
  return Math.max(MAX_LEVER_AMOUNT, 20 * (cash + yearIncome));
}

export function cleanLabel(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw : '';
  const cleaned = s
    .replace(/[^A-Za-z0-9 .,'&()/%$-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

/** Validates one model-proposed lever against the requester's view. Throws LeverError with a reason the model can act on. */
export function resolveLever(data: TwinData, lever: Lever): ResolvedLever {
  const base: ResolvedLever = {
    kind: lever.kind,
    label: '',
    amount: 0,
    day: data.today + 1,
    endDay: -1,
    from: '',
    to: '',
    category: '',
    percent: 0,
    flowIn: false,
    source: lever,
  };
  const visibleAccount = (tok: unknown, name: string) => {
    const a = data.accounts.find(x => x.token === tok);
    if (!a || a.visibility === 'signal') {
      const ok = data.accounts.filter(x => x.visibility !== 'signal').map(x => `${x.token} (${x.kind})`).join(', ');
      const t = String(tok);
      const hint = t.startsWith('goal')
        ? ' Goals are funded from monthly surplus, not by transfer; to save toward one, transfer to a savings account or cut a recurring cost.'
        : /^(member|[A-Z]$)/.test(t)
          ? " To send money to a member, use one_time or recurring_change (category 'other') instead of transfer."
          : '';
      throw new LeverError(`${name} "${t}" is not an account token; use one of: ${ok}.${hint}`);
    }
    return a;
  };
  const visibleObligation = (tok: unknown) => {
    const o = data.obligations.find(x => x.token === tok);
    if (!o || !o.visible) {
      const ok = data.obligations.filter(x => x.visible).map(x => `${x.token} (${x.label})`).join(', ');
      throw new LeverError(`obligation "${String(tok)}" is not a bill token; use one of: ${ok}`);
    }
    return o;
  };
  const cap = leverCap(data);
  const l = { ...(lever as Record<string, unknown>) };
  // Models mix up date field names; accept either.
  l.date ??= l.start_date;
  l.start_date ??= l.date;
  // "Pay it down" / "trim dining" / "pause it" without a date means: starting tomorrow.
  if (['transfer', 'extra_payment', 'pause_obligation', 'recurring_change'].includes(lever.kind)) {
    l.date ??= dayToIso(data.today + 1);
    l.start_date ??= l.date;
  }
  if (lever.kind === 'recurring_change' || (lever.kind === 'income_change' && l.percent === undefined)) l.monthly_delta ??= l.amount;
  switch (lever.kind) {
    case 'one_time': {
      if (l.account !== undefined && l.account !== '') visibleAccount(l.account, 'account');
      return {
        ...base,
        label: cleanLabel(l.label, 'One-time item'),
        amount: amount(l.amount, 'amount', false, cap),
        day: day(data, l.date, 'date'),
        from: typeof l.account === 'string' ? l.account : '',
        flowIn: l.flow === 'in',
      };
    }
    case 'recurring_change': {
      const category = String(l.category ?? '').toLowerCase();
      if (!SPEND_CATEGORIES.includes(category)) {
        throw new LeverError(`category must be one of ${SPEND_CATEGORIES.join(', ')}`);
      }
      const start = day(data, l.start_date, 'start_date');
      const end = day(data, l.end_date, 'end_date', true);
      if (end !== -1 && end <= start) throw new LeverError(endHint(l.end_date, start));
      return {
        ...base,
        label: cleanLabel(l.label, `${category} change`),
        amount: amount(l.monthly_delta, 'monthly_delta', true, cap),
        day: start,
        endDay: end,
        category,
      };
    }
    case 'income_change': {
      const member = data.members.find(m => m.token === l.member);
      if (!member) throw new LeverError(`member must be one of ${data.members.map(m => m.token).join(', ')}`);
      const start = day(data, l.start_date, 'start_date');
      const end = day(data, l.end_date, 'end_date', true);
      if (end !== -1 && end <= start) throw new LeverError(endHint(l.end_date, start));
      const hasPct = l.percent !== undefined && l.percent !== null;
      const pct = hasPct ? num(l.percent, 'percent') : 0;
      if (hasPct && (pct < -100 || pct > 200)) throw new LeverError('percent must be between -100 and 200');
      const delta = !hasPct ? amount(l.monthly_delta, 'monthly_delta', true, cap) : 0;
      return {
        ...base,
        label: cleanLabel(l.label, 'Income change'),
        amount: delta,
        percent: pct,
        day: start,
        endDay: end,
        from: member.token,
      };
    }
    case 'transfer': {
      const from = visibleAccount(l.from, 'from');
      const to = visibleAccount(l.to, 'to');
      if (from.token === to.token) throw new LeverError('from and to must differ');
      if (!LIQUID_KINDS.has(from.kind)) throw new LeverError('transfers must come from checking or savings');
      return {
        ...base,
        label: cleanLabel(l.label, 'Transfer'),
        amount: amount(l.amount, 'amount', false, cap),
        day: day(data, l.date, 'date'),
        from: from.token,
        to: to.token,
      };
    }
    case 'extra_payment': {
      const loan = visibleAccount(l.loan, 'loan');
      if (!DEBT_KINDS.has(loan.kind)) throw new LeverError('loan must be a loan or credit card account');
      return {
        ...base,
        label: cleanLabel(l.label, 'Extra payment'),
        amount: amount(l.amount, 'amount', false, cap),
        day: day(data, l.date, 'date'),
        to: loan.token,
      };
    }
    case 'move_obligation': {
      const o = visibleObligation(l.obligation);
      if (!o.flexible) throw new LeverError(`obligation ${o.token} is not flexible`);
      return {
        ...base,
        label: cleanLabel(l.label, `Move ${o.label}`),
        day: day(data, l.new_date, 'new_date'),
        from: o.token,
      };
    }
    case 'pause_obligation': {
      const o = visibleObligation(l.obligation);
      if (o.kind === 'income') throw new LeverError('use income_change for income');
      if (['mortgage', 'auto_loan', 'card_payment', 'personal_loan', 'loan', 'insurance', 'rent', 'tuition'].includes(o.kind)) {
        throw new LeverError(`${o.label} can't be skipped (it is a ${o.kind.replace('_', ' ')}); use move_obligation to shift it after payday instead`);
      }
      const start = day(data, l.start_date, 'start_date');
      const end = day(data, l.end_date, 'end_date', true);
      return {
        ...base,
        label: cleanLabel(l.label, `Pause ${o.label}`),
        day: start,
        endDay: end,
        from: o.token,
        amount: o.amount,
      };
    }
    default:
      throw new LeverError(
        `unknown lever kind "${String(l.kind)}"; use one_time, recurring_change, income_change, transfer, extra_payment, move_obligation or pause_obligation`,
      );
  }
}

// ---------- Projection ----------

const active = (l: ResolvedLever, d: number) => d >= l.day && (l.endDay === -1 || d < l.endDay);

function memberMonthlyIncome(data: TwinData, member: string): number {
  return data.obligations
    .filter(o => o.kind === 'income' && o.owner === member)
    .reduce((s, o) => s + o.amount * perMonth(o.cadence), 0);
}

interface DailyFlow {
  mean: number;
  variance: number;
}

/** Expected household-liquid cash flow on each day from today+1 .. today+horizon. */
function dailyFlows(data: TwinData, levers: ResolvedLever[], horizon: number): DailyFlow[] {
  const liquid = new Set(data.accounts.filter(a => LIQUID_KINDS.has(a.kind)).map(a => a.token));
  const moves = new Map<string, number>(); // obligation token -> new anchor day
  for (const l of levers) if (l.kind === 'move_obligation') moves.set(l.from, l.day);
  const pauses = levers.filter(l => l.kind === 'pause_obligation');

  const baseMean = data.spending.reduce((s, c) => s + c.dailyMean, 0);
  const baseVar = data.spending.reduce((s, c) => s + c.dailyVar, 0);
  const incomePct = levers.filter(l => l.kind === 'income_change');

  const out: DailyFlow[] = [];
  for (let i = 1; i <= horizon; i++) {
    const d = data.today + i;
    let mean = -baseMean;
    let variance = baseVar;

    for (const o of data.obligations) {
      const fromLiquid = liquid.has(o.accountToken);
      // Scheduled transfers move money between the household's own accounts: net zero.
      if (!fromLiquid || o.kind === 'transfer') continue;
      let anchor = o.anchorDay;
      const moved = moves.get(o.token);
      if (moved !== undefined) {
        // Shift the whole schedule so its next occurrence lands on the new date.
        anchor = moved;
        if (d < moved && occursOn(o.cadence, o.anchorDay, d) && d > data.today) {
          // Occurrences between today and the moved date are skipped (they've been pushed).
          continue;
        }
      }
      if (!occursOn(o.cadence, anchor, d)) continue;
      if (pauses.some(p => p.from === o.token && active(p, d))) continue;
      if (o.kind === 'income') {
        let amt = o.amount;
        for (const l of incomePct) {
          if (l.from === o.owner && l.percent !== 0 && active(l, d)) amt *= 1 + l.percent / 100;
        }
        mean += amt;
      } else {
        mean -= o.amount;
      }
    }

    for (const l of levers) {
      switch (l.kind) {
        case 'one_time':
          if (d === l.day) mean += l.flowIn ? l.amount : -l.amount;
          break;
        case 'recurring_change':
          if (active(l, d)) mean -= l.amount / 30.4375;
          break;
        case 'income_change':
          if (l.percent === 0 && active(l, d)) mean += l.amount / 30.4375;
          break;
        case 'extra_payment':
        case 'transfer': {
          if (l.kind === 'transfer' && liquid.has(l.to)) break; // between the household's own cash accounts
          // Paying down a card or loan leaves household cash on the day, then saves its interest every day after.
          if (d === l.day) mean -= l.amount;
          else if (d > l.day) mean += interestPerDay(data, l);
          break;
        }
        default:
          break;
      }
    }
    out.push({ mean, variance });
  }
  return out;
}

function interestPerDay(data: TwinData, l: ResolvedLever): number {
  const debt = data.accounts.find(a => a.token === l.to);
  return debt && DEBT_KINDS.has(debt.kind) ? (Math.min(l.amount, debt.balance) * debt.aprPct) / 100 / 365 : 0;
}

function normCdf(x: number): number {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

const round = (n: number, dp = 0) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

function band(key: VitalKey, v: number): Band {
  switch (key) {
    case 'runway':
      return v >= 3 ? 'green' : v >= 1 ? 'yellow' : 'red';
    case 'crunch_risk':
      return v < 0.1 ? 'green' : v <= 0.25 ? 'yellow' : 'red';
    case 'dti':
      return v <= 0.36 ? 'green' : v <= 0.43 ? 'yellow' : 'red';
    case 'utilization':
      return v <= 0.3 ? 'green' : v <= 0.5 ? 'yellow' : 'red';
    case 'savings_rate':
      return v >= 0.15 ? 'green' : v >= 0.05 ? 'yellow' : 'red';
    case 'goal_track':
      return v <= 0 ? 'green' : v <= 91 ? 'yellow' : 'red';
    case 'score':
      return v >= 70 ? 'green' : v >= 50 ? 'yellow' : 'red';
  }
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function displayVital(key: VitalKey, v: number): string {
  switch (key) {
    case 'runway':
      return `${round(v, 1)} months`;
    case 'crunch_risk':
    case 'dti':
    case 'utilization':
    case 'savings_rate':
      return `${round(v * 100)}%`;
    case 'goal_track':
      return v <= 0 ? 'on time' : `${round(v)} days late`;
    case 'score':
      return `${round(v)}/100`;
  }
}

export function simulate(data: TwinData, levers: ResolvedLever[] = []): TwinResult {
  const liquidAccts = data.accounts.filter(a => LIQUID_KINDS.has(a.kind));
  const startLiquid = liquidAccts.reduce((s, a) => s + a.balance, 0);
  const buffer = data.accounts.filter(a => a.kind === 'checking').reduce((s, a) => s + a.buffer, 0);

  const flows = dailyFlows(data, levers, GOAL_HORIZON_DAYS);

  const points: ForecastPoint[] = [];
  let bal = startLiquid;
  let variance = 0;
  let minBalance = Infinity;
  let minDay = data.today + 1;
  let firstCrunchDay = -1;
  let peakCrunchRisk = 0;
  let peakCrunchDay = data.today;
  for (let i = 0; i < FORECAST_DAYS; i++) {
    bal += flows[i].mean;
    variance += flows[i].variance;
    const sd = Math.sqrt(variance);
    const d = data.today + i + 1;
    const p = sd > 0 ? normCdf((buffer - bal) / sd) : bal < buffer ? 1 : 0;
    points.push({ day: d, p10: round(bal - 1.2816 * sd), p50: round(bal), p90: round(bal + 1.2816 * sd), pBelowBuffer: round(p, 3) });
    if (bal < minBalance) {
      minBalance = bal;
      minDay = d;
    }
    if (firstCrunchDay === -1 && p > CRUNCH_THRESHOLD) firstCrunchDay = d;
    if (i < 30 && p > peakCrunchRisk) {
      peakCrunchRisk = p;
      peakCrunchDay = d;
    }
  }

  // Lowest expected cash over 12 months (stress tests outlast the 60-day window).
  let low12 = Infinity;
  let low12Day = data.today + 1;
  let run = startLiquid;
  for (let i = 0; i < 365; i++) {
    run += flows[i].mean;
    if (run < low12) {
      low12 = run;
      low12Day = data.today + i + 1;
    }
  }

  // Monthly expected flows (baseline structure + recurring levers active at their start).
  const monthly = (pred: (o: TwinData['obligations'][number]) => boolean) =>
    data.obligations.filter(pred).reduce((s, o) => s + o.amount * perMonth(o.cadence), 0);
  let monthlyIncome = monthly(o => o.kind === 'income');
  let monthlyObl = monthly(o => o.kind !== 'income' && o.kind !== 'transfer');
  let monthlySpend = data.spending.reduce((s, c) => s + c.dailyMean, 0) * 30.4375;
  const essentialSpend =
    data.spending.filter(c => ESSENTIAL_CATEGORIES.has(c.category)).reduce((s, c) => s + c.dailyMean, 0) * 30.4375;
  let essentialMonthly = monthlyObl + essentialSpend;
  const debtMonthly = monthly(o => DEBT_OBLIGATIONS.has(o.kind));
  // Steady-state view of the fork: recurring levers count once they've started, if they're open-ended or long.
  for (const l of levers) {
    const longLived = l.endDay === -1 || l.endDay - l.day >= 90;
    if (!longLived) continue;
    if (l.kind === 'recurring_change') {
      monthlySpend += l.amount;
      if (ESSENTIAL_CATEGORIES.has(l.category)) essentialMonthly += l.amount;
    } else if (l.kind === 'income_change') {
      monthlyIncome += l.percent !== 0 ? (memberMonthlyIncome(data, l.from) * l.percent) / 100 : l.amount;
    } else if (l.kind === 'extra_payment' || l.kind === 'transfer') {
      monthlyObl -= interestPerDay(data, l) * 30.4375; // interest no longer owed
    } else if (l.kind === 'pause_obligation') {
      const o = data.obligations.find(x => x.token === l.from);
      if (o) {
        monthlyObl -= o.amount * perMonth(o.cadence);
        essentialMonthly -= o.amount * perMonth(o.cadence);
      }
    }
  }
  const monthlyOutflow = monthlyObl + monthlySpend;
  const monthlySurplus = monthlyIncome - monthlyOutflow;

  // Goals are funded by the household's net surplus, split evenly. A one-time cost therefore
  // delays every goal by cost / daily surplus: the "laptop delays the vacation by 18 days" math.
  const goals: GoalProjection[] = [];
  const share = data.goals.length > 0 ? 1 / data.goals.length : 0;
  for (const g of data.goals) {
    let cum = g.saved;
    let eta = cum >= g.target ? data.today : NO_ETA;
    for (let i = 0; i < flows.length && eta === NO_ETA; i++) {
      cum += flows[i].mean * share;
      if (cum >= g.target) eta = data.today + i + 1;
    }
    goals.push({
      token: g.token,
      name: g.name,
      etaDay: eta,
      targetDay: g.targetDay,
      lateDays: eta === NO_ETA ? GOAL_HORIZON_DAYS : Math.max(0, eta - g.targetDay),
    });
  }

  const cards = data.accounts.filter(a => a.kind === 'credit_card');
  const cardLimit = cards.reduce((s, a) => s + a.limit, 0);
  const utilization = cardLimit > 0 ? cards.reduce((s, a) => s + a.balance, 0) / cardLimit : 0;
  const runway = essentialMonthly > 0 ? Math.max(0, startLiquid) / essentialMonthly : 12;
  const dti = monthlyIncome > 0 ? debtMonthly / monthlyIncome : 1;
  const savingsRate = monthlyIncome > 0 ? monthlySurplus / monthlyIncome : -1;
  const worstLate = goals.length ? Math.max(...goals.map(g => g.lateDays)) : 0;

  const scoreParts: [number, number][] = [
    [25, 1 - clamp01(peakCrunchRisk / 0.5)],
    [20, clamp01(runway / 6)],
    [15, clamp01((0.6 - dti) / 0.6)],
    [15, clamp01(1 - utilization)],
    [15, clamp01(savingsRate / 0.3)],
    [10, goals.length ? clamp01(1 - worstLate / 182) : 1],
  ];
  const score = scoreParts.reduce((s, [w, v]) => s + w * v, 0);

  const raw: [VitalKey, number][] = [
    ['runway', runway],
    ['crunch_risk', peakCrunchRisk],
    ['dti', dti],
    ['utilization', utilization],
    ['savings_rate', savingsRate],
    ['goal_track', worstLate],
    ['score', score],
  ];
  const vitals: VitalValue[] = raw.map(([key, value]) => ({
    key,
    value: round(value, 4),
    band: band(key, value),
    display: displayVital(key, value),
  }));

  return {
    points,
    startLiquid: round(startLiquid),
    buffer: round(buffer),
    minBalance: round(minBalance),
    minDay,
    minBalance12m: round(low12),
    minDay12m: low12Day,
    firstCrunchDay,
    peakCrunchRisk: round(peakCrunchRisk, 3),
    peakCrunchDay,
    monthlyIncome: round(monthlyIncome),
    monthlyOutflow: round(monthlyOutflow),
    monthlySurplus: round(monthlySurplus),
    essentialMonthly: round(essentialMonthly),
    goals,
    vitals,
  };
}

// Lower is better for these; higher is better for the rest.
const LOWER_IS_BETTER = new Set<VitalKey>(['crunch_risk', 'dti', 'utilization', 'goal_track']);

export function diff(before: TwinResult, after: TwinResult): TwinDiff {
  const vitals: VitalDelta[] = before.vitals.map(b => {
    const a = after.vitals.find(v => v.key === b.key)!;
    const eps = b.key === 'goal_track' ? 0.5 : b.key === 'score' ? 0.5 : 0.0005;
    let direction: VitalDelta['direction'] = 'same';
    if (Math.abs(a.value - b.value) > eps) {
      const up = a.value > b.value;
      direction = up !== LOWER_IS_BETTER.has(b.key) ? 'better' : 'worse';
    }
    return { key: b.key, before: b.display, after: a.display, beforeValue: b.value, afterValue: a.value, direction };
  });
  const goals: GoalShift[] = before.goals.map(g => {
    const a = after.goals.find(x => x.token === g.token)!;
    const shift = g.etaDay === NO_ETA || a.etaDay === NO_ETA ? (g.etaDay === a.etaDay ? 0 : a.etaDay === NO_ETA ? GOAL_HORIZON_DAYS : -GOAL_HORIZON_DAYS) : a.etaDay - g.etaDay;
    return { token: g.token, name: g.name, beforeEta: etaLabel(g.etaDay), afterEta: etaLabel(a.etaDay), shiftDays: shift };
  });
  const breach = after.points.find(p => p.p50 < after.buffer);
  return {
    vitals,
    goals,
    minBalanceBefore: before.minBalance,
    minBalanceAfter: after.minBalance,
    minDayAfter: dayToLabel(after.minDay),
    minBalance12mBefore: before.minBalance12m,
    minBalance12mAfter: after.minBalance12m,
    minDay12mAfter: dayToLabel(after.minDay12m),
    crunchBefore: round(before.peakCrunchRisk * 100),
    crunchAfter: round(after.peakCrunchRisk * 100),
    crunchDayAfter: dayToLabel(after.peakCrunchDay),
    bufferBreachDay: breach ? dayToLabel(breach.day) : '',
    monthlySurplusBefore: before.monthlySurplus,
    monthlySurplusAfter: after.monthlySurplus,
  };
}

/** How much per month to set aside from `fromDay` to reach `target` by `byDay`. */
export function requiredMonthly(target: number, fromDay: number, byDay: number): number {
  const months = Math.max(1, (byDay - fromDay) / 30.4375);
  return round(target / months);
}

/** Days until the expected household liquid balance first drops below zero, or -1. */
export function survivalDays(data: TwinData, levers: ResolvedLever[]): number {
  const start = data.accounts.filter(a => LIQUID_KINDS.has(a.kind)).reduce((s, a) => s + a.balance, 0);
  const flows = dailyFlows(data, levers, 730);
  let bal = start;
  for (let i = 0; i < flows.length; i++) {
    bal += flows[i].mean;
    if (bal < 0) return i + 1;
  }
  return -1;
}
