// End-to-end through the real reducers, procedure and views, on an in-memory database.
import { Identity, Timestamp } from 'spacetimedb';
import { beforeEach, describe, expect, it } from 'vitest';
import * as mod from '../../index';
import type { HttpLike } from '../model';
import { patelInput, MAYA, PRIYA, SAM } from './fixture';

// ---------- A tiny in-memory stand-in for ctx.db ----------

const PK: Record<string, string> = { nemotronJob: 'scheduledId', aiUsage: 'householdId', member: 'identity', presence: 'identity', nessieStatus: 'householdId' };
const eq = (a: any, b: any) => (a && typeof a.isEqual === 'function' ? a.isEqual(b) : a === b);

function makeDb() {
  const tables = new Map<string, any[]>();
  const seq = new Map<string, bigint>();
  const rows = (name: string) => tables.get(name) ?? (tables.set(name, []), tables.get(name)!);
  const table = (name: string) => {
    const pk = PK[name] ?? 'id';
    return new Proxy(
      {
        insert(row: any) {
          const r = { ...row };
          if (r[pk] === 0n) {
            const n = (seq.get(name) ?? 0n) + 1n;
            seq.set(name, n);
            r[pk] = n;
          }
          rows(name).push(r);
          return r;
        },
        iter: () => rows(name)[Symbol.iterator](),
        count: () => rows(name).length,
      } as any,
      {
        get(target, col: string) {
          if (col in target) return target[col];
          return {
            find: (v: any) => rows(name).find(r => eq(r[col], v)) ?? null,
            filter: (v: any) => rows(name).filter(r => eq(r[col], v))[Symbol.iterator](),
            update: (row: any) => {
              const list = rows(name);
              const i = list.findIndex(r => eq(r[col], row[col]));
              if (i === -1) throw new Error(`update: no ${name} row`);
              list[i] = { ...row };
              return list[i];
            },
            delete: (v: any) => {
              const list = rows(name);
              const i = list.findIndex(r => eq(r[col], v));
              if (i >= 0) list.splice(i, 1);
              return i >= 0;
            },
          };
        },
      },
    );
  };
  const db = new Proxy({} as any, { get: (_, name: string) => table(name) });
  return { db, rows };
}

// ---------- Fixture ----------

const ids = { [String(PRIYA)]: new Identity(101n), [String(SAM)]: new Identity(102n), [String(MAYA)]: new Identity(103n) };
const NOW = new Timestamp(1_800_000_000_000_000n);
let store: ReturnType<typeof makeDb>;
let env: Record<string, string>;

function reducerCtx(person: bigint) {
  return { sender: ids[String(person)], timestamp: NOW, db: store.db, env, random: () => 0.5, connectionId: null } as any;
}
function procCtx(http: HttpLike) {
  return { sender: new Identity(1n), timestamp: NOW, http, env, sleep: () => {}, withTx: (fn: any) => fn({ ...reducerCtx(PRIYA), sender: new Identity(1n) }) } as any;
}

function seed() {
  store = makeDb();
  env = { AI_API_KEY: 'test-key' };
  const input = patelInput();
  const H = 1n;
  store.db.household.insert({ id: H, name: 'The Patels', inviteCode: 'PATEL', cosignThresholdCents: 50_000n, baselineScenarioId: 50n, simDay: input.today, clockScheduleId: 0n, secondsPerDay: 3, aiEnabled: true, seed: 7n, createdAt: NOW });
  for (const p of input.persons) {
    store.db.person.insert({ id: p.id, householdId: H, displayName: p.displayName, role: p.role, personaKey: p.displayName.toLowerCase(), pinHash: '' });
    store.db.member.insert({ identity: ids[String(p.id)], householdId: H, personId: p.id, kind: 'person', online: true, lastActiveAt: NOW, stepUpAt: NOW });
  }
  for (const a of input.accounts) store.db.account.insert({ ...a, householdId: H, nessieId: '' });
  for (const g of input.grants) store.db.grant.insert({ id: 0n, householdId: H, accountId: g.accountId, grantorPersonId: 0n, granteePersonId: g.granteePersonId, granteeIdentityHex: '', level: g.level, historyWindowDays: 90, expiresAt: new Timestamp(g.expiresAtMicros), status: g.status, createdAt: NOW });
  for (const o of input.obligations) store.db.obligation.insert({ ...o, householdId: H, nessieId: '' });
  for (const t of input.txns) store.db.txn.insert({ id: 0n, householdId: H, nessieId: '', ...t });
  for (const g of input.goals) store.db.goal.insert({ ...g, householdId: H });
}

