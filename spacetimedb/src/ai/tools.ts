// Tools Nemotron can call. Read tools return the requester's filtered view; simulate_scenario
// is the only way to get consequence numbers, and it validates every lever. Nothing here can
// move money, vote, or read raw tables.

import { dayToIso, dayToLabel, etaLabel, isoToDay, NO_ETA, nextOccurrence } from './dates';
import { collectNumbers } from './gateway';
import { lookupInformation } from './lookup';
import { searchMemory, type MemoryItem, type MemoryRow } from './memory';
import type { HttpLike, ToolSpec } from './model';
import { findOpportunities, type Opportunity } from './opportunities';
import { overviewForModel, type Snapshot } from './snapshot';
import { diff, LeverError, requiredMonthly, resolveLever, simulate, SPEND_CATEGORIES, survivalDays } from './twin';
import type { AgentStep, FeatureKind, Lever, ResolvedLever, TwinDiff, TwinResult } from './types';

export interface Sim {
  simId: string;
  title: string;
  levers: ResolvedLever[];
  result: TwinResult;
  diff: TwinDiff;
  survivalDays: number;
  firstDay: number; // earliest lever day
  cashOnFirstDayBefore: number | null; // expected household cash that day, null if beyond 60 days
  cashOnFirstDayAfter: number | null;
}

/** Live bank lookups (Capital One Nessie). Injected by the module; null when not configured. */
export interface BankLookup {
  account(token: string): { balance: number } | { error: string };
  bills(token: string): { amount: number; date: string; status: string }[] | { error: string };
}

export interface AgentState {
  feature: FeatureKind;
  snap: Snapshot;
  baseline: TwinResult;
  sims: Map<string, Sim>;
  memoryRows: MemoryRow[];
  memoryHits: Map<string, MemoryItem>;
  opportunities: Opportunity[] | null;
  allowedNumbers: Set<number>;
  steps: AgentStep[];
  question: string;
  context: Record<string, unknown>; // feature extras (negotiation positions, ...)
  lastSavings: Record<string, unknown> | null; // last required_monthly_savings result, for {savings.*} slots
  bank: BankLookup | null;
  http: HttpLike | null; // public lookup; household records are never sent through it
  lastBudget: Record<string, unknown> | null; // last spending_budget result, for {budget.*} slots
  sources: Map<string, string>; // url -> title for every page lookup_information returned
}

export function newState(
  feature: FeatureKind,
  snap: Snapshot,
  question: string,
  memoryRows: MemoryRow[] = [],
  context: Record<string, unknown> = {},
): AgentState {
  const baseline = simulate(snap.twin);
  const allowed = new Set<number>();
  collectNumbers(question, allowed);
  collectNumbers(context, allowed);
  return {
    feature,
    snap,
    baseline,
    sims: new Map(),
    memoryRows,
    memoryHits: new Map(),
    opportunities: null,
    allowedNumbers: allowed,
    steps: [],
    question,
    context,
    lastSavings: null,
    bank: null,
    http: null,
    lastBudget: null,
    sources: new Map(),
  };
}

/** Everything a tool returns becomes citable. */
function remember(state: AgentState, value: unknown): unknown {
  collectNumbers(value, state.allowedNumbers);
  return value;
}

