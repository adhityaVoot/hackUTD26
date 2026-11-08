import { describe, expect, it } from 'vitest';
import { dayToIso, isoToDay, occursOn } from '../dates';
import { parseMoney } from '../intent';
import { checkNumbers, collectNumbers, sanitizeUserText, scanOutbound } from '../gateway';
import { priceFromPassages } from '../lookup';
import { extractJson, stripThinking } from '../model';
import { searchMemory } from '../memory';
import { buildSnapshot, overviewForModel } from '../snapshot';
import { diff, LeverError, resolveLever, simulate } from '../twin';
import { forecastSummary, newState, executeTool, getOpportunities, vitalsView } from '../tools';
import { MAYA, patelInput, PRIYA, SAM, TODAY } from './fixture';

describe('dates', () => {
  it('round-trips ISO dates and monthly occurrences', () => {
    expect(dayToIso(isoToDay('2027-03-15')!)).toBe('2027-03-15');
    const anchor = isoToDay('2026-01-31')!;
    expect(occursOn('monthly', anchor, isoToDay('2026-02-28')!)).toBe(true); // clamps to month end
    expect(occursOn('biweekly', isoToDay('2026-10-30')!, isoToDay('2026-11-13')!)).toBe(true);
  });
});

describe('snapshot privacy', () => {
  it("excludes private accounts, honors signal, ignores expired grants", () => {
    const snap = buildSnapshot(patelInput(PRIYA));
    const kinds = snap.twin.accounts.map(a => `${a.kind}:${a.visibility}`);
    // Maya's checking (expired grant) is excluded entirely.
    expect(snap.twin.accounts.length).toBe(6);
    expect(kinds).toContain('checking:signal'); // Sam's business
    expect(kinds).toContain('auto_loan:summary');
    // Maya's tuition sits on her private account: gone.
    expect(snap.twin.obligations.some(o => o.label.includes('Maya'))).toBe(false);
  });

  it('never puts names, nicknames, raw descriptions or account numbers in the model overview', () => {
    const snap = buildSnapshot(patelInput(PRIYA));
    const json = JSON.stringify(overviewForModel(snap));
    for (const bad of ['Priya', 'Sam', 'Maya', 'Design LLC', '4417889921', 'IGNORE', 'HEB', 'StreamCo']) {
      expect(json).not.toContain(bad);
    }
    // Signal account shows up only as a total.
    expect(json).toContain('"other_household_cash":6100');
    expect(snap.injectionSuspects).toBe(1);
  });

  it('drops nickname words from bill labels so the privacy scan can send the overview', () => {
    const input = patelInput();
    input.accounts = input.accounts.map(a => (a.kind === 'auto_loan' ? { ...a, nickname: 'Toyota auto loan' } : a));
    input.obligations = input.obligations.map(o => (o.kind === 'auto_loan' ? { ...o, label: 'Toyota auto loan payment' } : o));
    const snap = buildSnapshot(input);
    const json = JSON.stringify(overviewForModel(snap));
    expect(json).not.toContain('Toyota');
    expect(scanOutbound(json, snap.map.names, snap.map.nicknameWords).ok).toBe(true);
  });

  it('prints which nickname word blocks a Patel-shaped payload', () => {
    const c = (d: number) => BigInt(Math.round(d * 100));
    const input = patelInput();
    input.persons = [
      { id: PRIYA, displayName: 'Priya', role: 'coowner' },
      { id: SAM, displayName: 'Sam', role: 'coowner' },
      { id: MAYA, displayName: 'Maya', role: 'member' },
    ];
    input.accounts = [
      { id: 1n, ownerPersonId: PRIYA, isJoint: false, kind: 'checking', nickname: 'Priya checking', balanceCents: c(4200), limitCents: 0n, aprBps: 0, bufferCents: c(200), maturityDay: -1 },
      { id: 4n, ownerPersonId: SAM, isJoint: false, kind: 'checking', nickname: 'Sam checking', balanceCents: c(3100), limitCents: 0n, aprBps: 0, bufferCents: c(200), maturityDay: -1 },
      { id: 5n, ownerPersonId: SAM, isJoint: false, kind: 'checking', nickname: 'Side business', balanceCents: c(6400), limitCents: 0n, aprBps: 0, bufferCents: c(100), maturityDay: -1 },
      { id: 3n, ownerPersonId: PRIYA, isJoint: false, kind: 'ira', nickname: 'Priya IRA', balanceCents: c(24000), limitCents: 0n, aprBps: 0, bufferCents: 0n, maturityDay: -1 },
      { id: 6n, ownerPersonId: SAM, isJoint: false, kind: 'ira', nickname: 'Sam IRA', balanceCents: c(11000), limitCents: 0n, aprBps: 0, bufferCents: 0n, maturityDay: -1 },
      { id: 7n, ownerPersonId: 0n, isJoint: true, kind: 'checking', nickname: 'Joint checking', balanceCents: c(3100), limitCents: 0n, aprBps: 0, bufferCents: c(200), maturityDay: -1 },
      { id: 8n, ownerPersonId: 0n, isJoint: true, kind: 'savings', nickname: 'Joint savings', balanceCents: c(8000), limitCents: 0n, aprBps: 0, bufferCents: 0n, maturityDay: -1 },
      { id: 9n, ownerPersonId: 0n, isJoint: true, kind: 'cd', nickname: '12-month CD', balanceCents: c(5000), limitCents: 0n, aprBps: 450, bufferCents: 0n, maturityDay: 200 },
      { id: 10n, ownerPersonId: 0n, isJoint: true, kind: 'mortgage', nickname: 'Home mortgage', balanceCents: c(280000), limitCents: 0n, aprBps: 625, bufferCents: 0n, maturityDay: -1 },
      { id: 11n, ownerPersonId: 0n, isJoint: true, kind: 'auto_loan', nickname: 'Toyota auto loan', balanceCents: c(14500), limitCents: 0n, aprBps: 499, bufferCents: 0n, maturityDay: -1 },
      { id: 12n, ownerPersonId: 0n, isJoint: true, kind: 'credit_card', nickname: 'Joint card', balanceCents: c(1200), limitCents: c(8000), aprBps: 1999, bufferCents: 0n, maturityDay: -1 },
      { id: 13n, ownerPersonId: MAYA, isJoint: false, kind: 'checking', nickname: 'Student checking', balanceCents: c(1200), limitCents: 0n, aprBps: 0, bufferCents: c(250), maturityDay: -1 },
    ];
    input.grants = [{ accountId: 5n, granteePersonId: 0n, level: 'signal', status: 'active', expiresAtMicros: 9_000_000_000_000_000n }];
    input.obligations = [
      { id: 1n, accountId: 1n, kind: 'income', label: 'Priya salary', amountCents: c(2800), cadence: 'semimonthly', anchorDay: 13, flexible: false, active: true },
      { id: 2n, accountId: 4n, kind: 'income', label: 'Sam salary', amountCents: c(2400), cadence: 'biweekly', anchorDay: 12, flexible: false, active: true },
      { id: 3n, accountId: 7n, kind: 'mortgage', label: 'PNC mortgage payment', amountCents: c(1850), cadence: 'monthly', anchorDay: 27, flexible: false, active: true },
      { id: 4n, accountId: 7n, kind: 'auto_loan', label: 'Toyota auto loan payment', amountCents: c(485), cadence: 'monthly', anchorDay: 27, flexible: false, active: true },
      { id: 5n, accountId: 7n, kind: 'card_payment', label: 'Joint card payment', amountCents: c(620), cadence: 'monthly', anchorDay: 27, flexible: true, active: true },
      { id: 6n, accountId: 13n, kind: 'transfer', label: 'Rent split to Priya', amountCents: c(700), cadence: 'once', anchorDay: 12, flexible: false, active: true },
      { id: 7n, accountId: 13n, kind: 'tuition', label: 'UT Dallas textbooks', amountCents: c(350), cadence: 'once', anchorDay: 12, flexible: false, active: true },
      { id: 8n, accountId: 8n, kind: 'transfer', label: 'Monthly house-fund transfer', amountCents: c(400), cadence: 'monthly', anchorDay: 5, flexible: false, active: true },
    ];
    const snap = buildSnapshot(input);
    const state = newState('twin', snap, 'Buy a Koenigsegg Jesko for 2 million dollars');
    const payload = JSON.stringify({ overview: overviewForModel(snap), forecast: forecastSummary(state), vitals: vitalsView(state.baseline), q: state.question });
    const hits = snap.map.nicknameWords.filter(w => new RegExp(`\\b${w}\\b`).test(payload));
    expect(scanOutbound(payload, snap.map.names, snap.map.nicknameWords)).toEqual({ ok: true, reason: '' });
    expect(hits).toEqual([]);
  });

  it('reads 2 million dollars as two million', () => {
    expect(parseMoney('Buy a Koenigsegg Jesko for 2 million dollars')).toBe(2_000_000);
    expect(parseMoney('a $3.4 million car')).toBe(3_400_000);
  });

  it('reads a price from a retrieved passage and ignores a bare guess', () => {
    expect(priceFromPassages([{ text: 'The Jesko has a price of $3 million.' }])).toBe(3_000_000);
    expect(priceFromPassages([{ text: 'No figure is listed.' }])).toBeNull();
  });

  it('household mode (negotiation) sees joint and household-shared data only', () => {
    const snap = buildSnapshot(patelInput(0n));
    expect(snap.twin.accounts.some(a => a.kind === 'credit_card')).toBe(false); // Priya's card is personal
    expect(snap.twin.members.every(m => !m.isRequester)).toBe(true);
  });
});

