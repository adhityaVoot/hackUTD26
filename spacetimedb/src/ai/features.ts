// Per-feature finalization (validate Nemotron's JSON against engine state) and deterministic
// fallbacks (same engine, templated words) for when the model is off, down, or fails checks.

import { dayToIso, dayToLabel, nextOccurrence } from './dates';
import { checkNumbers } from './gateway';
import { decisionLever, lifeEventAssumptions, parseMoney, parseWhen, shortLabel, stressPlans } from './intent';
import { lookupInformation, priceFromPassages } from './lookup';
import { DISCLAIMER } from './prompts';
import { describeLever, diffView, forecastSummary, getOpportunities, runSim, type AgentState, type Sim } from './tools';
import { searchMemory } from './memory';
import { GOAL_HORIZON_DAYS, requiredMonthly } from './twin';
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
  return { simId: s.simId, title: s.title, levers: s.levers, diff: s.diff, series: s.series };
}

function base(state: AgentState, title: string, answer: string, source: InsightResult['source']): InsightResult {
  return { kind: state.feature, title: title.slice(0, 60), answer, highlights: [], sections: [], scenarios: [], source, disclaimer: DISCLAIMER };
}

// ---------- Slots ----------
// The model writes {sim_1.lowest_cash_after}, {sim_1.goal_2.shift_days} or
// {now.peak_overdraft_risk_pct_next_30_days}; the engine fills them with exact values.

const SLOT = /\{(sim_\d+|now|savings|budget)\.([a-z0-9_]+)(?:\.([a-z0-9_]+))?\}/g;

function formatSlot(key: string, v: unknown): string {
  if (typeof v !== 'number') return String(v);
  if (/_pct/.test(key)) return `${v}%`;
  if (/cash|surplus|income|outflow|buffer|balance|budget|price|cost|amount|bills|total|per_month|target/.test(key)) return $(v);
  return v.toLocaleString('en-US');
}

