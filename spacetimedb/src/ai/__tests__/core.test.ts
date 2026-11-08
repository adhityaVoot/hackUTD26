import { describe, expect, it } from 'vitest';
import { dayToIso, isoToDay, occursOn } from '../dates';
import { checkNumbers, collectNumbers, sanitizeUserText, scanOutbound } from '../gateway';
import { extractJson, stripThinking } from '../model';
import { searchMemory } from '../memory';
import { buildSnapshot, overviewForModel } from '../snapshot';
import { diff, LeverError, resolveLever, simulate } from '../twin';
import { newState, executeTool, getOpportunities } from '../tools';
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
    expect(sub?.evidence.after).toBe(22.99);
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
    expect(() => resolveLever(snap.twin, { kind: 'one_time', amount: 5, date: '2026-06-01', label: 'x' })).toThrow(/Did you mean 2027-06-01/);
  });
});

describe('live-run fixes, round 2', () => {
  it('repairs a lever list string that is missing its closing bracket', () => {
    const s = newState('ripple', buildSnapshot(patelInput()), 'x');
    const broken = '[{"kind": "one_time", "amount": 100, "date": "2026-12-01", "label": "x"}';
    expect((executeTool(s, 'simulate_scenario', { title: 'a', levers: broken }) as any).sim_id).toBe('sim_1');
  });
});