describe('twin projection', () => {
  const snap = buildSnapshot(patelInput());
  const base = simulate(snap.twin);

  it('produces a 60-day forecast and seven vitals', () => {
    expect(base.points).toHaveLength(60);
    expect(base.vitals.map(v => v.key)).toEqual(['runway', 'crunch_risk', 'dti', 'utilization', 'savings_rate', 'goal_track', 'score']);
    expect(base.monthlyIncome).toBeGreaterThan(10000);
    for (const p of base.points) expect(p.p10).toBeLessThanOrEqual(p.p90);
  });

  it('a one-time purchase delays goals by cost / daily surplus', () => {
    const l = resolveLever(snap.twin, { kind: 'one_time', amount: 1500, date: '2026-11-09', label: 'Laptop' });
    const after = simulate(snap.twin, [l]);
    const d = diff(base, after);
    const shift = d.goals.find(g => g.name === 'Japan trip')!.shiftDays;
    expect(shift).toBeGreaterThan(0);
    expect(d.minBalanceAfter).toBeLessThan(d.minBalanceBefore);
  });

  it('income loss raises crunch risk and is computed from hidden income without revealing it', () => {
    const l = resolveLever(snap.twin, { kind: 'income_change', member: 'B', percent: -100, start_date: '2026-11-10', end_date: '2027-01-10', label: 'Job loss' });
    const after = simulate(snap.twin, [l]);
    // Two missed $4,200 paychecks (Nov 15, Dec 15) inside the 60-day window.
    expect(base.points[59].p50 - after.points[59].p50).toBeCloseTo(8400, -1);
    expect(diff(base, after).minBalance12mAfter).toBeLessThan(base.minBalance12m);
  });

  it('rejects levers on accounts the requester cannot see, with a fixable reason', () => {
    const sig = snap.twin.accounts.find(a => a.visibility === 'signal')!;
    const joint = snap.twin.accounts.find(a => a.kind === 'checking' && a.owner === 'joint')!;
    expect(() => resolveLever(snap.twin, { kind: 'transfer', from: sig.token, to: joint.token, amount: 100, date: '2026-11-20' })).toThrow(LeverError);
    expect(() => resolveLever(snap.twin, { kind: 'one_time', amount: 99999999, date: '2026-11-20', label: 'x' })).toThrow(/limit/);
    expect(() => resolveLever(snap.twin, { kind: 'one_time', amount: 10, date: 'next tuesday', label: 'x' })).toThrow(/not a date/);
  });
});