const LEVER_SCHEMA = {
  type: 'object',
  description:
    'One change to apply in the fork. Dates are YYYY-MM-DD. Amounts are US dollars. Use only account/obligation/member tokens from the overview.',
  properties: {
    kind: {
      type: 'string',
      enum: ['one_time', 'recurring_change', 'income_change', 'transfer', 'extra_payment', 'move_obligation', 'pause_obligation'],
    },
    amount: { type: 'number', description: 'one_time, transfer, extra_payment: dollars (positive)' },
    flow: { type: 'string', enum: ['out', 'in'], description: 'one_time only; default out (an expense)' },
    date: { type: 'string', description: 'one_time, transfer, extra_payment: YYYY-MM-DD' },
    category: { type: 'string', enum: SPEND_CATEGORIES, description: 'recurring_change only' },
    monthly_delta: { type: 'number', description: 'recurring_change: + spends more per month, - spends less. income_change: dollar change per month' },
    member: { type: 'string', description: 'income_change: member token, e.g. "B"' },
    percent: { type: 'number', description: 'income_change: -100 means that income stops entirely' },
    start_date: { type: 'string' },
    end_date: { type: 'string', description: 'optional; omit for open-ended' },
    from: { type: 'string', description: 'transfer: source account token' },
    to: { type: 'string', description: 'transfer: destination account token' },
    loan: { type: 'string', description: 'extra_payment: loan or card account token' },
    obligation: { type: 'string', description: 'move_obligation / pause_obligation: obligation token' },
    new_date: { type: 'string', description: 'move_obligation: YYYY-MM-DD' },
    label: { type: 'string', description: 'short neutral label, e.g. "Japan trip"' },
  },
  required: ['kind'],
};

const ALL_TOOLS: Record<string, ToolSpec> = {
  get_household_overview: {
    type: 'function',
    function: {
      name: 'get_household_overview',
      description:
        'Members (as tokens), the accounts and bills you are allowed to see, monthly spending by category, and goals. Other members\' private accounts are excluded; signal-level accounts appear only as other_household_cash.',
      parameters: { type: 'object', properties: {} },
    },
  },
  get_vitals: {
    type: 'function',
    function: {
      name: 'get_vitals',
      description: 'The six household health indicators and the 0-100 score for the current plan, with bands.',
      parameters: { type: 'object', properties: {} },
    },
  },
  get_forecast_summary: {
    type: 'function',
    function: {
      name: 'get_forecast_summary',
      description: '60-day outlook for household cash: lowest point, overdraft risk, monthly income/outflow/surplus, upcoming bills, goal dates.',
      parameters: { type: 'object', properties: {} },
    },
  },
  simulate_scenario: {
    type: 'function',
    function: {
      name: 'simulate_scenario',
      description:
        'Fork the household plan, apply levers, and get the exact before/after diff from the deterministic engine: every vital, goal date shifts in days, lowest cash, overdraft risk, and how many days cash lasts. Returns a sim_id you cite in your final answer. Invalid levers come back with the reason so you can fix them.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Neutral name for this fork, e.g. "Japan trip in March"' },
          levers: { type: 'array', items: LEVER_SCHEMA, minItems: 1, maxItems: 8 },
        },
        required: ['title', 'levers'],
      },
    },
  },
  spending_budget: {
    type: 'function',
    function: {
      name: 'spending_budget',
      description:
        "How much the household can put toward a one-time purchase right now, from the deterministic forecast. comfortable_budget keeps three months of essential bills above the safety buffer for the next 12 months; stretch_budget only stays above the buffer. Use it to judge a price you found and to suggest a price range that fits.",
      parameters: { type: 'object', properties: {} },
    },
  },
  required_monthly_savings: {
    type: 'function',
    function: {
      name: 'required_monthly_savings',
      description: 'How much to set aside each month from now to have `target` dollars by `by_date`.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'number' }, by_date: { type: 'string', description: 'YYYY-MM-DD' } },
        required: ['target', 'by_date'],
      },
    },
  },
  search_memory: {
    type: 'function',
    function: {
      name: 'search_memory',
      description: "Search the household's past decisions (merged/declined proposals, notes, commitments) and the reasons recorded at the time.",
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  check_bank: {
    type: 'function',
    function: {
      name: 'check_bank',
      description:
        "Calls the household's bank (Capital One Nessie API) live: compares each visible account's bank balance with the ledger, and lists upcoming bills the bank has that the forecast doesn't. Use it before giving advice that depends on balances being current.",
      parameters: { type: 'object', properties: {} },
    },
  },
  lookup_information: {
    type: 'function',
    function: {
      name: 'lookup_information',
      description:
        'Look up a public fact that is not in the household ledger: a product, a price, a definition, or a published rate. Returns short passages with sources. Use a number only when a passage states it. If the passages do not contain the figure, ask the member. Do not send names or account details in the query.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Short public search, e.g. "Koenigsegg Jesko price"' } }, required: ['query'] },
    },
  },
  find_opportunities: {
    type: 'function',
    function: {
      name: 'find_opportunities',
      description:
        'Detected, priced opportunities from bills and transactions: subscription price increases, duplicate subscriptions, high-APR balances, idle cash, bill timing fixes, spending spikes.',
      parameters: { type: 'object', properties: {} },
    },
  },
};

