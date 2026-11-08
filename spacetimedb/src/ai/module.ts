// SpacetimeDB wiring for the Nemotron features.
//
// Flow: a reducer authorizes the caller, rate-limits, and inserts ai_run + ai_insight
// ("thinking") + an ai_job row scheduled for now. The ai_job row triggers run_ai_job, a
// procedure, which (1) reads the requester's filtered view in one transaction, (2) runs the
// Nemotron agent loop over HTTP, (3) writes the result, the agent log and draft forks in a
// second transaction. Every subscribed device sees "thinking" flip to the answer.
//
// index.ts registers these with: export const { ... } = registerNemotron(spacetimedb);

import { ScheduleAt, TimeDuration } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import type Spacetimedb from '../index';
import { envValue, requireAdmin, requireCoOwner, requireMember, type Ctx } from '../auth';
import { aiJob } from '../tables';
import { runAgent } from './agent';
import { DEFAULT_BASE_URL, DEFAULT_MODEL, type HttpLike, type ModelConfig } from './model';
import { buildSnapshot, type SnapshotInput, type Snapshot } from './snapshot';
import type { MemoryRow } from './memory';
import { aiInsight, decisionMemory, negotiation, negotiationPosition } from './tables';
import { describeLever, newState } from './tools';
import type { FeatureKind, InsightResult, ResolvedLever } from './types';

const RATE_WINDOW_MICROS = 60n * 60n * 1_000_000n; // 1 hour
const RATE_LIMIT = 40; // agent runs per household per hour
const MAX_INFLIGHT = 3; // concurrent runs per household
const MODEL_TIMEOUT_MS = 30_000;
const MAX_DRAFT_FORKS = 4;

type Me = ReturnType<typeof requireMember>;

// ---------- Reducer helpers ----------

function cleanText(text: string, field: string, min = 3, max = 600): string {
  const s = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < min) throw new SenderError(`${field} is too short`);
  if (s.length > max) throw new SenderError(`${field} is too long (max ${max} characters)`);
  return s;
}

function rateLimit(ctx: Ctx, householdId: bigint): void {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const row = ctx.db.aiUsage.householdId.find(householdId);
  if (!row || now - row.windowStart.microsSinceUnixEpoch > RATE_WINDOW_MICROS) {
    if (row) ctx.db.aiUsage.householdId.update({ ...row, windowStart: ctx.timestamp, count: 1 });
    else ctx.db.aiUsage.insert({ householdId, windowStart: ctx.timestamp, count: 1 });
  } else {
    if (row.count >= RATE_LIMIT) throw new SenderError('The household has reached its hourly limit for the navigator. Try again later.');
    ctx.db.aiUsage.householdId.update({ ...row, count: row.count + 1 });
  }
  const inflight = [...ctx.db.aiInsight.householdId.filter(householdId)].filter(i => i.status === 'thinking').length;
  if (inflight >= MAX_INFLIGHT) throw new SenderError('The navigator is still working on earlier questions.');
}

function enqueue(ctx: Ctx, me: Me, kind: FeatureKind, question: string, audiencePersonId: bigint, context: Record<string, string> = {}) {
  rateLimit(ctx, me.household.id);
  const run = ctx.db.aiRun.insert({
    id: 0n,
    householdId: me.household.id,
    kind,
    requesterPersonId: me.person.id,
    inputJson: '',
    status: 'queued',
    resultScenarioId: 0n,
    summary: '',
    createdAt: ctx.timestamp,
  });
  const insight = ctx.db.aiInsight.insert({
    id: 0n,
    runId: run.id,
    householdId: me.household.id,
    requesterPersonId: me.person.id,
    audiencePersonId,
    kind,
    question,
    contextJson: JSON.stringify(context),
    status: 'thinking',
    title: '',
    resultJson: '',
    scenarioId: 0n,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  ctx.db.aiJob.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch), runId: run.id });
  return insight;
}