describe('gateway', () => {
  it('sanitizes names and identifiers in user text', () => {
    const map = new Map([['sam', 'B'], ['priya', 'A']]);
    expect(sanitizeUserText("What if Sam's job ends? email sam@x.com acct 123456789012", map)).toBe("What if member B's job ends? email [email] acct [number]");
  });

  it('blocks outbound payloads with names or account numbers', () => {
    expect(scanOutbound('{"a":"member B"}', ['Sam']).ok).toBe(true);
    expect(scanOutbound('{"a":"Sam"}', ['Sam']).ok).toBe(false);
    expect(scanOutbound('{"a":"4417889921"}', []).ok).toBe(false);
  });

  it('only accepts numbers present in engine output', () => {
    const allowed = collectNumbers({ min: 1234.56, risk: 0.643, date: 'Nov 28, 2026' });
    expect(checkNumbers('Cash dips to $1,235 on Nov 28 with 64% risk.', allowed).ok).toBe(true);
    expect(checkNumbers('Cash dips to $900.', allowed)).toEqual({ ok: false, unsupported: [900] });
    expect(checkNumbers('Over the next 3 months in 2027.', allowed).ok).toBe(true);
  });
});

describe('model helpers', () => {
  it('strips reasoning and extracts JSON from fenced replies', () => {
    expect(stripThinking('<think>hmm</think> hi')).toBe('hi');
    expect(extractJson('Sure!\n```json\n{"a": {"b": "}"}}\n```')).toEqual({ a: { b: '}' } });
  });
});