function scripted(replies: ((body: any) => any)[]): HttpLike & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    fetch(_u, init) {
      const body = JSON.parse(init.body);
      calls.push(body);
      const r = replies[Math.min(calls.length - 1, replies.length - 1)](body);
      return { status: r.status ?? 200, text: () => JSON.stringify(r.body ?? r) };
    },
  };
}
const toolCall = (name: string, args: unknown) => ({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const final = (obj: unknown) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

function runJobs(http: HttpLike) {
  for (const job of [...store.rows('nemotronJob')]) {
    store.db.nemotronJob.scheduledId.delete(job.scheduledId); // the host deletes the row before running
    (mod.runAiJob as any)(procCtx(http), { job });
  }
}

beforeEach(seed);

describe('Nemotron module end to end', () => {
  it('Digital Twin: reducer -> procedure -> verified answer, draft fork, audit log, private inbox', () => {
    (mod.askTwin as any)(reducerCtx(PRIYA), { question: 'Can Sam and I afford a $3,200 Japan trip in March?' });
    expect(store.rows('aiInsight')[0].status).toBe('thinking');

    const http = scripted([
      () => toolCall('simulate_scenario', { title: 'Japan trip in March', levers: [{ kind: 'one_time', amount: 3200, date: '2027-03-01', label: 'Japan trip' }] }),
      () => final({ title: 'Japan trip in March', verdict: 'yes_with_tradeoffs', answer: 'Yes for member A and member B. Lowest cash stays at {sim_1.lowest_cash_after}.', tradeoffs: ['The house goal moves {sim_1.goal_1.shift_days} days.'], recommended_sim: 'sim_1' }),
    ]);
    runJobs(http);

    const ins = store.rows('aiInsight')[0];
    expect(ins.status).toBe('done');
    const result = JSON.parse(ins.resultJson);
    // Tokens map back to names only after the model call.
    expect(result.answer).toMatch(/^Yes for Priya and Sam\. Lowest cash stays at \$[\d,]+\.$/);
    expect(result.scenarios[0].changes[0]).toContain('$3,200');
    // Nothing identifying went to the model.
    expect(JSON.stringify(http.calls)).not.toMatch(/Priya|Sam|Maya|IGNORE ALL|4417889921/);
    expect(store.rows('aiRun')[0].inputJson).not.toMatch(/Priya|Sam/);

    // Draft fork for the Two-Key flow, with real ids and cents.
    const sc = store.rows('scenario')[0];
    expect(sc).toMatchObject({ status: 'draft', agentKind: 'coach', parentId: 50n, scope: 'individual', audiencePersonId: PRIYA });
    expect(JSON.parse(store.rows('scenarioChange')[0].paramsJson)).toMatchObject({ amountCents: 320000, amount: -320000 });
    expect(typeof JSON.parse(store.rows('scenarioChange')[0].paramsJson).accountId).toBe('number');
    expect(ins.scenarioId).toBe(sc.id);

    // Append-only reasoning trail.
    const steps = store.rows('agentLog').map((l: any) => l.step);
    expect(steps).toEqual(expect.arrayContaining(['observe', 'injection_flag', 'pii_scan', 'simulate', 'verify', 'propose', 'usage']));

    // Inherited owner access is private to the requester; it must not leak into a shared answer.
    const seen = (p: bigint) => (mod.myAiInsights as any)(reducerCtx(p)).length;
    expect([seen(PRIYA), seen(SAM)]).toEqual([1, 0]);
    expect((mod.myAgentLog as any)(reducerCtx(SAM)).every((l: any) => l.step === 'injection_flag')).toBe(true);
    expect(() => (mod.shareInsight as any)(reducerCtx(PRIYA), { insightId: ins.id })).toThrow(/another member shared/);
    expect(seen(SAM)).toBe(0);
  });

  it('only the requester can share, and personally granted data blocks sharing', () => {
    // Sam grants Priya (only) full access to his business account.
    store.db.grant.insert({ id: 0n, householdId: 1n, accountId: 13n, grantorPersonId: SAM, granteePersonId: PRIYA, granteeIdentityHex: '', level: 'full', historyWindowDays: 90, expiresAt: new Timestamp(1_900_000_000_000_000n), status: 'active', createdAt: NOW });
    (mod.askTwin as any)(reducerCtx(PRIYA), { question: 'Can we afford a $500 couch?' });
    runJobs(scripted([() => ({ status: 503, body: {} })]));
    const ins = store.rows('aiInsight')[0];
    expect(ins.status).toBe('fallback');
    expect(() => (mod.shareInsight as any)(reducerCtx(SAM), { insightId: ins.id })).toThrow(/not found/);
    expect(() => (mod.shareInsight as any)(reducerCtx(PRIYA), { insightId: ins.id })).toThrow(/shared only with you/);
  });

  it('kill switch: co-owners turn the model off and features keep working on rules', () => {
    expect(() => (mod.setAiEnabled as any)(reducerCtx(MAYA), { enabled: false })).toThrow(/Co-owner/);
    (mod.setAiEnabled as any)(reducerCtx(SAM), { enabled: false });
    (mod.seedNemotronDemo as any)({ ...reducerCtx(PRIYA), env: { ADMIN_CODE: 'x' } }, { adminCode: 'x', householdId: 1n });
    (mod.askMemory as any)(reducerCtx(PRIYA), { question: 'Why did we decide against buying a car last November?' });
    const http = scripted([() => ({ status: 500, body: {} })]);
    runJobs(http);
    expect(http.calls).toHaveLength(0);
    const ins = store.rows('aiInsight')[0];
    expect(ins.status).toBe('fallback');
    expect(JSON.parse(ins.resultJson).answer).toContain('Buy a second car');
  });

  it('Negotiation Room: positions from two members, household-view mediation, visible to everyone', () => {
    (mod.openNegotiation as any)(reducerCtx(PRIYA), { topic: 'Spring spending' });
    const negId = store.rows('negotiation')[0].id;
    (mod.submitPosition as any)(reducerCtx(PRIYA), { negotiationId: negId, want: 'Send Maya $350 a month through May', priority: 4 });
    expect(() => (mod.requestMediation as any)(reducerCtx(SAM), { negotiationId: negId })).toThrow(/two members/);
    (mod.submitPosition as any)(reducerCtx(SAM), { negotiationId: negId, want: 'Japan trip in March, about $3,200', priority: 3 });
    (mod.requestMediation as any)(reducerCtx(SAM), { negotiationId: negId });

    const http = scripted([() => ({ status: 500, body: {} })]);
    runJobs(http);
    // The prompt carried member tokens, never names, and only household-level accounts.
    const sent = JSON.stringify(http.calls[0]);
    expect(sent).toContain('member C');
    expect(sent).not.toMatch(/Maya|credit_card/);

    expect(store.rows('negotiation')[0].status).toBe('proposed');
    const ins = store.rows('aiInsight')[0];
    expect(ins.audiencePersonId).toBe(0n);
    expect((mod.myAiInsights as any)(reducerCtx(MAYA))).toHaveLength(1);
    expect(store.rows('scenario').some((s: any) => s.agentKind === 'mediator' && s.scope === 'household')).toBe(true);
  });

  it('rejects outsiders and rate-limits', () => {
    const stranger = { ...reducerCtx(PRIYA), sender: new Identity(999n) };
    expect(() => (mod.askTwin as any)(stranger, { question: 'Can we afford it?' })).toThrow(/not in a household/);
    expect(() => (mod.askTwin as any)(reducerCtx(PRIYA), { question: 'x' })).toThrow(/too short/);
    for (let i = 0; i < 3; i++) (mod.stressTest as any)(reducerCtx(PRIYA), { scenario: `Car repair ${i}` });
    expect(() => (mod.stressTest as any)(reducerCtx(PRIYA), { scenario: 'One more' })).toThrow(/still working/);
  });
});

describe('Sentinel watch and coach threads (module)', () => {
  it('the watch posts a weekly briefing on its own, then waits for the next simulated week', () => {
    (mod.startNemotronWatch as any)({ ...reducerCtx(PRIYA), env: { ADMIN_CODE: 'x' } }, { adminCode: 'x', everySeconds: 60 });
    expect(store.rows('nemotronWatch')).toHaveLength(1);
    const tick = () => (mod.nemotronWatchTick as any)(reducerCtx(PRIYA), { arg: store.rows('nemotronWatch')[0] });
    tick();
    const ins = store.rows('aiInsight');
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ kind: 'briefing', requesterPersonId: 0n, audiencePersonId: 0n });
    runJobs(scripted([() => ({ status: 500, body: {} })]));
    tick(); // same sim day: nothing new
    expect(store.rows('aiInsight')).toHaveLength(1);
    const h = store.rows('household')[0];
    store.db.household.id.update({ ...h, simDay: h.simDay + 7 });
    tick();
    expect(store.rows('aiInsight')).toHaveLength(2);
  });

  it('coach: routes, keeps the thread, and only the owner can continue it', () => {
    (mod.askCoach as any)(reducerCtx(PRIYA), { message: 'How are we doing?', threadInsightId: 0n });
    const first = store.rows('aiInsight')[0];
    expect(JSON.parse(first.contextJson).threadId).toBe(String(first.id));
    runJobs(scripted([() => ({ status: 500, body: {} })]));
    expect(JSON.parse(store.rows('aiInsight')[0].resultJson).kind).toBe('health');
    expect(() => (mod.askCoach as any)(reducerCtx(SAM), { message: 'And next month?', threadInsightId: first.id })).toThrow(/not found/);
    (mod.askCoach as any)(reducerCtx(PRIYA), { message: 'What is coming up next month?', threadInsightId: first.id });
    const http = scripted([() => ({ status: 500, body: {} })]);
    runJobs(http);
    const second = store.rows('aiInsight')[1];
    expect(JSON.parse(second.contextJson).threadId).toBe(String(first.id));
    // The router saw the earlier turn.
    expect(JSON.stringify(http.calls[0])).toContain('How are we doing?');
    expect(JSON.parse(second.resultJson).extra.routedTo).toBe('briefing');
  });
});