/** Append a decision to the household's memory. Call this from vote/merge reducers too. */
export function rememberDecision(
  ctx: Ctx,
  d: { householdId: bigint; scenarioId: bigint; outcome: string; title: string; reasoning: string; tags?: string; amountCents?: bigint; authorPersonId: bigint },
) {
  const household = ctx.db.household.id.find(d.householdId);
  return ctx.db.decisionMemory.insert({
    id: 0n,
    householdId: d.householdId,
    day: household?.simDay ?? 0,
    scenarioId: d.scenarioId,
    outcome: d.outcome,
    title: d.title.slice(0, 120),
    reasoning: d.reasoning.slice(0, 1000),
    tags: (d.tags ?? '').slice(0, 200),
    amountCents: d.amountCents ?? 0n,
    authorPersonId: d.authorPersonId,
    createdAt: ctx.timestamp,
  });
}

// ---------- Procedure helpers (plain data in, plain data out) ----------

interface Loaded {
  runId: bigint;
  insightId: bigint;
  householdId: bigint;
  baselineScenarioId: bigint;
  kind: FeatureKind;
  question: string;
  audiencePersonId: bigint;
  snapInput: SnapshotInput;
  memoryRows: MemoryRow[];
  context: Record<string, unknown>;
  primary: ModelConfig | null;
  secondary: ModelConfig | null;
  labels: { persons: Map<bigint, string>; accounts: Map<bigint, string>; goals: Map<bigint, string>; obligations: Map<bigint, string> };
  salt: number;
}

function modelConfigs(tx: Ctx, aiEnabled: boolean): { primary: ModelConfig | null; secondary: ModelConfig | null } {
  if (!aiEnabled) return { primary: null, secondary: null };
  const noThink = envValue(tx, 'AI_NO_THINK') !== 'false';
  const key = envValue(tx, 'AI_API_KEY');
  const primary = key
    ? { baseUrl: envValue(tx, 'AI_BASE_URL') ?? DEFAULT_BASE_URL, apiKey: key, model: envValue(tx, 'AI_MODEL') ?? DEFAULT_MODEL, noThink }
    : null;
  const key2 = envValue(tx, 'AI_FALLBACK_API_KEY');
  const secondary = key2
    ? { baseUrl: envValue(tx, 'AI_FALLBACK_BASE_URL') ?? DEFAULT_BASE_URL, apiKey: key2, model: envValue(tx, 'AI_FALLBACK_MODEL') ?? DEFAULT_MODEL, noThink }
    : null;
  return { primary: primary ?? secondary, secondary: primary ? secondary : null };
}