describe('memory retrieval', () => {
  it('finds "last November" car decision', () => {
    const rows = [
      { id: 1n, day: isoToDay('2025-11-12')!, outcome: 'declined', title: 'Buy a second car', reasoning: 'DTI would pass 40%', tags: 'car auto', amountCents: 0n, scenarioId: 0n },
      { id: 2n, day: isoToDay('2026-05-01')!, outcome: 'merged', title: 'House fund', reasoning: 'Top goal', tags: 'house', amountCents: 0n, scenarioId: 0n },
    ];
    const hits = searchMemory(rows, 'Why did we decide against buying a car last November?', TODAY, new Map());
    expect(hits[0].title).toBe('Buy a second car');
  });
});

describe('tools and opportunities', () => {
  it('detects the subscription increase and prices it', () => {
    const state = newState('opportunity', buildSnapshot(patelInput()), 'scan');
    const opps = getOpportunities(state);
    const sub = opps.find(o => o.type === 'subscription_increase');
    expect(sub?.evidence.new_price).toBe(22.99);
    expect(opps.some(o => o.type === 'high_apr_payoff')).toBe(true);
  });

  it('refuses tools that are not enabled for the feature', () => {
    const state = newState('memory', buildSnapshot(patelInput()), 'q');
    expect(executeTool(state, 'simulate_scenario', { title: 'x', levers: [] })).toEqual({ error: 'tool simulate_scenario is not available here' });
  });

  it("Sam's view has Sam's business account fully visible but not Priya's card", () => {
    const snap = buildSnapshot(patelInput(SAM));
    expect(snap.twin.accounts.some(a => a.kind === 'credit_card')).toBe(false);
    expect(snap.twin.accounts.find(a => a.owner === 'A' && a.kind === 'checking')?.visibility).toBe('full');
    expect(MAYA).toBe(3n);
  });
});