export function fillSlots(text: string, state: AgentState): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const now = forecastSummary(state) as Record<string, unknown>;
  const out = text.replace(/(\{[^}]*_pct[^}]*\})%/g, '$1').replace(SLOT, (m, src: string, a: string, b?: string) => {
    let obj: Record<string, unknown> | undefined;
    if (src === 'now') obj = now;
    else if (src === 'savings') obj = state.lastSavings ?? undefined;
    else if (src === 'budget') obj = state.lastBudget ?? undefined;
    else {
      const sim = state.sims.get(src);
      obj = sim ? (diffView(sim) as Record<string, unknown>) : undefined;
    }
    if (!obj) {
      unknown.push(src.startsWith('sim_') ? `${m} (${src} does not exist; call simulate_scenario first, or drop that sentence)` : m);
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
    if (/\b(pause|skip|stop paying|suspend)\b[^.]{0,40}\b(visa|card|mortgage|loan|insurance|autopay|car payment)\b/i.test(raw)) {
      this.errors.push(`${field} suggests pausing a debt or insurance payment; those can only be moved (e.g. after payday), never paused`);
    }
    const flipped = wrongDirection(filled.text, this.state);
    if (flipped) this.errors.push(`${field} says ${flipped}; check shift_days: positive means later, negative means sooner`);
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

/** Runs the same checks a writer's text gets (numbers, slots, field names, direction, debt pauses). */
export function verifyText(state: AgentState, text: string, max = 700): { text: string; errors: string[] } {
  const c = new Checker(state);
  const out = c.text('reviewed answer', text, true, max);
  return { text: out, errors: c.errors };
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
      r.followUp = c.text('follow_up', parsed.follow_up, false, 300) || undefined;
      // Asking for a missing amount is the one case where no fork is needed yet.
      const askingForAmount = !!r.followUp && state.sims.size === 0 && r.verdict === 'not_yet';
      const main = askingForAmount ? undefined : c.sim('recommended_sim', parsed.recommended_sim);
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
      const scenarioSims = new Set(scenarios.map((s: any) => s.sim).filter(Boolean));
      const mitigations = (Array.isArray(parsed.mitigations) ? parsed.mitigations : []).slice(0, 3).map((x: any, i: number) => {
        const sim = c.sim(`mitigations[${i}].sim_id`, x?.sim_id);
        if (sim && scenarioSims.has(sim)) c.errors.push(`mitigations[${i}] reuses a scenario fork; a mitigation must be its own simulated fork with the fix applied`);
        // Display the fork's own title so the advice always matches what was simulated.
        return { sim, title: sim?.title ?? `Mitigation ${i + 1}`, why: c.text(`mitigations[${i}].why`, x?.why, false, 300) };
      });
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
    case 'health': {
      const valid = ['runway', 'crunch_risk', 'dti', 'utilization', 'savings_rate', 'goal_track'];
      const indicators = (Array.isArray(parsed.indicators) ? parsed.indicators : []).slice(0, 6).map((x: any, i: number) => ({
        vital: valid.includes(x?.vital) ? x.vital : '',
        meaning: c.text(`indicators[${i}].meaning`, x?.meaning, true, 300),
      }));
      if (indicators.filter((x: any) => x.vital).length < 3) c.errors.push('explain at least three of the six indicators, using their exact names');
      // If Nemotron simulated moves but didn't name one, the engine picks the one that raises the score most.
      const scoreOf = (s: Sim) => s.result.vitals.find(v => v.key === 'score')!.value;
      const engineBest = [...state.sims.values()].filter(s => scoreOf(s) > state.baseline.vitals.find(v => v.key === 'score')!.value).sort((a, b) => scoreOf(b) - scoreOf(a))[0];
      const best = state.sims.has(parsed.best_move_sim) ? c.sim('best_move_sim', parsed.best_move_sim) : engineBest;
      if (!best) c.errors.push('simulate at least one candidate move with simulate_scenario, then cite it as best_move_sim');
      const why = c.text('best_move_why', parsed.best_move_why, false, 300);
      const vit = state.baseline.vitals;
      r.highlights = vit.map(v => ({ label: VITAL_LABEL[v.key], value: v.display, direction: v.band === 'green' ? 'better' : v.band === 'red' ? 'worse' : 'neutral' }));
      r.sections.push({ heading: 'Your vitals', items: indicators.filter((x: any) => x.vital).map((x: any) => `${VITAL_LABEL[x.vital]} (${vit.find(v => v.key === x.vital)!.display}): ${x.meaning}`) });
      if (best) {
        r.scenarios = [draft(best)];
        r.sections.push({ heading: 'Best next move', items: [`${best.title}: ${why || summaryLine(best)}`] });
      }
      r.extra = { vitals: vit, indicators };
      break;
    }
    case 'briefing': {
      const sentinel = state.context.mode === 'sentinel';
      const upcoming = c.texts('upcoming', parsed.upcoming, 5);
      const watch = c.texts('watch_out', parsed.watch_out, 3);
      // If Nemotron simulated fixes but didn't name one, the engine picks the one with the lowest risk.
      const engineFix = [...state.sims.values()].filter(s => s.diff.crunchAfter < s.diff.crunchBefore).sort((a, b) => a.diff.crunchAfter - b.diff.crunchAfter)[0];
      const fix = state.sims.has(parsed.fix_sim) ? c.sim('fix_sim', parsed.fix_sim) : engineFix ?? c.sim('fix_sim', parsed.fix_sim, sentinel);
      const fixWhy = c.text('fix_why', parsed.fix_why, false, 300);
      if (sentinel && fix && fix.diff.crunchAfter >= fix.diff.crunchBefore) c.errors.push('fix_sim must lower overdraft risk; simulate a different fix');
      if (upcoming.length) r.sections.push({ heading: 'Coming up', items: upcoming });
      if (watch.length) r.sections.push({ heading: 'Watch out', items: watch });
      if (fix) {
        r.scenarios = [draft(fix)];
        r.highlights = highlightsFromDiff(fix.diff);
        r.sections.push({ heading: sentinel ? 'Suggested fix' : 'Worth doing', items: [`${fix.title}: ${fixWhy || summaryLine(fix)}`] });
      } else {
        r.highlights = briefingHighlights(state);
      }
      r.extra = { mode: sentinel ? 'sentinel' : 'weekly', fixReachesTarget: fix ? fix.diff.crunchAfter < 10 : null };
      break;
    }
    case 'coach':
    case 'clarify':
    case 'debate':
      c.errors.push('internal: coach must be routed before running');
      break;
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
  if (Array.isArray(parsed.sources)) {
    r.sources = parsed.sources
      .filter((x: any) => typeof x?.url === 'string' && state.sources.has(x.url))
      .slice(0, 4)
      .map((x: any) => ({ title: state.sources.get(x.url)!, url: x.url }));
  }
  if (!r.followUp && typeof parsed.follow_up === 'string') r.followUp = c.text('follow_up', parsed.follow_up, false, 300) || undefined;
  return c.errors.length ? { result: null, errors: c.errors } : { result: r, errors: [] };
}

function publicOpp(o: ReturnType<typeof getOpportunities>[number]) {
  return { opportunity: o.opportunity, type: o.type, scope: o.scope, owner: o.owner, title: o.title, evidence: o.evidence, estMonthlySavings: o.est_monthly_savings, free: o.free, effort: o.effort };
}

function defaultTitle(f: FeatureKind): string {
  return { twin: 'Your question', ripple: 'Ripple effect', negotiation: 'A middle path', stress: 'Stress test', life_event: 'Life event plan', memory: 'From your decision log', opportunity: 'Opportunities', health: 'Your financial health', briefing: 'Household briefing', coach: 'Coach', clarify: 'A few questions first', debate: 'The debate' }[f];
}

function summaryLine(s: Sim): string {
  const d = s.diff;
  const goal = d.goals.find(g => g.shiftDays !== 0);
  const parts = [`lowest cash ${$(d.minBalanceAfter)}`, `overdraft risk ${d.crunchAfter}%`];
  if (goal) parts.push(`${goal.name} ${goal.shiftDays >= GOAL_HORIZON_DAYS ? 'out of reach within 5 years' : goal.shiftDays > 0 ? `${goal.shiftDays} days later` : `${-goal.shiftDays} days sooner`}`);
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
    out.push({ step: `${g.name} ${g.shiftDays >= GOAL_HORIZON_DAYS ? 'moves out of reach within 5 years' : g.shiftDays > 0 ? `slips ${g.shiftDays} days` : `arrives ${-g.shiftDays} days sooner`}: ${g.beforeEta} to ${g.afterEta}.`, area: 'goal', severity: g.shiftDays > 90 ? 'high' : 'medium' });
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
      let lever = decisionLever(q, t);
      let sourceNote = '';
      if (parseMoney(q) == null && /\b(buy|afford|purchase|price|cost|worth)\b/i.test(q)) {
        const found = state.http ? lookupInformation(state.http, q) : { passages: [] as { title: string; url: string; text: string }[] };
        const price = priceFromPassages(found.passages);
        if (!price) {
          const r = base(state, shortLabel(q), 'I looked for a public price and did not find one I can use. What amount should I check against the household?', 'fallback');
          r.verdict = 'not_yet';
          r.extra = { reason, sources: found.passages.map(p => p.url) };
          return r;
        }
        if (lever.kind === 'one_time') lever = { ...lever, amount: price };
        sourceNote = found.passages[0] ? ` Using ${$(price)} from ${found.passages[0].title}.` : '';
      }
      const { sim, errors } = runSim(state, shortLabel(q), [lever]);
      if (!sim) {
        const why = errors.join('; ').replace(/^lever 1: /, '');
        return base(state, defaultTitle(state.feature), `I could not simulate that: ${why}. Try rephrasing with an amount and a month.`, 'fallback');
      }
      const d = sim.diff;
      const worseBand = d.vitals.some(v => v.direction === 'worse' && sim.result.vitals.find(x => x.key === v.key)!.band !== state.baseline.vitals.find(x => x.key === v.key)!.band);
      const breach = !!d.bufferBreachDay;
      const goalSlip = d.goals.some(g => g.shiftDays > 30);
      if (state.feature === 'twin') {
        // Out of reach: costs more than all household cash plus two years of surplus.
        const reach = state.baseline.startLiquid + 24 * Math.max(0, state.baseline.monthlySurplus);
        const outOfReach = breach && lever.kind === 'one_time' && lever.amount > reach;
        const verdict = outOfReach ? 'no' : breach ? 'not_yet' : worseBand || goalSlip ? 'yes_with_tradeoffs' : 'yes';
        const r = base(state, sim.title, '', 'fallback');
        r.verdict = verdict;
        r.answer =
          verdict === 'yes'
            ? `Yes. ${sim.title} keeps lowest household cash at ${$(d.minBalanceAfter)} and overdraft risk at ${d.crunchAfter}%.${sourceNote}`
            : verdict === 'yes_with_tradeoffs'
              ? `You can, with trade-offs: ${summaryLine(sim)}.${sourceNote}`
              : verdict === 'no'
                ? `No. At ${$(lever.kind === 'one_time' ? lever.amount : 0)} it costs more than the household's ${$(state.baseline.startLiquid)} in cash plus two years of savings, and cash would go negative (${$(d.minBalanceAfter)}).${sourceNote}`
                : `Not yet. Household cash would fall below the buffer on ${d.bufferBreachDay}. ${summaryLine(sim)}.${sourceNote}`;
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
    case 'health': {
      const vit = state.baseline.vitals.filter(v => v.key !== 'score');
      const worst = [...vit].sort((a, b) => bandRank(b.band) - bandRank(a.band))[0];
      const score = state.baseline.vitals.find(v => v.key === 'score')!;
      const r = base(state, 'Your financial health', `The household score is ${score.display}. The weakest indicator is ${VITAL_LABEL[worst.key].toLowerCase()} at ${worst.display}.`, 'fallback');
      r.highlights = state.baseline.vitals.map(v => ({ label: VITAL_LABEL[v.key], value: v.display, direction: v.band === 'green' ? 'better' : v.band === 'red' ? 'worse' : 'neutral' }));
      r.sections.push({ heading: 'Your vitals', items: vit.map(v => `${VITAL_LABEL[v.key]}: ${v.display} (${v.band}). ${VITAL_MEANING[v.key]}`) });
      r.extra = { vitals: state.baseline.vitals, reason };
      return r;
    }
    case 'briefing': {
      const sentinel = state.context.mode === 'sentinel';
      const f = state.baseline;
      const r = base(state, sentinel ? 'Crunch ahead' : 'Household briefing', '', 'fallback');
      const upcoming = upcomingBills(state, 5);
      r.answer = sentinel
        ? `Overdraft risk peaks at ${Math.round(f.peakCrunchRisk * 100)}% on ${dayToLabel(f.peakCrunchDay)}.`
        : `Over the next 60 days household cash stays at or above ${$(f.minBalance)}, with overdraft risk at ${Math.round(f.peakCrunchRisk * 100)}%.`;
      r.sections.push({ heading: 'Coming up', items: upcoming });
      if (sentinel) {
        // Free fixes first: move bills after payday, trim flexible spending for a month, or both.
        const sim = bestSentinelFix(state);
        if (sim) {
          r.scenarios = [draft(sim)];
          r.highlights = highlightsFromDiff(sim.diff);
          const note = sim.diff.crunchAfter < 10 ? '' : ' This is the best free fix found; it does not get risk under 10%, so a transfer from outside the household may be needed.';
          r.sections.push({ heading: 'Suggested fix', items: [`${sim.title}: overdraft risk ${sim.diff.crunchBefore}% to ${sim.diff.crunchAfter}%.${note}`] });
        }
      } else r.highlights = briefingHighlights(state);
      r.extra = { mode: sentinel ? 'sentinel' : 'weekly', reason };
      return r;
    }
    case 'clarify':
      return base(state, 'A few questions first', 'Tell me a bit more and I can work it out.', 'fallback');
    case 'debate':
      return base(state, 'The debate', 'The debate needs Nemotron; try again when the model is available.', 'fallback');
    case 'coach':
      return base(state, 'Coach', 'I could not work out what to look at. Try asking about a purchase, an emergency, or your vitals.', 'fallback');
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

const VITAL_MEANING: Record<string, string> = {
  runway: 'How many months of essential bills current cash would cover.',
  crunch_risk: 'The highest chance in the next 30 days that checking dips below its safety buffer.',
  dti: 'The share of monthly income that goes to debt payments.',
  utilization: 'How much of the available credit card limits is in use.',
  savings_rate: 'The share of income left after bills and spending.',
  goal_track: 'How far behind the slowest shared goal is running.',
};

function bandRank(b: string): number {
  return b === 'red' ? 2 : b === 'yellow' ? 1 : 0;
}

function upcomingBills(state: AgentState, n: number): string[] {
  const t = state.snap.twin;
  return t.obligations
    .filter(o => o.visible && o.kind !== 'income' && o.kind !== 'transfer')
    .map(o => ({ o, d: nextOccurrence(o.cadence, o.anchorDay, t.today + 1) }))
    .filter(x => x.d > 0 && x.d <= t.today + 30)
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map(x => `${dayToLabel(x.d)}: ${x.o.label} ${$(x.o.amount)}`);
}

function briefingHighlights(state: AgentState): Highlight[] {
  const b = state.baseline;
  return [
    { label: 'Lowest cash (60 days)', value: $(b.minBalance), direction: 'neutral' },
    { label: 'Overdraft risk', value: `${Math.round(b.peakCrunchRisk * 100)}%`, direction: b.peakCrunchRisk > 0.25 ? 'worse' : 'neutral' },
    { label: 'Monthly surplus', value: $(b.monthlySurplus), direction: b.monthlySurplus > 0 ? 'better' : 'worse' },
  ];
}

/**
 * Health Check: the engine simulates standard improvement moves up front; Nemotron picks and explains.
 * (Spec: "The engine generates options; the AI picks and explains.")
 */
export function healthCandidates(state: AgentState): Sim[] {
  const t = state.snap.twin;
  const start = dayToIso(t.today + 1);
  const out: Sim[] = [];
  const payoff = getOpportunities(state).find(o => o.type === 'high_apr_payoff' && o.lever);
  if (payoff) {
    const s = runSim(state, payoff.title, [payoff.lever!]).sim;
    if (s) out.push(s);
  }
  const trims = t.spending
    .filter(c => ['dining', 'shopping', 'entertainment'].includes(c.category) && c.dailyMean > 1)
    .map(c => ({ kind: 'recurring_change' as const, category: c.category, monthly_delta: -Math.round(c.dailyMean * 30.4375 * 0.25), start_date: start, label: `Trim ${c.category} by a quarter` }));
  if (trims.length) {
    const s = runSim(state, 'Trim flexible spending by a quarter', trims).sim;
    if (s) out.push(s);
  }
  const sub = getOpportunities(state).find(o => o.type === 'subscription_increase');
  if (sub) {
    const amt = Number(sub.evidence.cancelling_entirely_saves_per_month) || 0;
    const s = amt > 0 ? runSim(state, `Cancel ${sub.title.replace(/ went up$/, '').toLowerCase()}`, [{ kind: 'recurring_change', category: 'subscriptions', monthly_delta: -amt, start_date: start, label: 'Cancel subscription' }]).sim : undefined;
    if (s) out.push(s);
  }
  return out;
}

/**
 * Catches "18 days sooner" when the engine says the goal moved 18 days later (or the reverse).
 * Only judges numbers that match a simulated goal shift exactly.
 */
export function wrongDirection(text: string, state: AgentState): string {
  const shifts = [...state.sims.values()].flatMap(s => s.diff.goals.map(g => g.shiftDays)).filter(x => x !== 0);
  if (!shifts.length) return '';
  const claims: [number, 'later' | 'sooner'][] = [];
  for (const m of text.matchAll(/(\d+)[\s\u2011-]*days?\s+(sooner|earlier|ahead|later|behind)/gi)) {
    claims.push([Number(m[1]), /sooner|earlier|ahead/i.test(m[2]) ? 'sooner' : 'later']);
  }
  for (const m of text.matchAll(/\b(delay|slip|push)\w*[^.]{0,40}?\bby (\d+) days/gi)) claims.push([Number(m[2]), 'later']);
  for (const m of text.matchAll(/\b(speed|pull|bring)\w*[^.]{0,40}?\bby (\d+) days/gi)) claims.push([Number(m[2]), 'sooner']);
  for (const [n, dir] of claims) {
    const matching = shifts.filter(x => Math.abs(x) === n);
    if (matching.length && matching.every(x => (x > 0 ? 'later' : 'sooner') !== dir)) return `"${n} days ${dir}" but the engine shows ${n} days ${dir === 'later' ? 'sooner' : 'later'}`;
  }
  return '';
}

/** Tries free fixes and keeps the one that lowers peak overdraft risk most. */
function bestSentinelFix(state: AgentState): Sim | undefined {
  const t = state.snap.twin;
  const start = dayToIso(t.today + 1);
  const end = dayToIso(t.today + 31);
  const moves = getOpportunities(state).filter(o => o.type === 'bill_timing' && o.lever).map(o => o.lever!);
  const trims = t.spending
    .filter(c => ['dining', 'shopping', 'entertainment'].includes(c.category) && c.dailyMean > 1)
    .map(c => ({ kind: 'recurring_change' as const, category: c.category, monthly_delta: -Math.round(c.dailyMean * 30.4375 * 0.5), start_date: start, end_date: end, label: `Halve ${c.category} for a month` }));
  const candidates: [string, typeof moves][] = [];
  if (moves.length) candidates.push(['Move bills after payday', moves]);
  if (trims.length) candidates.push(['Trim flexible spending for a month', trims]);
  if (moves.length && trims.length) candidates.push(['Move bills and trim spending', [...moves, ...trims]]);
  let best: Sim | undefined;
  for (const [title, levers] of candidates) {
    const sim = runSim(state, title, levers).sim;
    if (sim && sim.diff.crunchAfter < sim.diff.crunchBefore && (!best || sim.diff.crunchAfter < best.diff.crunchAfter)) best = sim;
  }
  return best;
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