function loadJob(tx: Ctx, runId: bigint): Loaded | null {
  const run = tx.db.aiRun.id.find(runId);
  if (!run || run.status !== 'queued') return null;
  const insight = [...tx.db.aiInsight.runId.filter(runId)][0];
  const household = tx.db.household.id.find(run.householdId);
  if (!insight || !household) return null;
  tx.db.aiRun.id.update({ ...run, status: 'thinking' });

  const hid = household.id;
  const kind = run.kind as FeatureKind;
  const today = household.simDay;
  const context: Record<string, unknown> = {};
  let requester = run.requesterPersonId;
  const ctxIn = JSON.parse(insight.contextJson || '{}') as Record<string, string>;

  const persons = [...tx.db.person.householdId.filter(hid)];
  const personName = new Map(persons.map(p => [p.id, p.displayName]));

  if (kind === 'negotiation') {
    // Mediation runs on the household view (joint + household-shared totals), never one member's private view.
    requester = 0n;
    const negId = BigInt(ctxIn.negotiationId ?? '0');
    const neg = tx.db.negotiation.id.find(negId);
    const positions = [...tx.db.negotiationPosition.negotiationId.filter(negId)];
    const tokenOf = new Map([...persons].sort((a, b) => Number(a.id - b.id)).map((p, i) => [p.id, String.fromCharCode(65 + i)]));
    context.topic = neg?.topic ?? '';
    context.positions = positions.map(p => ({ member: tokenOf.get(p.personId) ?? '?', want: p.want, priority: p.priority }));
    if (neg) tx.db.negotiation.id.update({ ...neg, status: 'mediating', insightId: insight.id });
  }

  const snapInput: SnapshotInput = {
    today,
    nowMicros: tx.timestamp.microsSinceUnixEpoch,
    requesterPersonId: requester,
    persons: persons.map(p => ({ id: p.id, displayName: p.displayName, role: p.role })),
    accounts: [...tx.db.account.householdId.filter(hid)],
    grants: [...tx.db.grant.householdId.filter(hid)].map(g => ({
      accountId: g.accountId,
      granteePersonId: g.granteePersonId,
      level: g.level,
      status: g.status,
      expiresAtMicros: g.expiresAt.microsSinceUnixEpoch,
    })),
    obligations: [...tx.db.obligation.householdId.filter(hid)],
    txns: [...tx.db.txn.householdId.filter(hid)].filter(x => x.day > today - 180 && x.day <= today),
    spendProfiles: [...tx.db.spendProfile.householdId.filter(hid)],
    goals: [...tx.db.goal.householdId.filter(hid)],
  };

  const memoryRows: MemoryRow[] =
    kind === 'memory' || kind === 'negotiation' ? [...tx.db.decisionMemory.householdId.filter(hid)] : [];

  const { primary, secondary } = modelConfigs(tx, household.aiEnabled);
  return {
    runId,
    insightId: insight.id,
    householdId: hid,
    baselineScenarioId: household.baselineScenarioId,
    kind,
    question: insight.question,
    audiencePersonId: insight.audiencePersonId,
    snapInput,
    memoryRows,
    context,
    primary,
    secondary,
    labels: {
      persons: personName,
      accounts: new Map(snapInput.accounts.map(a => [a.id, a.nickname || a.kind.replace('_', ' ')])),
      goals: new Map(snapInput.goals.map(g => [g.id, g.name])),
      obligations: new Map(snapInput.obligations.map(o => [o.id, o.label || o.kind])),
    },
    // Fresh token salt per job so tokens can't be correlated across jobs.
    salt: Number(tx.timestamp.microsSinceUnixEpoch % 9973n),
  };
}

/** Maps tokens in model/engine text back to names the audience is allowed to see. */
function humanizer(snap: Snapshot, labels: Loaded['labels']) {
  const tokenLabel = new Map<string, string>();
  for (const [tok, id] of snap.map.members) tokenLabel.set(tok, labels.persons.get(id) ?? `member ${tok}`);
  const other = new Map<string, string>();
  for (const [tok, id] of snap.map.accounts) other.set(tok, labels.accounts.get(id) ?? tok);
  for (const [tok, id] of snap.map.obligations) other.set(tok, labels.obligations.get(id) ?? tok);
  for (const [tok, id] of snap.map.goals) other.set(tok, labels.goals.get(id) ?? tok);
  const tokenRe = other.size ? new RegExp(`\\b(${[...other.keys()].join('|')})\\b`, 'g') : null;
  const str = (s: string) => {
    let out = s.replace(/\b[Mm]ember ([A-Z])\b/g, (m, tok) => tokenLabel.get(tok) ?? m);
    if (tokenRe) out = out.replace(tokenRe, m => other.get(m) ?? m);
    return out;
  };
  const walk = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') {
      if ((key === 'member' || key === 'owner') && tokenLabel.has(v)) return tokenLabel.get(v);
      return str(v);
    }
    if (Array.isArray(v)) return v.map(x => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk;
}

function leverParams(l: ResolvedLever, snap: Snapshot): string {
  const id = (m: Map<string, bigint>, tok: string) => (m.has(tok) ? String(m.get(tok)) : '');
  return JSON.stringify({
    amountCents: Math.round(l.amount * 100),
    day: l.day,
    endDay: l.endDay,
    flowIn: l.flowIn,
    category: l.category,
    percent: l.percent,
    accountId: id(snap.map.accounts, l.from),
    toAccountId: id(snap.map.accounts, l.to),
    obligationId: id(snap.map.obligations, l.from),
    personId: id(snap.map.members, l.from),
  });
}

// ---------- Registration ----------