const FEATURE_TOOLS: Record<FeatureKind, string[]> = {
  twin: ['get_household_overview', 'get_vitals', 'get_forecast_summary', 'lookup_information', 'spending_budget', 'simulate_scenario', 'required_monthly_savings', 'check_bank'],
  ripple: ['get_household_overview', 'get_forecast_summary', 'lookup_information', 'spending_budget', 'simulate_scenario'],
  negotiation: ['get_household_overview', 'get_vitals', 'lookup_information', 'simulate_scenario', 'search_memory'],
  stress: ['get_household_overview', 'get_forecast_summary', 'lookup_information', 'simulate_scenario'],
  life_event: ['get_household_overview', 'get_forecast_summary', 'lookup_information', 'simulate_scenario', 'required_monthly_savings'],
  memory: ['search_memory', 'get_vitals'],
  opportunity: ['find_opportunities', 'get_forecast_summary', 'lookup_information', 'simulate_scenario'],
  health: ['get_household_overview', 'get_vitals', 'get_forecast_summary', 'lookup_information', 'simulate_scenario', 'check_bank'],
  briefing: ['get_household_overview', 'get_forecast_summary', 'get_vitals', 'lookup_information', 'simulate_scenario', 'find_opportunities', 'check_bank'],
  coach: [],
};

export function toolsFor(feature: FeatureKind): ToolSpec[] {
  return FEATURE_TOOLS[feature].map(n => ALL_TOOLS[n]);
}

// ---------- Executors ----------

const BAND_RULES: Record<string, string> = {
  runway: 'green at 3+ months, yellow 1-3 months, red under 1 month',
  crunch_risk: 'green under 10%, yellow 10-25%, red over 25%',
  dti: 'green at 36% or less, yellow 36-43%, red over 43%',
  utilization: 'green at 30% or less, yellow 30-50%, red over 50%',
  savings_rate: 'green at 15%+, yellow 5-15%, red under 5%',
  goal_track: 'green on time, yellow up to 3 months late, red more than 3 months late',
  score: 'green 70+, yellow 50-69, red under 50',
};

export function vitalsView(r: TwinResult) {
  return r.vitals.map(v => ({ vital: v.key, value: v.display, band: v.band, bands: BAND_RULES[v.key] }));
}

export function forecastSummary(state: AgentState) {
  const t = state.snap.twin;
  const b = state.baseline;
  const upcoming = t.obligations
    .filter(o => o.visible)
    .map(o => ({ o, due: nextOccurrence(o.cadence, o.anchorDay, t.today + 1) }))
    .filter(x => x.due > 0 && x.due <= t.today + 30)
    .sort((a, b2) => a.due - b2.due)
    .slice(0, 12)
    .map(x => ({ label: x.o.label, kind: x.o.kind, amount: Math.round(x.o.amount), date: dayToLabel(x.due), flexible: x.o.flexible, obligation: x.o.token }));
  return {
    today: dayToLabel(t.today),
    today_iso: dayToIso(t.today),
    household_cash_now: b.startLiquid,
    buffer: b.buffer,
    lowest_cash_next_60_days: b.minBalance,
    lowest_cash_date: dayToLabel(b.minDay),
    peak_overdraft_risk_pct_next_30_days: Math.round(b.peakCrunchRisk * 100),
    peak_risk_date: dayToLabel(b.peakCrunchDay),
    first_high_risk_date: b.firstCrunchDay > 0 ? dayToLabel(b.firstCrunchDay) : 'none',
    monthly_income: b.monthlyIncome,
    monthly_outflow: b.monthlyOutflow,
    monthly_surplus: b.monthlySurplus,
    upcoming_bills_30_days: upcoming,
    goals: b.goals.map(g => ({ goal: g.token, name: g.name, projected: etaLabel(g.etaDay), target_date: dayToLabel(g.targetDay), late_days: g.etaDay === NO_ETA ? 'not within 5 years' : g.lateDays })),
  };
}