describe('coach clarifying questions (module)', () => {
  it('a vague trip request comes back as questions with no draft forks', () => {
    (mod.askCoach as any)(reducerCtx(PRIYA), { message: 'Plan a trip to a couple countries in Africa and Asia', threadInsightId: 0n });
    runJobs(scripted([() => ({ status: 500, body: {} })])); // model down: rule-based questions
    const r = JSON.parse(store.rows('aiInsight')[0].resultJson);
    expect(r.kind).toBe('clarify');
    expect(r.extra.questions.length).toBeGreaterThanOrEqual(3);
    expect(store.rows('scenario')).toHaveLength(0);
  });
});

describe('agent plans become real proposals', () => {
  it('an engine-compatible agent draft is marked proposable and its member can propose it', () => {
    (mod.askTwin as any)(reducerCtx(PRIYA), { question: 'Can we afford a $3,200 Japan trip in March?' });
    runJobs(scripted([
      () => toolCall('simulate_scenario', { title: 'Japan trip in March', levers: [{ kind: 'one_time', amount: 3200, date: '2027-03-01', label: 'Japan trip' }] }),
      () => final({ title: 'Japan trip', verdict: 'yes', answer: 'Yes, comfortably.', tradeoffs: [], recommended_sim: 'sim_1' }),
    ]));
    const r = JSON.parse(store.rows('aiInsight')[0].resultJson);
    expect(r.scenarios[0].proposable).toBe(true);
    const id = BigInt(r.scenarios[0].scenarioId);
    const change = JSON.parse(store.rows('scenarioChange').find((c: any) => c.scenarioId === id).paramsJson);
    expect(change).toMatchObject({ amount: -320000, day: expect.any(Number) }); // engine contract: signed cents
    expect(() => (mod.proposeAgentPlan as any)(reducerCtx(SAM), { scenarioId: id })).toThrow(/not found/); // Priya's private plan
    (mod.proposeAgentPlan as any)(reducerCtx(PRIYA), { scenarioId: id });
    const sc = store.rows('scenario').find((x: any) => x.id === id);
    expect(sc.authorPersonId).toBe(PRIYA);
    expect(sc.status).not.toBe('draft');
  });
});

describe('approval rules', () => {
  it("a co-owner's proposal counts as their approval and waits only for the other co-owner", () => {
    (mod.askTwin as any)(reducerCtx(PRIYA), { question: 'Can we afford a $3,200 Japan trip in March?' });
    runJobs(scripted([
      () => toolCall('simulate_scenario', { title: 'Japan trip in March', levers: [{ kind: 'one_time', amount: 3200, date: '2027-03-01', label: 'Japan trip' }] }),
      () => final({ title: 'Japan trip', verdict: 'yes', answer: 'Yes, comfortably.', tradeoffs: [], recommended_sim: 'sim_1' }),
    ]));
    const id = BigInt(JSON.parse(store.rows('aiInsight')[0].resultJson).scenarios[0].scenarioId);
    (mod.proposeAgentPlan as any)(reducerCtx(PRIYA), { scenarioId: id });
    const approvals = store.rows('approval').filter((a: any) => a.scenarioId === id);
    expect(approvals.map((a: any) => [a.personId, a.decision])).toEqual([[PRIYA, 'approve']]);
    expect(store.rows('scenario').find((x: any) => x.id === id).status).toBe('proposed'); // waits for Sam
  });
});