export function registerNemotron(spacetimedb: typeof Spacetimedb) {
  const askTwin = spacetimedb.reducer({ question: t.string() }, (ctx, { question }) => {
    const me = requireMember(ctx);
    enqueue(ctx, me, 'twin', cleanText(question, 'question'), me.person.id);
  });

  const simulateRipple = spacetimedb.reducer({ decision: t.string() }, (ctx, { decision }) => {
    const me = requireMember(ctx);
    enqueue(ctx, me, 'ripple', cleanText(decision, 'decision'), me.person.id);
  });

  const stressTest = spacetimedb.reducer({ scenario: t.string() }, (ctx, { scenario }) => {
    const me = requireMember(ctx);
    enqueue(ctx, me, 'stress', cleanText(scenario, 'scenario'), me.person.id);
  });

  const simulateLifeEvent = spacetimedb.reducer({ event: t.string() }, (ctx, { event }) => {
    const me = requireMember(ctx);
    enqueue(ctx, me, 'life_event', cleanText(event, 'event'), me.person.id);
  });

  const askMemory = spacetimedb.reducer({ question: t.string() }, (ctx, { question }) => {
    const me = requireMember(ctx);
    enqueue(ctx, me, 'memory', cleanText(question, 'question'), me.person.id);
  });

  const scanOpportunities = spacetimedb.reducer(ctx => {
    const me = requireMember(ctx);
    enqueue(ctx, me, 'opportunity', 'Find opportunities in our accounts and bills', me.person.id);
  });

  // ----- Negotiation Room -----
  const openNegotiation = spacetimedb.reducer({ topic: t.string() }, (ctx, { topic }) => {
    const me = requireMember(ctx);
    ctx.db.negotiation.insert({
      id: 0n,
      householdId: me.household.id,
      topic: cleanText(topic, 'topic', 3, 140),
      status: 'open',
      openedByPersonId: me.person.id,
      insightId: 0n,
      createdAt: ctx.timestamp,
    });
  });

  const submitPosition = spacetimedb.reducer(
    { negotiationId: t.u64(), want: t.string(), priority: t.u8() },
    (ctx, { negotiationId, want, priority }) => {
      const me = requireMember(ctx);
      const neg = ctx.db.negotiation.id.find(negotiationId);
      if (!neg || neg.householdId !== me.household.id) throw new SenderError('Negotiation not found');
      if (neg.status === 'closed') throw new SenderError('This negotiation is closed');
      const text = cleanText(want, 'position', 3, 400);
      const p = Math.max(1, Math.min(5, priority));
      // One position per member; resubmitting replaces it. Only you can write your own position.
      const existing = [...ctx.db.negotiationPosition.negotiationId.filter(negotiationId)].find(x => x.personId === me.person.id);
      if (existing) ctx.db.negotiationPosition.id.update({ ...existing, want: text, priority: p, updatedAt: ctx.timestamp });
      else ctx.db.negotiationPosition.insert({ id: 0n, negotiationId, householdId: me.household.id, personId: me.person.id, want: text, priority: p, updatedAt: ctx.timestamp });
      if (neg.status !== 'open') ctx.db.negotiation.id.update({ ...neg, status: 'open' });
    },
  );

  const requestMediation = spacetimedb.reducer({ negotiationId: t.u64() }, (ctx, { negotiationId }) => {
    const me = requireMember(ctx);
    const neg = ctx.db.negotiation.id.find(negotiationId);
    if (!neg || neg.householdId !== me.household.id) throw new SenderError('Negotiation not found');
    const positions = [...ctx.db.negotiationPosition.negotiationId.filter(negotiationId)];
    if (positions.length < 2) throw new SenderError('At least two members need to add a position first');
    enqueue(ctx, me, 'negotiation', neg.topic, 0n, { negotiationId: String(negotiationId) });
  });

  const closeNegotiation = spacetimedb.reducer({ negotiationId: t.u64() }, (ctx, { negotiationId }) => {
    const me = requireMember(ctx);
    const neg = ctx.db.negotiation.id.find(negotiationId);
    if (!neg || neg.householdId !== me.household.id) throw new SenderError('Negotiation not found');
    ctx.db.negotiation.id.update({ ...neg, status: 'closed' });
  });

  // ----- Financial Memory -----
  const recordDecision = spacetimedb.reducer(
    { scenarioId: t.u64(), outcome: t.string(), title: t.string(), reasoning: t.string(), tags: t.string(), amountCents: t.i64() },
    (ctx, args) => {
      const me = requireMember(ctx);
      if (!['merged', 'declined', 'deferred', 'note'].includes(args.outcome)) throw new SenderError('outcome must be merged, declined, deferred or note');
      if (args.scenarioId !== 0n) {
        const sc = ctx.db.scenario.id.find(args.scenarioId);
        if (!sc || sc.householdId !== me.household.id) throw new SenderError('Scenario not found');
      }
      rememberDecision(ctx, {
        householdId: me.household.id,
        scenarioId: args.scenarioId,
        outcome: args.outcome,
        title: cleanText(args.title, 'title', 3, 120),
        reasoning: cleanText(args.reasoning, 'reasoning', 3, 1000),
        tags: args.tags.slice(0, 200),
        amountCents: args.amountCents,
        authorPersonId: me.person.id,
      });
    },
  );

  /** Only the requester can move an insight from their private inbox to the household feed. */
  const shareInsight = spacetimedb.reducer({ insightId: t.u64() }, (ctx, { insightId }) => {
    const me = requireMember(ctx);
    const row = ctx.db.aiInsight.id.find(insightId);
    if (!row || row.householdId !== me.household.id || row.requesterPersonId !== me.person.id) throw new SenderError('Insight not found');
    const c = JSON.parse(row.contextJson || '{}');
    if (c.usedOthersData === 'true') {
      throw new SenderError("This answer used data another member shared only with you, so it can't be shared with the household.");
    }
    ctx.db.aiInsight.id.update({ ...row, audiencePersonId: 0n, updatedAt: ctx.timestamp });
  });

  /** Kill switch: co-owners can turn every model call off; features keep working on rules. */
  const setAiEnabled = spacetimedb.reducer({ enabled: t.bool() }, (ctx, { enabled }) => {
    const me = requireCoOwner(ctx);
    ctx.db.household.id.update({ ...me.household, aiEnabled: enabled });
  });

  /** Demo data for Financial Memory (admin only). Days are relative to the household's sim day. */
  const seedNemotronDemo = spacetimedb.reducer({ adminCode: t.string(), householdId: t.u64() }, (ctx, { adminCode, householdId }) => {
    requireAdmin(ctx, adminCode);
    const h = ctx.db.household.id.find(householdId);
    if (!h) throw new SenderError('Household not found');
    const add = (daysAgo: number, outcome: string, title: string, reasoning: string, tags: string, amountCents: bigint) =>
      ctx.db.decisionMemory.insert({ id: 0n, householdId, day: h.simDay - daysAgo, scenarioId: 0n, outcome, title, reasoning, tags, amountCents, authorPersonId: 0n, createdAt: ctx.timestamp });
    add(365, 'declined', 'Buy a second car', 'Declined because the car payment would have pushed debt-to-income above 40% and delayed the house down payment by about five months. Agreed to revisit once the car loan is paid off.', 'car vehicle auto loan purchase second car', 2_800_000n);
    add(300, 'merged', 'Move card autopay to the 3rd', 'Approved so the card payment lands after the 1st-of-month paycheck instead of the same week as the mortgage.', 'card autopay bill timing mortgage', 0n);
    add(200, 'merged', 'Start a $400/month house fund', 'Both agreed the house down payment is the top shared goal; $400 a month keeps runway above three months.', 'house down payment goal savings', 40_000n);
    add(90, 'deferred', 'Japan trip in spring', 'Deferred until after the holiday season so it does not overlap with December travel and property tax.', 'japan trip travel vacation', 320_000n);
    add(40, 'merged', 'Monthly top-up for Maya', 'Agreed to send $250 on the 1st each month during the semester instead of ad-hoc transfers.', 'maya student allowance transfer college', 25_000n);
  });

  // ----- The agent procedure -----
  const runAiJob = spacetimedb.procedure({ onSchedule: aiJob }, { job: aiJob.rowType }, t.unit(), (ctx, { job }) => {
    const loaded = ctx.withTx(tx => loadJob(tx, job.runId));
    if (!loaded) return {};

    let result: InsightResult;
    let status: string;
    let steps: { step: string; detail: string; flagged: boolean }[];
    let audit = '';
    let snap: Snapshot;
    try {
      snap = buildSnapshot(loaded.snapInput, loaded.salt);
      const state = newState(loaded.kind, snap, loaded.question, loaded.memoryRows, loaded.context);
      const http: HttpLike = {
        fetch: (url, init) => ctx.http.fetch(url, { method: init.method, headers: init.headers, body: init.body, timeout: TimeDuration.fromMillis(MODEL_TIMEOUT_MS) }),
      };
      const outcome = runAgent(state, { http, primary: loaded.primary, secondary: loaded.secondary });
      result = outcome.result;
      status = outcome.status;
      steps = outcome.steps;
      audit = outcome.auditPayload;
      steps.push({ step: 'usage', detail: `${outcome.modelCalls} model call(s), ${outcome.promptTokens} prompt + ${outcome.completionTokens} completion tokens`, flagged: false });
    } catch (e) {
      ctx.withTx(tx => {
        const run = tx.db.aiRun.id.find(loaded.runId);
        if (run) tx.db.aiRun.id.update({ ...run, status: 'failed', summary: String(e).slice(0, 300) });
        const ins = tx.db.aiInsight.id.find(loaded.insightId);
        if (ins) tx.db.aiInsight.id.update({ ...ins, status: 'failed', title: 'Something went wrong', updatedAt: tx.timestamp });
        tx.db.agentLog.insert({ id: 0n, householdId: loaded.householdId, runId: loaded.runId, step: 'error', detail: String(e).slice(0, 500), flagged: true, at: tx.timestamp });
      });
      return {};
    }

    const humanize = humanizer(snap, loaded.labels);
    const usedOthersData = snap.personallyGranted > 0;

    ctx.withTx(tx => {
      for (const s of steps) {
        tx.db.agentLog.insert({ id: 0n, householdId: loaded.householdId, runId: loaded.runId, step: s.step, detail: s.detail, flagged: s.flagged, at: tx.timestamp });
      }

      // Draft forks: humans review, co-sign and merge them through the normal Two-Key flow.
      const scenarioIds: Record<string, string> = {};
      for (const d of result.scenarios.slice(0, MAX_DRAFT_FORKS)) {
        const sc = tx.db.scenario.insert({
          id: 0n,
          householdId: loaded.householdId,
          parentId: loaded.baselineScenarioId,
          authorPersonId: 0n,
          agentKind: loaded.kind === 'negotiation' ? 'mediator' : 'coach',
          title: String(humanize(d.title)).slice(0, 80),
          explanation: String(humanize(result.answer)).slice(0, 600),
          status: 'draft',
          scope: loaded.audiencePersonId === 0n ? 'household' : 'individual',
          audiencePersonId: loaded.audiencePersonId,
          createdAt: tx.timestamp,
          computedAtDay: -1,
        });
        scenarioIds[d.simId] = String(sc.id);
        for (const l of d.levers) {
          tx.db.scenarioChange.insert({ id: 0n, scenarioId: sc.id, householdId: loaded.householdId, kind: l.kind, paramsJson: leverParams(l, snap), label: String(humanize(l.label)).slice(0, 80) });
        }
      }

      const publicResult = humanize({
        ...result,
        scenarios: result.scenarios.map(d => ({ simId: d.simId, scenarioId: scenarioIds[d.simId] ?? '', title: d.title, changes: d.levers.map(describeLever), diff: d.diff })),
      });
      const firstScenario = result.scenarios[0] ? BigInt(scenarioIds[result.scenarios[0].simId] ?? '0') : 0n;

      const ins = tx.db.aiInsight.id.find(loaded.insightId);
      if (ins) {
        const ctxOut = { ...JSON.parse(ins.contextJson || '{}'), usedOthersData: String(usedOthersData) };
        tx.db.aiInsight.id.update({
          ...ins,
          status,
          title: String(humanize(result.title)).slice(0, 80),
          resultJson: JSON.stringify(publicResult),
          scenarioId: firstScenario,
          contextJson: JSON.stringify(ctxOut),
          updatedAt: tx.timestamp,
        });
      }
      const run = tx.db.aiRun.id.find(loaded.runId);
      if (run) {
        tx.db.aiRun.id.update({ ...run, status, inputJson: audit.slice(0, 8000), resultScenarioId: firstScenario, summary: String(humanize(result.answer)).slice(0, 500) });
      }
      if (loaded.kind === 'negotiation') {
        const negId = BigInt((JSON.parse(ins?.contextJson || '{}') as Record<string, string>).negotiationId ?? '0');
        const neg = tx.db.negotiation.id.find(negId);
        if (neg) tx.db.negotiation.id.update({ ...neg, status: 'proposed', insightId: loaded.insightId });
      }
    });
    return {};
  });

  // ----- Views (server-side filtering; hidden rows never reach a device) -----
  const viewerOf = (ctx: { db: any; sender: any }) => {
    const m = ctx.db.member.identity.find(ctx.sender);
    if (!m || m.personId === 0n) return null;
    return { householdId: m.householdId as bigint, personId: m.personId as bigint };
  };

  const myAiInsights = spacetimedb.view({ name: 'my_ai_insights', public: true }, t.array(aiInsight.rowType), ctx => {
    const v = viewerOf(ctx);
    if (!v) return [];
    return [...ctx.db.aiInsight.householdId.filter(v.householdId)].filter(i => i.audiencePersonId === 0n || i.audiencePersonId === v.personId);
  });

  const agentLogRow = t.row('AgentLogEntry', {
    id: t.u64().primaryKey(),
    runId: t.u64(),
    step: t.string(),
    detail: t.string(),
    flagged: t.bool(),
    at: t.timestamp(),
  });
  const myAgentLog = spacetimedb.view({ name: 'my_agent_log', public: true }, t.array(agentLogRow), ctx => {
    const v = viewerOf(ctx);
    if (!v) return [];
    const visibleRuns = new Set(
      [...ctx.db.aiInsight.householdId.filter(v.householdId)]
        .filter(i => i.audiencePersonId === 0n || i.audiencePersonId === v.personId)
        .map(i => i.runId),
    );
    return [...ctx.db.agentLog.householdId.filter(v.householdId)]
      .filter(l => visibleRuns.has(l.runId) || l.step === 'injection_flag')
      .map(l => ({ id: l.id, runId: l.runId, step: l.step, detail: l.detail, flagged: l.flagged, at: l.at }));
  });

  const myDecisions = spacetimedb.view({ name: 'my_decisions', public: true }, t.array(decisionMemory.rowType), ctx => {
    const v = viewerOf(ctx);
    return v ? [...ctx.db.decisionMemory.householdId.filter(v.householdId)] : [];
  });

  const myNegotiations = spacetimedb.view({ name: 'my_negotiations', public: true }, t.array(negotiation.rowType), ctx => {
    const v = viewerOf(ctx);
    return v ? [...ctx.db.negotiation.householdId.filter(v.householdId)] : [];
  });

  const myNegotiationPositions = spacetimedb.view({ name: 'my_negotiation_positions', public: true }, t.array(negotiationPosition.rowType), ctx => {
    const v = viewerOf(ctx);
    return v ? [...ctx.db.negotiationPosition.householdId.filter(v.householdId)] : [];
  });

  return {
    askTwin,
    simulateRipple,
    stressTest,
    simulateLifeEvent,
    askMemory,
    scanOpportunities,
    openNegotiation,
    submitPosition,
    requestMediation,
    closeNegotiation,
    recordDecision,
    shareInsight,
    setAiEnabled,
    seedNemotronDemo,
    runAiJob,
    myAiInsights,
    myAgentLog,
    myDecisions,
    myNegotiations,
    myNegotiationPositions,
  };
}