export function diffView(s: Sim) {
  const d = s.diff;
  return {
    sim_id: s.simId,
    title: s.title,
    applied: s.levers.map(l => describeLever(l)),
    vitals: d.vitals.filter(v => v.key !== 'goal_track').map(v => ({ vital: v.key, before: v.before, after: v.after, change: v.direction })),
    goals: d.goals.map(g => ({ goal: g.token, name: g.name, before: g.beforeEta, after: g.afterEta, shift_days: g.shiftDays })),
    lowest_cash_before: Math.round(d.minBalanceBefore),
    lowest_cash_after: Math.round(d.minBalanceAfter),
    lowest_cash_date_after: d.minDayAfter,
    lowest_cash_12_months_before: Math.round(d.minBalance12mBefore),
    lowest_cash_12_months_after: Math.round(d.minBalance12mAfter),
    lowest_cash_12_months_date_after: d.minDay12mAfter,
    overdraft_risk_pct_before: d.crunchBefore,
    overdraft_risk_pct_after: d.crunchAfter,
    riskiest_date_after: d.crunchDayAfter,
    drops_below_buffer_on: d.bufferBreachDay || 'never in 60 days',
    monthly_surplus_before: d.monthlySurplusBefore,
    monthly_surplus_after: d.monthlySurplusAfter,
    cash_runs_out_in_days: s.survivalDays < 0 ? 'not within 2 years' : s.survivalDays,
    decision_date: dayToLabel(s.firstDay),
    cash_on_decision_date_before: s.cashOnFirstDayBefore ?? 'beyond 60 days',
    cash_on_decision_date_after: s.cashOnFirstDayAfter ?? 'beyond 60 days',
    cushion_above_buffer_before: Math.round(d.minBalanceBefore - s.result.buffer),
    cushion_above_buffer_after: Math.round(d.minBalanceAfter - s.result.buffer),
    lowest_point_moved: Math.round(d.minBalanceBefore) !== Math.round(d.minBalanceAfter),
    one_time_costs_total: Math.round(s.levers.filter(l => l.kind === 'one_time' && !l.flowIn).reduce((t, l) => t + l.amount, 0)),
  };
}

export function describeLever(l: ResolvedLever): string {
  const $ = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
  switch (l.kind) {
    case 'one_time':
      return `${l.label}: ${l.flowIn ? '+' : ''}${$(l.amount)} on ${dayToLabel(l.day)}`;
    case 'recurring_change':
      return `${l.label}: ${l.amount >= 0 ? '+' : '-'}${$(l.amount)}/month ${l.category} from ${dayToLabel(l.day)}${l.endDay > 0 ? ` to ${dayToLabel(l.endDay)}` : ''}`;
    case 'income_change':
      return `${l.label}: member ${l.from} income ${l.percent !== 0 ? `${l.percent}%` : `${l.amount >= 0 ? '+' : '-'}${$(l.amount)}/month`} from ${dayToLabel(l.day)}${l.endDay > 0 ? ` to ${dayToLabel(l.endDay)}` : ''}`;
    case 'transfer':
      return `${l.label}: move ${$(l.amount)} ${l.from} -> ${l.to} on ${dayToLabel(l.day)}`;
    case 'extra_payment':
      return `${l.label}: extra ${$(l.amount)} to ${l.to} on ${dayToLabel(l.day)}`;
    case 'move_obligation':
      return `${l.label}: move ${l.from} to ${dayToLabel(l.day)}`;
    case 'pause_obligation':
      return `${l.label}: pause ${l.from} from ${dayToLabel(l.day)}${l.endDay > 0 ? ` to ${dayToLabel(l.endDay)}` : ''}`;
  }
}