describe('thinking control', () => {
  it('uses chat_template_kwargs for Nemotron 3.x and /no_think for Llama-based Nemotron', async () => {
    const { chat } = await import('../model');
    const sent: any[] = [];
    const http = { fetch: (_u: string, i: any) => (sent.push(JSON.parse(i.body)), { status: 200, text: () => '{"choices":[{"message":{"content":"ok"}}]}' }) };
    const msgs = [{ role: 'system' as const, content: 'sys' }];
    chat(http, { baseUrl: 'x', apiKey: 'k', model: 'nvidia/nemotron-3.5-lightning-30b-a3b', noThink: true }, msgs);
    chat(http, { baseUrl: 'x', apiKey: 'k', model: 'nvidia/nemotron-3.5-lightning-30b-a3b', noThink: false }, msgs);
    chat(http, { baseUrl: 'x', apiKey: 'k', model: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', noThink: true }, msgs);
    expect(sent[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent[0].messages[0].content).toBe('sys');
    expect(sent[1]).toMatchObject({ chat_template_kwargs: { enable_thinking: true }, reasoning_budget: 4096, max_tokens: 8192 });
    expect(sent[2].chat_template_kwargs).toBeUndefined();
    expect(sent[2].messages[0].content).toBe('/no_think\nsys');
  });
});

describe('number check strictness', () => {
  it('applies the percent and thousands allowances only when the text says % or k', () => {
    const allowed = collectNumbers({ day: 'Nov 21', risk: 0.64, cost: 3200 });
    expect(checkNumbers('Saves $2,100 a month.', allowed).ok).toBe(false);
    expect(checkNumbers('Risk is 64%.', allowed).ok).toBe(true);
    expect(checkNumbers('About 3.2k.', allowed).ok).toBe(true);
    expect(checkNumbers('About 3.2 of them.', allowed).ok).toBe(false);
  });
});

describe('live-run fixes', () => {
  const snap = buildSnapshot(patelInput());
  it('accepts levers sent as a JSON string or under a misspelled key', () => {
    const s = newState('ripple', snap, 'x');
    const lever = { kind: 'one_time', amount: 100, date: '2026-12-01', label: 'x' };
    expect((executeTool(s, 'simulate_scenario', { title: 'a', levers: JSON.stringify(lever) }) as any).sim_id).toBe('sim_1');
    expect((executeTool(s, 'simulate_scenario', { title: 'b', leavers: [lever] }) as any).sim_id).toBe('sim_2');
  });
  it('defaults dates for paydowns, refuses skipping debt payments, and hints at the right lever', () => {
    const card = snap.twin.accounts.find(a => a.kind === 'credit_card')!;
    expect(resolveLever(snap.twin, { kind: 'extra_payment', loan: card.token, amount: 500 } as any).day).toBe(TODAY + 1);
    const visa = snap.twin.obligations.find(o => o.kind === 'card_payment')!;
    expect(() => resolveLever(snap.twin, { kind: 'pause_obligation', obligation: visa.token, start_date: '2026-12-01' })).toThrow(/can't be skipped/);
    const joint = snap.twin.accounts.find(a => a.kind === 'checking')!;
    expect(() => resolveLever(snap.twin, { kind: 'transfer', from: joint.token, to: 'goal_2', amount: 5, date: '2026-12-01' })).toThrow(/funded from monthly surplus/);
    // "June" written as last June rolls forward to next June; yesterday snaps to tomorrow.
    expect(dayToIso(resolveLever(snap.twin, { kind: 'one_time', amount: 5, date: '2026-06-01', label: 'x' }).day)).toBe('2027-06-01');
    expect(resolveLever(snap.twin, { kind: 'one_time', amount: 5, date: '2026-11-06', label: 'x' }).day).toBe(TODAY + 1);
    expect(resolveLever(snap.twin, { kind: 'recurring_change', category: 'dining', monthly_delta: -100, label: 'x' } as any).day).toBe(TODAY + 1);
  });
});

describe('live-run fixes, round 2', () => {
  it('repairs a lever list string that is missing its closing bracket', () => {
    const s = newState('ripple', buildSnapshot(patelInput()), 'x');
    const broken = '[{"kind": "one_time", "amount": 100, "date": "2026-12-01", "label": "x"}';
    expect((executeTool(s, 'simulate_scenario', { title: 'a', levers: broken }) as any).sim_id).toBe('sim_1');
  });
});

describe('live-run fixes, round 3', () => {
  it('salvages the valid levers from a malformed list string and exposes one-time totals', () => {
    const s = newState('life_event', buildSnapshot(patelInput()), 'x');
    const broken = '[{"kind": "one_time", "amount": 100, "date": "2027-06-01", "label": "a"}, {"kind": "one_time", "amount": 50, "date": "2027-06-01", "label": "b"}, {"kind": "one_time", "amou';
    const out = executeTool(s, 'simulate_scenario', { title: 'w', levers: broken }) as any;
    expect(out.one_time_costs_total).toBe(150);
  });
  it('suggests next year when an end date lands before the start', () => {
    const snap = buildSnapshot(patelInput());
    // "Through May" written as last May rolls to next May.
    expect(dayToIso(resolveLever(snap.twin, { kind: 'recurring_change', category: 'other', monthly_delta: 350, start_date: '2026-11-08', end_date: '2026-05-31', label: 'x' }).endDay)).toBe('2027-05-31');
  });
});
