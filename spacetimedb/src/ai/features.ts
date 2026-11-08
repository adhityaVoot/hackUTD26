// Per-feature finalization (validate Nemotron's JSON against engine state) and deterministic
// fallbacks (same engine, templated words) for when the model is off, down, or fails checks.

import { dayToIso, dayToLabel } from './dates';
import { checkNumbers } from './gateway';
import { decisionLever, lifeEventAssumptions, parseWhen, shortLabel, stressPlans } from './intent';
import { DISCLAIMER } from './prompts';
import { describeLever, diffView, forecastSummary, getOpportunities, runSim, type AgentState, type Sim } from './tools';
import { searchMemory } from './memory';
import { requiredMonthly } from './twin';
import type { FeatureKind, Highlight, InsightResult, ScenarioDraft, TwinDiff } from './types';

const $ = (n: number) => `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
const VITAL_LABEL: Record<string, string> = {
  runway: 'Cash runway',
  crunch_risk: 'Overdraft risk',
  dti: 'Debt-to-income',
  utilization: 'Card utilization',
  savings_rate: 'Savings rate',
  goal_track: 'Goal track',
  score: 'Household score',
};

export function highlightsFromDiff(d: TwinDiff, max = 5): Highlight[] {
  const out: Highlight[] = [];
  if (Math.round(d.minBalanceBefore) !== Math.round(d.minBalanceAfter)) {
    out.push({ label: 'Lowest cash (60 days)', before: $(d.minBalanceBefore), after: $(d.minBalanceAfter), direction: d.minBalanceAfter > d.minBalanceBefore ? 'better' : 'worse' });
  }
  if (d.crunchBefore !== d.crunchAfter) {
    out.push({ label: 'Overdraft risk', before: `${d.crunchBefore}%`, after: `${d.crunchAfter}%`, direction: d.crunchAfter < d.crunchBefore ? 'better' : 'worse' });
  }
  for (const g of d.goals) {
    if (g.shiftDays !== 0) out.push({ label: g.name, before: g.beforeEta, after: g.afterEta, direction: g.shiftDays > 0 ? 'worse' : 'better' });
  }
  for (const v of d.vitals) {
    if (v.direction !== 'same' && v.key !== 'crunch_risk' && v.key !== 'goal_track') {
      out.push({ label: VITAL_LABEL[v.key], before: v.before, after: v.after, direction: v.direction });
    }
  }
  return out.slice(0, max);
}

function draft(s: Sim): ScenarioDraft {
  return { simId: s.simId, title: s.title, levers: s.levers, diff: s.diff };
}

function base(state: AgentState, title: string, answer: string, source: InsightResult['source']): InsightResult {
  return { kind: state.feature, title: title.slice(0, 60), answer, highlights: [], sections: [], scenarios: [], source, disclaimer: DISCLAIMER };
}

// ---------- Slots ----------
// The model writes {sim_1.lowest_cash_after}, {sim_1.goal_2.shift_days} or
// {now.peak_overdraft_risk_pct_next_30_days}; the engine fills them with exact values.

const SLOT = /\{(sim_\d+|now|savings)\.([a-z0-9_]+)(?:\.([a-z0-9_]+))?\}/g;

function formatSlot(key: string, v: unknown): string {
  if (typeof v !== 'number') return String(v);
  if (/_pct/.test(key)) return `${v}%`;
  if (/cash|surplus|income|outflow|buffer|balance/.test(key)) return $(v);
  return v.toLocaleString('en-US');
}

export function fillSlots(text: string, state: AgentState): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const now = forecastSummary(state) as Record<string, unknown>;
  const out = text.replace(SLOT, (m, src: string, a: string, b?: string) => {
    let obj: Record<string, unknown> | undefined;
    if (src === 'now') obj = now;
    else if (src === 'savings') obj = state.lastSavings ?? undefined;
    else {
      const sim = state.sims.get(src);
      obj = sim ? (diffView(sim) as Record<string, unknown>) : undefined;
    }
    if (!obj) {
      unknown.push(m);
      return m;
    }
    if (b) {
      // {sim_1.goal_2.shift_days}
      const goals = (obj.goals as Record<string, unknown>[] | undefined) ?? [];
      const g = goals.find(x => x.goal === a);
      if (!g || !(b in g)) {
        unknown.push(m);
        return m;
      }
      return formatSlot(b, g[b]);
    }
    if (!(a in obj)) {
      unknown.push(m);
      return m;
    }
    return formatSlot(a, obj[a]);
  });
  return { text: out, unknown };
}

// ---------- Validation helpers ----------

class Checker {
  errors: string[] = [];
  constructor(private state: AgentState) {}
  text(field: string, v: unknown, required = true, max = 700): string {
    if (typeof v !== 'string' || !v.trim()) {
      if (required) this.errors.push(`${field} is required`);
      return '';
    }
    const raw = v.trim();
    const nc = checkNumbers(raw.replace(SLOT, ''), this.state.allowedNumbers);
    if (!nc.ok) this.errors.push(`${field} uses numbers no tool returned (${nc.unsupported.slice(0, 4).join(', ')}); use slots like {sim_1.lowest_cash_after} instead`);
    const filled = fillSlots(raw, this.state);
    if (filled.unknown.length) this.errors.push(`${field} has unknown slots ${filled.unknown.slice(0, 3).join(', ')}`);
    // Internal field names ("household_cash_now") mean the model pasted a key instead of a value.
    const fieldName = filled.text.replace(/\{[^}]*\}/g, '').match(/\b(?!(?:acct|obl|goal|sim|mem|opp)_)[a-z]+_[a-z_0-9]+\b/);
    if (fieldName) this.errors.push(`${field} contains the field name "${fieldName[0]}"; write plain English or use a {slot}`);
    const stray = filled.text.match(/\{[^}]*\}?/);
    if (stray && !filled.unknown.length) this.errors.push(`${field} has an unsupported placeholder ${stray[0].slice(0, 40)}; use {sim_N.field}, {now.field} or {savings.field}`);
    // Truncate after filling, at a word boundary, so a slot is never cut in half.
    return filled.text.length <= max ? filled.text : `${filled.text.slice(0, filled.text.lastIndexOf(' ', max - 1))}...`;
  }
  texts(field: string, v: unknown, maxItems = 6): string[] {
    if (!Array.isArray(v)) return [];
    return v.slice(0, maxItems).map((x, i) => this.text(`${field}[${i}]`, x, false, 300)).filter(Boolean);
  }
  sim(field: string, v: unknown, required = true): Sim | undefined {
    if (typeof v !== 'string' || !this.state.sims.has(v)) {
      if (required) this.errors.push(`${field} must be a sim_id returned by simulate_scenario (have: ${[...this.state.sims.keys()].join(', ') || 'none; call simulate_scenario first'})`);
      return undefined;
    }
    return this.state.sims.get(v);
  }
  oneOf<T extends string>(field: string, v: unknown, options: T[], fallback: T): T {
    if (options.includes(v as T)) return v as T;
    this.errors.push(`${field} must be one of ${options.join(', ')}`);
    return fallback;
  }
}

export interface Finalized {
  result: InsightResult | null;
  errors: string[];
}

export function finalize(state: AgentState, parsed: any, model: string): Finalized {
  if (!parsed || typeof parsed !== 'object') return { result: null, errors: ['reply was not a JSON object'] };
  const c = new Checker(state);
  const title = typeof parsed.title === 'string' ? parsed.title.replace(/[^\w $,.'&()/:-]/g, '').slice(0, 60) : '';
  const r = base(state, title || defaultTitle(state.feature), '', 'nemotron');
  r.model = model;
  r.answer = c.text('answer', parsed.answer);

  switch (state.feature) {
    case 'twin': {
      r.verdict = c.oneOf('verdict', parsed.verdict, ['yes', 'yes_with_tradeoffs', 'not_yet', 'no'], 'yes_with_tradeoffs');
      const main = c.sim('recommended_sim', parsed.recommended_sim);
      const alts = (Array.isArray(parsed.alternative_sims) ? parsed.alternative_sims : []).map((s: unknown, i: number) => c.sim(`alternative_sims[${i}]`, s, false)).filter(Boolean) as Sim[];
      const tradeoffs = c.texts('tradeoffs', parsed.tradeoffs, 4);
      if (main) {
        r.scenarios = [draft(main), ...alts.filter(a => a !== main).map(draft)];
        r.highlights = highlightsFromDiff(main.diff);
      }
      if (tradeoffs.length) r.sections.push({ heading: 'Trade-offs', items: tradeoffs });
      if (alts.length) r.sections.push({ heading: 'Other paths', items: alts.map(a => `${a.title}: ${summaryLine(a)}`) });
      break;
    }
    case 'ripple': {
      const main = c.sim('decision_sim', parsed.decision_sim);
      const chain = (Array.isArray(parsed.chain) ? parsed.chain : []).slice(0, 6).map((x: any, i: number) => ({
        step: c.text(`chain[${i}].step`, x?.step, true, 300),
        area: ['cash', 'bills', 'buffer', 'risk', 'goal', 'vital'].includes(x?.area) ? x.area : 'vital',
        severity: ['low', 'medium', 'high'].includes(x?.severity) ? x.severity : 'medium',
      }));
      if (chain.length < 2) c.errors.push('chain needs at least 2 steps');
      const alt = c.sim('alternative_sim', parsed.alternative_sim, false);
      const altNote = alt ? c.text('alternative_note', parsed.alternative_note, false, 300) : '';
      if (main) {
        r.scenarios = [draft(main), ...(alt && alt !== main ? [draft(alt)] : [])];
        r.highlights = highlightsFromDiff(main.diff);
      }
      r.sections.push({ heading: 'Ripple chain', items: chain.map((x: any) => x.step) });
      if (altNote) r.sections.push({ heading: 'Softer option', items: [altNote] });
      r.extra = { chain, engineChain: main ? engineChain(main) : [] };
      break;
    }
    case 'negotiation': {
      const positions = (Array.isArray(parsed.positions) ? parsed.positions : []).slice(0, 4).map((p: any, i: number) => ({
        member: typeof p?.member === 'string' ? p.member.slice(0, 2) : '?',
        summary: c.text(`positions[${i}].summary`, p?.summary, true, 300),
        sim: c.sim(`positions[${i}].sim_id`, p?.sim_id, false),
      }));
      const compromises = (Array.isArray(parsed.compromises) ? parsed.compromises : []).slice(0, 3).map((x: any, i: number) => ({
        sim: c.sim(`compromises[${i}].sim_id`, x?.sim_id),
        title: typeof x?.title === 'string' ? x.title.slice(0, 60) : `Compromise ${i + 1}`,
        why: c.text(`compromises[${i}].why_fair`, x?.why_fair, true, 400),
      }));
      if (!compromises.length) c.errors.push('propose at least one compromise fork');
      const rec = c.sim('recommended_sim', parsed.recommended_sim);
      const disagreements = c.texts('disagreements', parsed.disagreements, 4);
      const shared = c.texts('shared_priorities', parsed.shared_priorities, 4);
      if (rec) {
        const others = compromises.map((x: any) => x.sim).filter((s: Sim | undefined) => s && s !== rec) as Sim[];
        r.scenarios = [draft(rec), ...others.map(draft)];
        r.highlights = highlightsFromDiff(rec.diff);
      }
      if (disagreements.length) r.sections.push({ heading: 'Where you differ', items: disagreements });
      if (shared.length) r.sections.push({ heading: 'What you share', items: shared });
      r.sections.push({ heading: 'Compromises', items: compromises.map((x: any) => `${x.title}: ${x.why}`) });
      r.extra = {
        positions: positions.map((p: any) => ({ member: p.member, summary: p.summary, simId: p.sim?.simId ?? '', diff: p.sim ? diffView(p.sim) : null })),
        compromises: compromises.map((x: any) => ({ simId: x.sim?.simId ?? '', title: x.title, why: x.why, diff: x.sim ? diffView(x.sim) : null })),
      };
      break;
    }
    case 'stress': {
      const scenarios = (Array.isArray(parsed.scenarios) ? parsed.scenarios : []).slice(0, 4).map((x: any, i: number) => ({
        sim: c.sim(`scenarios[${i}].sim_id`, x?.sim_id),
        name: typeof x?.name === 'string' ? x.name.slice(0, 60) : `Scenario ${i + 1}`,
        severity: ['mild', 'expected', 'severe'].includes(x?.severity) ? x.severity : 'expected',
      }));
      if (!scenarios.length) c.errors.push('scenarios must list at least one simulated scenario');
      const fingerprints = scenarios.filter((s: any) => s.sim).map((s: any) => s.sim.levers.map(describeLever).join('|'));
      if (new Set(fingerprints).size < fingerprints.length) {
        c.errors.push('mild, expected and severe must be different simulations (change the duration, percent or amount), not the same sim reused');
      }
      const weakest = c.text('weakest_point', parsed.weakest_point, true, 300);
      const mitigations = (Array.isArray(parsed.mitigations) ? parsed.mitigations : []).slice(0, 3).map((x: any, i: number) => ({
        sim: c.sim(`mitigations[${i}].sim_id`, x?.sim_id),
        title: typeof x?.title === 'string' ? x.title.slice(0, 60) : `Mitigation ${i + 1}`,
        why: c.text(`mitigations[${i}].why`, x?.why, false, 300),
      }));
      const expected = scenarios.find((s: any) => s.severity === 'expected')?.sim ?? scenarios[0]?.sim;
      if (expected) r.highlights = highlightsFromDiff(expected.diff);
      r.scenarios = [...scenarios.map((s: any) => s.sim), ...mitigations.map((m: any) => m.sim)].filter(Boolean).filter((s: Sim, i: number, a: Sim[]) => a.indexOf(s) === i).map(draft);
      r.sections.push({ heading: 'Weakest point', items: [weakest] });
      r.sections.push({ heading: 'Scenarios', items: scenarios.filter((s: any) => s.sim).map((s: any) => `${s.name} (${s.severity}): ${survivalLine(s.sim)}`) });
      if (mitigations.length) r.sections.push({ heading: 'What helps', items: mitigations.map((m: any) => `${m.title}: ${m.why}`) });
      r.extra = {
        scenarios: scenarios.filter((s: any) => s.sim).map((s: any) => ({ simId: s.sim.simId, name: s.name, severity: s.severity, survivalDays: s.sim.survivalDays, diff: diffView(s.sim) })),
        mitigations: mitigations.filter((m: any) => m.sim).map((m: any) => ({ simId: m.sim.simId, title: m.title, why: m.why, diff: diffView(m.sim) })),
      };
      break;
    }
    case 'life_event': {
      const sim = c.sim('sim_id', parsed.sim_id);
      const assumptions = (Array.isArray(parsed.assumptions) ? parsed.assumptions : []).slice(0, 8).map((a: any) => ({
        label: typeof a?.label === 'string' ? a.label.slice(0, 60) : 'Assumption',
        amount: Number(a?.amount) || 0,
        timing: typeof a?.timing === 'string' ? a.timing.slice(0, 60) : '',
        confidence: ['low', 'medium', 'high'].includes(a?.confidence) ? a.confidence : 'medium',
        why: typeof a?.why === 'string' ? a.why.slice(0, 200) : '',
      }));
      if (!assumptions.length) c.errors.push('list the assumptions you simulated');
      const checklist = (Array.isArray(parsed.checklist) ? parsed.checklist : []).slice(0, 6).map((x: any, i: number) => ({
        when: typeof x?.when === 'string' ? x.when.slice(0, 40) : '',
        action: c.text(`checklist[${i}].action`, x?.action, true, 240),
      }));
      if (sim) {
        r.scenarios = [draft(sim)];
        r.highlights = highlightsFromDiff(sim.diff);
      }
      r.sections.push({ heading: 'Assumptions', items: assumptions.map((a: any) => `${a.label}: ${$(a.amount)} (${a.timing}, ${a.confidence} confidence)`) });
      r.sections.push({ heading: 'Checklist', items: checklist.map((x: any) => `${x.when}: ${x.action}`) });
      r.extra = { event: typeof parsed.event === 'string' ? parsed.event.slice(0, 60) : '', assumptions, checklist };
      break;
    }
    case 'memory': {
      const cited = (Array.isArray(parsed.cited) ? parsed.cited : []).filter((m: unknown) => typeof m === 'string' && state.memoryHits.has(m));
      if (state.memoryHits.size > 0 && cited.length === 0 && !/no (record|decision)|nothing (was )?recorded/i.test(r.answer)) {
        c.errors.push(`cite the memories you used (have: ${[...state.memoryHits.keys()].join(', ')})`);
      }
      const commitments = c.texts('commitments', parsed.commitments, 4);
      const still = c.text('still_relevant', parsed.still_relevant, false, 300);
      r.sections.push({ heading: 'From your decision log', items: cited.map((m: string) => memoryLine(state, m)) });
      if (commitments.length) r.sections.push({ heading: 'Commitments', items: commitments });
      if (still) r.sections.push({ heading: 'Today', items: [still] });
      r.extra = { cited: cited.map((m: string) => state.memoryHits.get(m)) };
      break;
    }
    case 'opportunity': {
      const opps = getOpportunities(state);
      const picks = (Array.isArray(parsed.picks) ? parsed.picks : []).slice(0, 3).map((p: any, i: number) => {
        const o = opps.find(x => x.opportunity === p?.opportunity);
        if (!o) c.errors.push(`picks[${i}].opportunity must be an id from find_opportunities`);
        return { o, why: c.text(`picks[${i}].why`, p?.why, true, 300), sim: c.sim(`picks[${i}].sim_id`, p?.sim_id, false) };
      });
      if (opps.length && !picks.length) c.errors.push('pick at least one opportunity');
      const valid = picks.filter((p: any) => p.o);
      r.sections.push({ heading: 'Worth a look', items: valid.map((p: any) => `${p.o.title}: ${p.why}`) });
      r.scenarios = valid.map((p: any) => p.sim).filter(Boolean).map(draft);
      r.highlights = valid.filter((p: any) => p.o.est_monthly_savings > 0).map((p: any) => ({ label: p.o.title, value: `${$(p.o.est_monthly_savings)}/mo`, direction: 'better' as const }));
      r.extra = { picks: valid.map((p: any) => ({ ...publicOpp(p.o), why: p.why, simId: p.sim?.simId ?? '' })) };
      break;
    }
  }
  return c.errors.length ? { result: null, errors: c.errors } : { result: r, errors: [] };
}

function publicOpp(o: ReturnType<typeof getOpportunities>[number]) {
  return { opportunity: o.opportunity, type: o.type, scope: o.scope, owner: o.owner, title: o.title, evidence: o.evidence, estMonthlySavings: o.est_monthly_savings, free: o.free, effort: o.effort };
}

function defaultTitle(f: FeatureKind): string {
  return { twin: 'Your question', ripple: 'Ripple effect', negotiation: 'A middle path', stress: 'Stress test', life_event: 'Life event plan', memory: 'From your decision log', opportunity: 'Opportunities' }[f];
}

function summaryLine(s: Sim): string {
  const d = s.diff;
  const goal = d.goals.find(g => g.shiftDays !== 0);
  const parts = [`lowest cash ${$(d.minBalanceAfter)}`, `overdraft risk ${d.crunchAfter}%`];
  if (goal) parts.push(`${goal.name} ${goal.shiftDays > 0 ? `${goal.shiftDays} days later` : `${-goal.shiftDays} days sooner`}`);
  return parts.join(', ');
}

function survivalLine(s: Sim): string {
  const d = s.diff;
  const runsOut = s.survivalDays > 0 ? `cash runs out in ${s.survivalDays} days` : 'cash never runs out';
  return `${runsOut}; below the buffer ${d.bufferBreachDay ? `from ${d.bufferBreachDay}` : 'never in 60 days'}; lowest cash over 12 months ${$(d.minBalance12mAfter)} (${d.minDay12mAfter})`;
}

function memoryLine(state: AgentState, id: string): string {
  const m = state.memoryHits.get(id);
  return m ? `${m.date}: ${m.title} (${m.outcome}). ${m.reasoning}` : id;
}

/** Engine-ordered consequences for one decision, used by the ripple fallback and shown alongside the model's chain. */
export function engineChain(s: Sim): { step: string; area: string; severity: string }[] {
  const d = s.diff;
  const first = s.levers[0];
  const out: { step: string; area: string; severity: string }[] = [];
  if (first) out.push({ step: `${describeLever(first)}.`, area: 'cash', severity: 'low' });
  if (Math.round(d.minBalanceAfter) !== Math.round(d.minBalanceBefore)) {
    out.push({ step: `Lowest household cash in the next 60 days moves from ${$(d.minBalanceBefore)} to ${$(d.minBalanceAfter)} (${d.minDayAfter}).`, area: 'cash', severity: d.minBalanceAfter < 0 ? 'high' : 'medium' });
  }
  if (d.bufferBreachDay) out.push({ step: `Household cash falls below the safety buffer on ${d.bufferBreachDay}.`, area: 'buffer', severity: 'high' });
  if (d.crunchAfter !== d.crunchBefore) {
    out.push({ step: `Overdraft risk goes from ${d.crunchBefore}% to ${d.crunchAfter}% (riskiest day ${d.crunchDayAfter}).`, area: 'risk', severity: d.crunchAfter > 25 ? 'high' : d.crunchAfter > 10 ? 'medium' : 'low' });
  }
  for (const g of d.goals.filter(x => x.shiftDays !== 0)) {
    out.push({ step: `${g.name} ${g.shiftDays > 0 ? `slips ${g.shiftDays} days` : `arrives ${-g.shiftDays} days sooner`}: ${g.beforeEta} to ${g.afterEta}.`, area: 'goal', severity: g.shiftDays > 90 ? 'high' : 'medium' });
  }
  for (const v of d.vitals.filter(x => x.direction !== 'same' && !['crunch_risk', 'goal_track'].includes(x.key))) {
    out.push({ step: `${VITAL_LABEL[v.key]} ${v.direction === 'worse' ? 'weakens' : 'improves'}: ${v.before} to ${v.after}.`, area: 'vital', severity: v.direction === 'worse' ? 'medium' : 'low' });
  }
  return out.slice(0, 6);
}

// ---------- Deterministic fallbacks ----------

export function fallback(state: AgentState, reason: string): InsightResult {
  const t = state.snap.twin;
  const q = state.question;
  switch (state.feature) {
    case 'twin':
    case 'ripple': {
      const lever = decisionLever(q, t);
      const { sim } = runSim(state, shortLabel(q), [lever]);
      if (!sim) return base(state, defaultTitle(state.feature), 'I could not turn that into a scenario. Try including an amount and a month.', 'fallback');
      const d = sim.diff;
      const worseBand = d.vitals.some(v => v.direction === 'worse' && sim.result.vitals.find(x => x.key === v.key)!.band !== state.baseline.vitals.find(x => x.key === v.key)!.band);
      const breach = !!d.bufferBreachDay;
      const goalSlip = d.goals.some(g => g.shiftDays > 30);
      if (state.feature === 'twin') {
        const verdict = breach ? 'not_yet' : worseBand || goalSlip ? 'yes_with_tradeoffs' : 'yes';
        const r = base(state, sim.title, '', 'fallback');
        r.verdict = verdict;
        r.answer =
          verdict === 'yes'
            ? `Yes. ${sim.title} keeps lowest household cash at ${$(d.minBalanceAfter)} and overdraft risk at ${d.crunchAfter}%.`
            : verdict === 'yes_with_tradeoffs'
              ? `You can, with trade-offs: ${summaryLine(sim)}.`
              : `Not yet. Household cash would fall below the buffer on ${d.bufferBreachDay}. ${summaryLine(sim)}.`;
        if (breach && lever.kind === 'one_time') {
          const later = runSim(state, `${sim.title}, saved up first`, [{ ...lever, date: laterDate(state, lever.amount) }]).sim;
          if (later) {
            r.scenarios.push(draft(later));
            r.sections.push({ heading: 'Other paths', items: [`${later.title}: ${summaryLine(later)}`] });
          }
        }
        r.scenarios.unshift(draft(sim));
        r.highlights = highlightsFromDiff(d);
        r.extra = { reason };
        return r;
      }
      const chain = engineChain(sim);
      const r = base(state, sim.title, chain.length > 1 ? chain.slice(1, 3).map(x => x.step).join(' ') : summaryLine(sim), 'fallback');
      r.scenarios = [draft(sim)];
      r.highlights = highlightsFromDiff(d);
      r.sections.push({ heading: 'Ripple chain', items: chain.map(x => x.step) });
      r.extra = { chain, engineChain: chain, reason };
      return r;
    }
    case 'stress': {
      const plans = stressPlans(q, t);
      const sims = plans.map(p => ({ p, sim: runSim(state, p.name, p.levers).sim })).filter(x => x.sim) as { p: (typeof plans)[number]; sim: Sim }[];
      const expected = sims.find(x => x.p.severity === 'expected') ?? sims[0];
      const r = base(state, 'Stress test', '', 'fallback');
      if (!expected) {
        r.answer = 'I could not build that scenario.';
        return r;
      }
      // Mitigation: pause every visible flexible, non-essential bill for the stress window.
      const flex = t.obligations.filter(o => o.visible && o.flexible && ['subscription', 'utility'].includes(o.kind));
      const startIso = (expected.p.levers[0] as any).start_date ?? (expected.p.levers[0] as any).date;
      const mitig = flex.length
        ? runSim(state, 'Pause flexible bills', [...expected.p.levers, ...flex.slice(0, 4).map(o => ({ kind: 'pause_obligation' as const, obligation: o.token, start_date: startIso, end_date: (expected.p.levers[0] as any).end_date, label: `Pause ${o.label}` }))]).sim
        : undefined;
      const e = expected.sim;
      r.answer = e.survivalDays > 0
        ? `In this scenario household cash runs out in ${e.survivalDays} days. ${e.diff.bufferBreachDay ? `It drops below the buffer on ${e.diff.bufferBreachDay}.` : ''}`.trim()
        : `The household holds up: cash never runs out, and the lowest point over the next 12 months is ${$(e.diff.minBalance12mAfter)} on ${e.diff.minDay12mAfter}.`;
      r.highlights = highlightsFromDiff(e.diff);
      r.scenarios = [...sims.map(x => draft(x.sim)), ...(mitig ? [draft(mitig)] : [])];
      r.sections.push({ heading: 'Weakest point', items: [e.diff.bufferBreachDay ? `Cash falls below the buffer on ${e.diff.bufferBreachDay}.` : `Lowest cash is ${$(e.diff.minBalance12mAfter)} on ${e.diff.minDay12mAfter}.`] });
      r.sections.push({ heading: 'Scenarios', items: sims.map(x => `${x.p.name} (${x.p.severity}): ${survivalLine(x.sim)}`) });
      if (mitig && mitig.diff.minBalance12mAfter > e.diff.minBalance12mAfter) {
        r.sections.push({ heading: 'What helps', items: [`Pausing flexible bills during the gap raises the 12-month low from ${$(e.diff.minBalance12mAfter)} to ${$(mitig.diff.minBalance12mAfter)}.`] });
      }
      r.extra = { scenarios: sims.map(x => ({ simId: x.sim.simId, name: x.p.name, severity: x.p.severity, survivalDays: x.sim.survivalDays, diff: diffView(x.sim) })), reason };
      return r;
    }
    case 'life_event': {
      const { event, assumptions } = lifeEventAssumptions(q, t);
      const { sim } = runSim(state, event, assumptions.map(a => a.lever));
      const r = base(state, `${event}: the plan`, '', 'fallback');
      const total = assumptions.filter(a => a.lever.kind === 'one_time').reduce((s, a) => s + a.amount, 0);
      const eventDay = parseWhen(q, t.today);
      const monthly = requiredMonthly(total, t.today, eventDay);
      const firstDay = Math.min(...(sim?.levers.map(l => l.day) ?? [eventDay]));
      if (sim) {
        r.scenarios = [draft(sim)];
        r.highlights = highlightsFromDiff(sim.diff);
      }
      r.answer = `${event} adds about ${$(total)} in one-time costs, the first on ${dayToLabel(firstDay)}. Setting aside ${$(monthly)} a month from now covers them by ${dayToLabel(eventDay)}.`;
      r.sections.push({ heading: 'Assumptions', items: assumptions.map(a => `${a.label}: ${$(a.amount)} (${a.timing}, ${a.confidence} confidence). ${a.why}`) });
      r.sections.push({
        heading: 'Checklist',
        items: [
          `Now: start setting aside ${$(monthly)} a month.`,
          `Before ${dayToLabel(firstDay)}: confirm the first deposit and update these assumptions.`,
          'Add the event as a shared goal so it shows on the Vitals Board.',
          `By ${dayToLabel(eventDay)}: have the remaining costs covered.`,
        ],
      });
      r.extra = { event, assumptions: assumptions.map(({ lever, ...a }) => a), reason };
      return r;
    }
    case 'memory': {
      const hits = searchMemory(state.memoryRows, q, t.today, state.snap.map.nameToToken, 3);
      hits.forEach(h => state.memoryHits.set(h.memory, h));
      const r = base(state, 'From your decision log', '', 'fallback');
      r.answer = hits.length ? `On ${hits[0].date} the household ${hits[0].outcome === 'declined' ? 'decided against' : 'decided on'} "${hits[0].title}". The reason recorded: ${hits[0].reasoning}` : 'Nothing in the decision log matches that question.';
      r.sections.push({ heading: 'From your decision log', items: hits.map(h => memoryLine(state, h.memory)) });
      r.extra = { cited: hits, reason };
      return r;
    }
    case 'opportunity': {
      const opps = getOpportunities(state).slice(0, 3);
      const r = base(state, 'Opportunities', opps.length ? `Found ${opps.length} things worth a look.` : 'Nothing stands out right now.', 'fallback');
      r.sections.push({ heading: 'Worth a look', items: opps.map(o => `${o.title}${o.est_monthly_savings > 0 ? ` (about ${$(o.est_monthly_savings)}/mo)` : ''}`) });
      r.highlights = opps.filter(o => o.est_monthly_savings > 0).map(o => ({ label: o.title, value: `${$(o.est_monthly_savings)}/mo`, direction: 'better' as const }));
      for (const o of opps) {
        if (!o.lever) continue;
        const sim = runSim(state, o.title, [o.lever]).sim;
        if (sim) r.scenarios.push(draft(sim));
      }
      r.extra = { picks: opps.map(o => ({ ...publicOpp(o), why: '', simId: '' })), reason };
      return r;
    }
    case 'negotiation': {
      const positions = (state.context.positions as { member: string; want: string }[] | undefined) ?? [];
      const sims = positions.map(p => ({ p, sim: runSim(state, `Member ${p.member}: ${shortLabel(p.want)}`, [decisionLever(p.want, t)]).sim })).filter(x => x.sim) as { p: { member: string; want: string }; sim: Sim }[];
      const r = base(state, 'A middle path', '', 'fallback');
      if (!sims.length) {
        r.answer = 'Each member needs to add a position before a compromise can be drafted.';
        return r;
      }
      // Compromise: every position at half size, later ones staggered by a month.
      const levers = sims.flatMap((x, i) =>
        x.sim.levers.map(l => halfAndStagger(l.source, i)),
      );
      const comp = runSim(state, 'Half of each, staggered', levers).sim;
      r.scenarios = [...(comp ? [draft(comp)] : []), ...sims.map(x => draft(x.sim))];
      if (comp) r.highlights = highlightsFromDiff(comp.diff);
      r.answer = comp
        ? `A middle path: fund part of each plan and space them out. Household cash stays at or above ${$(comp.diff.minBalanceAfter)} with overdraft risk at ${comp.diff.crunchAfter}%.`
        : 'Each plan is shown side by side below.';
      r.sections.push({ heading: 'Each plan on its own', items: sims.map(x => `Member ${x.p.member}: ${summaryLine(x.sim)}`) });
      r.extra = { positions: sims.map(x => ({ member: x.p.member, summary: shortLabel(x.p.want), simId: x.sim.simId, diff: diffView(x.sim) })), reason };
      return r;
    }
  }
}

function halfAndStagger(l: any, i: number): any {
  const shift = (iso: string | undefined) => {
    if (!iso) return iso;
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + i);
    return d.toISOString().slice(0, 10);
  };
  const out = { ...l };
  if (typeof out.amount === 'number') out.amount = Math.round(out.amount / 2);
  if (typeof out.monthly_delta === 'number') out.monthly_delta = Math.round(out.monthly_delta / 2);
  if (out.date) out.date = shift(out.date);
  if (out.start_date) out.start_date = shift(out.start_date);
  return out;
}

/** The first date the household could cover `amount` from surplus without touching the buffer. */
function laterDate(state: AgentState, amount: number): string {
  const surplus = Math.max(1, state.baseline.monthlySurplus);
  const months = Math.min(23, Math.ceil(amount / surplus));
  return dayToIso(state.snap.twin.today + Math.round(months * 30.4375));
}