/** Runs a fork through the engine. Exported so fallbacks build scenarios the same way. */
export function runSim(state: AgentState, title: string, levers: Lever[]): { sim?: Sim; errors: string[] } {
  const errors: string[] = [];
  const resolved: ResolvedLever[] = [];
  levers.forEach((l, i) => {
    try {
      resolved.push(resolveLever(state.snap.twin, l));
    } catch (e) {
      errors.push(`lever ${i + 1}: ${e instanceof LeverError ? e.message : 'invalid'}`);
    }
  });
  if (errors.length || resolved.length === 0) return { errors: errors.length ? errors : ['no levers'] };
  const result = simulate(state.snap.twin, resolved);
  const simId = `sim_${state.sims.size + 1}`;
  const firstDay = Math.min(...resolved.map(l => l.day));
  const at = (pts: TwinResult['points']) => pts.find(p => p.day === firstDay)?.p50 ?? null;
  const sim: Sim = {
    simId,
    title: title.replace(/[^A-Za-z0-9 $%,.'&()/-]/g, '').slice(0, 60) || simId,
    levers: resolved,
    result,
    diff: diff(state.baseline, result),
    survivalDays: survivalDays(state.snap.twin, resolved),
    firstDay,
    cashOnFirstDayBefore: at(state.baseline.points),
    cashOnFirstDayAfter: at(result.points),
  };
  state.sims.set(simId, sim);
  return { sim, errors: [] };
}

export function getOpportunities(state: AgentState): Opportunity[] {
  if (!state.opportunities) state.opportunities = findOpportunities(state.snap, state.baseline);
  return state.opportunities;
}

/**
 * One-time spending room from the forecast. A purchase made now lowers every later balance by its
 * cost, so the room is the lowest projected cash over 12 months minus what must stay untouched.
 */
export function spendingBudget(state: AgentState) {
  const b = state.baseline;
  const floor100 = (n: number) => Math.max(0, Math.floor(n / 100) * 100);
  const keep = b.buffer + 3 * b.essentialMonthly;
  const result = {
    cash_now: Math.round(b.startLiquid),
    lowest_cash_next_12_months: Math.round(b.minBalance12m),
    safety_buffer: Math.round(b.buffer),
    essential_bills_per_month: Math.round(b.essentialMonthly),
    comfortable_budget: floor100(b.minBalance12m - keep),
    stretch_budget: floor100(b.minBalance12m - b.buffer),
    how: 'comfortable = lowest cash over 12 months - safety buffer - 3 months of essential bills; stretch = lowest cash - safety buffer',
  };
  state.lastBudget = result;
  return { ...result, slot_hint: 'cite as {budget.comfortable_budget} or {budget.stretch_budget}' };
}

/** Live cross-check against the bank. Only tokens and amounts come back; payee text is dropped. */
export function checkBank(state: AgentState) {
  if (!state.bank) return { available: false, note: 'Bank sync is not configured; the forecast uses the last synced ledger.' };
  const t = state.snap.twin;
  const accounts = [];
  const unmatchedBills = [];
  for (const a of t.accounts.filter(x => x.visibility !== 'signal' && ['checking', 'savings', 'credit_card'].includes(x.kind))) {
    const live = state.bank.account(a.token);
    if ('error' in live) {
      accounts.push({ account: a.token, kind: a.kind, status: live.error });
      continue;
    }
    const drift = Math.round(live.balance - a.balance);
    accounts.push({ account: a.token, kind: a.kind, ledger_balance: Math.round(a.balance), bank_balance: Math.round(live.balance), difference: drift, in_sync: Math.abs(drift) < 1 });
    const bills = state.bank.bills(a.token);
    if ('error' in bills) continue;
    for (const b of bills) {
      if (b.status === 'completed' || b.status === 'cancelled') continue;
      const known = t.obligations.some(o => o.accountToken === a.token && Math.abs(o.amount - b.amount) < 1);
      if (!known) unmatchedBills.push({ account: a.token, amount: Math.round(b.amount), date: b.date, status: b.status });
    }
  }
  return { available: true, source: 'Capital One Nessie', accounts, bills_not_in_forecast: unmatchedBills.slice(0, 10) };
}

/** Models sometimes send levers as a JSON string, a single object, or under a misspelled key. */
function leversArg(args: Record<string, unknown>): Lever[] {
  let v = args.levers ?? args.leavers ?? args.changes ?? args.lever;
  if (typeof v === 'string') {
    // Re-wrap so a missing or extra bracket ("[{...}" or "{...},{...}") still parses.
    const inner = v.trim().replace(/^\[/, '').replace(/\]$/, '');
    try {
      v = JSON.parse(`[${inner}]`);
    } catch {
      // Salvage every flat {...} object that parses on its own.
      v = (inner.match(/\{[^{}]*\}/g) ?? []).flatMap(o => {
        try {
          return [JSON.parse(o)];
        } catch {
          return [];
        }
      });
    }
  }
  if (v && !Array.isArray(v) && typeof v === 'object') v = [v];
  return Array.isArray(v) ? (v as Lever[]) : [];
}

export function executeTool(state: AgentState, name: string, rawArgs: string | Record<string, unknown>): unknown {
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === 'string') {
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return { error: 'arguments were not valid JSON' };
    }
  } else args = rawArgs ?? {};

  if (!FEATURE_TOOLS[state.feature].includes(name)) return { error: `tool ${name} is not available here` };

  switch (name) {
    case 'get_household_overview':
      return remember(state, overviewForModel(state.snap));
    case 'get_vitals':
      return remember(state, { vitals: vitalsView(state.baseline) });
    case 'get_forecast_summary':
      return remember(state, forecastSummary(state));
    case 'simulate_scenario': {
      const levers = leversArg(args);
      const { sim, errors } = runSim(state, String(args.title ?? 'Scenario'), levers);
      if (!sim) return { error: 'some levers were invalid; fix them and call again', details: errors };
      return remember(state, diffView(sim));
    }
    case 'required_monthly_savings': {
      const target = Number(args.target);
      const by = typeof args.by_date === 'string' ? args.by_date : '';
      const day = isoToDay(by);
      if (!Number.isFinite(target) || target <= 0 || day === null) return { error: 'target must be positive and by_date YYYY-MM-DD' };
      state.lastSavings = { target, by: dayToLabel(day), per_month: requiredMonthly(target, state.snap.twin.today, day), current_monthly_surplus: state.baseline.monthlySurplus };
      return remember(state, { ...state.lastSavings, slot_hint: 'cite as {savings.per_month}' });
    }
    case 'search_memory': {
      const hits = searchMemory(state.memoryRows, String(args.query ?? state.question), state.snap.twin.today, state.snap.map.nameToToken);
      // Re-number so ids stay unique across repeated searches.
      const items = hits.map(h => {
        const existing = [...state.memoryHits.values()].find(m => m.title === h.title && m.date === h.date);
        if (existing) return existing;
        const item = { ...h, memory: `mem_${state.memoryHits.size + 1}` };
        state.memoryHits.set(item.memory, item);
        return item;
      });
      return remember(state, { results: items, note: items.length ? '' : 'no matching decisions recorded' });
    }
    case 'find_opportunities': {
      const opps = getOpportunities(state).slice(0, 8);
      return remember(state, {
        in_crunch: state.baseline.peakCrunchRisk > 0.25,
        note: 'saves_per_month values are monthly, recurring savings.',
        opportunities: opps.map(o => ({ opportunity: o.opportunity, type: o.type, scope: o.scope, owner: o.owner, title: o.title, evidence: o.evidence, saves_per_month: o.est_monthly_savings, effort: o.effort, free: o.free, has_fix: !!o.lever })),
      });
    }
    case 'lookup_information': {
      if (!state.http) return { available: false, note: 'Public lookup is not available in this run.' };
      const query = String(args.query ?? state.question);
      const found = lookupInformation(state.http, query);
      for (const p of found.passages) state.sources.set(p.url, p.title);
      return remember(state, found);
    }
    case 'spending_budget':
      return remember(state, spendingBudget(state));
    case 'check_bank':
      return remember(state, checkBank(state));
    default:
      return { error: `unknown tool ${name}` };
  }
}
