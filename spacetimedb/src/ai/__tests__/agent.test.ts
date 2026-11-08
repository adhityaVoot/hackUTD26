// Drives the full agent loop with a scripted fake Nemotron endpoint.
import { describe, expect, it } from 'vitest';
import { runAgent } from '../agent';
import { sanitizeUserText, scanOutbound } from '../gateway';
import type { ChatMessage, HttpLike, ModelConfig } from '../model';
import { buildSnapshot } from '../snapshot';
import { executeTool, newState } from '../tools';
import type { FeatureKind } from '../types';
import { isoToDay } from '../dates';
import { patelInput } from './fixture';

const cfg: ModelConfig = { baseUrl: 'https://fake.nvidia/v1', apiKey: 'k', model: 'nvidia/fake-nemotron', noThink: true };

type Reply = (msgs: ChatMessage[], body: any) => { status?: number; body: any };

function fakeHttp(replies: Reply[]): HttpLike & { sent: any[] } {
  const sent: any[] = [];
  let i = 0;
  return {
    sent,
    fetch(_url, init) {
      const body = JSON.parse(init.body);
      sent.push(body);
      const r = replies[Math.min(i++, replies.length - 1)](body.messages, body);
      return { status: r.status ?? 200, text: () => JSON.stringify(r.body) };
    },
  };
}

const toolCall = (name: string, args: unknown) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `c${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});
const final = (obj: unknown) => ({ choices: [{ message: { role: 'assistant', content: `<think>reasoning</think>\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`` } }] });
const lastTool = (msgs: ChatMessage[]) => JSON.parse([...msgs].reverse().find(m => m.role === 'tool')!.content!);

const state = (feature: FeatureKind, q: string, ctx: Record<string, unknown> = {}) => newState(feature, buildSnapshot(patelInput()), q, [], ctx);

describe('agent loop', () => {
  it('ripple: plans, simulates, and returns a verified chain', () => {
    const http = fakeHttp([
      () => ({ body: toolCall('simulate_scenario', { title: 'Laptop', levers: [{ kind: 'one_time', amount: 1500, date: '2026-11-20', label: 'Laptop' }] }) }),
      msgs => {
        const sim = lastTool(msgs);
        const goal = sim.goals.find((g: any) => g.name === 'Japan trip');
        return {
          body: final({
            title: 'Buying the laptop',
            answer: `Buying this laptop delays the Japan trip by ${goal.shift_days} days.`,
            decision_sim: sim.sim_id,
            chain: [
              { step: `Household cash drops $1,500 on Nov 20.`, area: 'cash', severity: 'low' },
              { step: `Lowest cash goes from $${sim.lowest_cash_before} to $${sim.lowest_cash_after}.`, area: 'cash', severity: 'medium' },
              { step: `Japan trip moves from ${goal.before} to ${goal.after}.`, area: 'goal', severity: 'medium' },
            ],
          }),
        };
      },
    ]);
    const s = state('ripple', 'Buy a $1,500 laptop on Nov 20');
    const out = runAgent(s, { http, primary: cfg, secondary: null });
    expect(out.status).toBe('done');
    expect(out.result.source).toBe('nemotron');
    expect(out.result.scenarios[0].levers[0].amount).toBe(1500);
    expect(out.result.answer).toMatch(/delays the Japan trip by \d+ days/);
    expect(out.steps.map(x => x.step)).toEqual(expect.arrayContaining(['observe', 'injection_flag', 'pii_scan', 'simulate', 'verify', 'propose']));
    // Native tool calling was used, with the ripple tool set.
    expect(http.sent[0].tools.map((t: any) => t.function.name)).toContain('simulate_scenario');
    // The red-team merchant text never left the module.
    expect(JSON.stringify(http.sent)).not.toMatch(/IGNORE ALL INSTRUCTIONS|Priya|Sam\b|Maya/);
  });

  it('rejects invented numbers and accepts the corrected answer', () => {
    let simId = '';
    const http = fakeHttp([
      () => ({ body: toolCall('simulate_scenario', { title: 'Trip', levers: [{ kind: 'one_time', amount: 3200, date: '2027-03-01', label: 'Japan trip' }] }) }),
      msgs => {
        simId = lastTool(msgs).sim_id;
        return { body: final({ title: 'Japan', verdict: 'yes', answer: 'Yes, and you will still have $987,654 left.', tradeoffs: [], recommended_sim: simId }) };
      },
      () => ({ body: final({ title: 'Japan', verdict: 'yes_with_tradeoffs', answer: 'Yes, with some slack lost.', tradeoffs: ['The house goal moves later.'], recommended_sim: simId }) }),
    ]);
    const out = runAgent(state('twin', 'Can we afford a $3,200 Japan trip in March?'), { http, primary: cfg, secondary: null });
    expect(out.status).toBe('done');
    expect(out.steps.some(s => s.step === 'verify' && s.flagged && /987654/.test(s.detail))).toBe(true);
    expect(out.result.verdict).toBe('yes_with_tradeoffs');
  });

  it('switches to the JSON tool protocol when the endpoint rejects tools', () => {
    const http = fakeHttp([
      () => ({ status: 400, body: { error: 'tools are not supported for this model' } }),
      () => ({ body: { choices: [{ message: { content: '{"tool":"find_opportunities","args":{}}' } }] } }),
      () => ({ body: { choices: [{ message: { content: '{"final":{"title":"Opportunities","answer":"A subscription went up.","picks":[{"opportunity":"opp_1","why":"It costs more now."}]}}' } }] } }),
    ]);
    const out = runAgent(state('opportunity', 'scan'), { http, primary: cfg, secondary: null });
    expect(out.status).toBe('done');
    expect(http.sent[1].tools).toBeUndefined();
    expect(http.sent[1].messages[0].content).toContain('Tool protocol');
  });

  it('falls back to the second provider, then to rules', () => {
    const down = fakeHttp([() => ({ status: 503, body: { error: 'down' } })]);
    const out = runAgent(state('stress', 'What happens if Sam loses his job for two months?'), { http: down, primary: cfg, secondary: { ...cfg, model: 'backup' } });
    expect(down.sent.map(b => b.model)).toEqual(['nvidia/fake-nemotron', 'backup']);
    expect(out.status).toBe('fallback');
    expect(out.result.source).toBe('fallback');
    expect(out.result.answer.length).toBeGreaterThan(10);
  });

  it('sanitizes negotiation positions before sending', () => {
    const http = fakeHttp([() => ({ status: 500, body: {} })]);
    runAgent(state('negotiation', 'Spring plans', { positions: [{ member: 'A', want: 'Help Maya with $350 rent', priority: 4 }, { member: 'B', want: 'Japan trip $3,200 in March', priority: 3 }] }), { http, primary: cfg, secondary: null });
    expect(http.sent).toHaveLength(1); // the scan passed and the call went out
    expect(JSON.stringify(http.sent[0])).toContain('member C');
    expect(JSON.stringify(http.sent[0])).not.toContain('Maya');
  });
});

describe('deterministic fallbacks (kill switch on)', () => {
  const cases: [FeatureKind, string, Record<string, unknown>?][] = [
    ['twin', 'Can we afford to move to a bigger apartment in June for $600 more per month?'],
    ['ripple', 'Buy a $1,500 laptop next week'],
    ['stress', 'What happens if Sam loses his job for two months?'],
    ['life_event', "We're planning to get married next year. What should we prepare for?"],
    ['memory', 'Why did we decide against buying a car last November?'],
    ['opportunity', 'scan'],
    ['negotiation', 'Spring plans', { positions: [{ member: 'A', want: '$350 a month for Maya', priority: 4 }, { member: 'B', want: 'Japan trip $3,200 in March', priority: 3 }] }],
  ];
  for (const [feature, q, ctx] of cases) {
    it(`${feature} answers from the engine without a model`, () => {
      const s = newState(feature, buildSnapshot(patelInput()), q, feature === 'memory'
        ? [{ id: 1n, day: isoToDay('2025-11-12')!, outcome: 'declined', title: 'Buy a second car', reasoning: 'Car payment would push debt-to-income above 40%.', tags: 'car', amountCents: 0n, scenarioId: 0n }]
        : [], ctx ?? {});
      const out = runAgent(s, { http: fakeHttp([]), primary: null, secondary: null });
      expect(out.status).toBe('fallback');
      expect(out.result.answer.length).toBeGreaterThan(10);
      if (!['memory', 'opportunity'].includes(feature)) expect(out.result.scenarios.length).toBeGreaterThan(0);
      if (feature === 'stress') expect(out.result.scenarios.length).toBeGreaterThanOrEqual(3);
      if (feature === 'memory') expect(out.result.answer).toContain('Buy a second car');
    });
  }
});

describe('slots', () => {
  it('fills engine values into model text and rejects unknown slots', () => {
    const http = fakeHttp([
      () => ({ body: toolCall('simulate_scenario', { title: 'Laptop', levers: [{ kind: 'one_time', amount: 1500, date: '2026-11-09', label: 'Laptop' }] }) }),
      () => ({ body: final({ title: 'Laptop', answer: 'Lowest cash becomes {sim_1.lowest_cash_after}; the trip moves {sim_1.goal_2.shift_days} days.', decision_sim: 'sim_1', chain: [{ step: 'Cash drops {sim_1.nonsense}.', area: 'cash' }, { step: 'Trip moves.', area: 'goal' }] }) }),
      () => ({ body: final({ title: 'Laptop', answer: 'Lowest cash becomes {sim_1.lowest_cash_after}; the trip moves {sim_1.goal_2.shift_days} days.', decision_sim: 'sim_1', chain: [{ step: 'Cash dips to {sim_1.lowest_cash_after} on {sim_1.lowest_cash_date_after}.', area: 'cash' }, { step: 'Trip moves.', area: 'goal' }] }) }),
    ]);
    const out = runAgent(state('ripple', 'laptop'), { http, primary: cfg, secondary: null });
    expect(out.status).toBe('done');
    expect(out.steps.some(s => s.step === 'verify' && /unknown slots/.test(s.detail))).toBe(true);
    expect(out.result.answer).toMatch(/^Lowest cash becomes \$[\d,]+; the trip moves \d+ days\.$/);
    expect(out.result.sections[0].items[0]).toMatch(/Cash dips to \$[\d,]+ on [A-Z][a-z]{2} \d+, 2026\./);
  });
});

describe('verification, round 2', () => {
  it('rejects leftover placeholders, pasted field names, and mitigations without a fork', () => {
    const http = fakeHttp([
      () => ({ body: toolCall('simulate_scenario', { title: 'Job loss', levers: [{ kind: 'income_change', member: 'B', percent: -100, start_date: '2026-11-10', end_date: '2027-01-10', label: 'Job loss' }] }) }),
      () => ({ body: final({ title: 'Job loss', answer: 'Set aside {required_monthly_savings.per_month}; cash falls from household_cash_now.', scenarios: [{ sim_id: 'sim_1', name: 'Job loss', severity: 'expected' }], weakest_point: 'Cash dips in January.', mitigations: [{ title: 'Pause Visa', why: 'Saves cash.' }] }) }),
      () => ({ body: final({ title: 'Job loss', answer: 'Cash bottoms at {sim_1.lowest_cash_12_months_after}.', scenarios: [{ sim_id: 'sim_1', name: 'Job loss', severity: 'expected' }], weakest_point: 'Cash dips in January.', mitigations: [] }) }),
    ]);
    const out = runAgent(state('stress', 'job loss'), { http, primary: cfg, secondary: null });
    const failed = out.steps.find(s => s.step === 'verify' && s.flagged)!.detail;
    expect(failed).toMatch(/unsupported placeholder/);
    expect(failed).toMatch(/field name "household_cash_now"/);
    expect(failed).toMatch(/mitigations\[0\]\.sim_id/);
    expect(out.status).toBe('done');
    expect(out.result.answer).toMatch(/^Cash bottoms at \$[\d,]+\.$/);
  });
});

import { routeCoach } from '../agent';
import { checkBank } from '../tools';

describe('new Nemotron features', () => {
  it('coach: Nemotron routes a follow-up using the conversation, and rules take over when the model is off', () => {
    const http = fakeHttp([() => ({ body: final({ workflow: 'twin', request: 'Can we afford the Japan trip if we wait until July 2027?' }) })]);
    const r = routeCoach('What if we waited until July?', [{ question: 'Can we afford a $3,200 Japan trip in March?', answer: 'Yes, with trade-offs.' }], new Map([['sam', 'B']]), { http, primary: cfg, secondary: null });
    expect(r.feature).toBe('twin');
    expect(r.request).toContain('July 2027');
    expect(http.sent[0].messages[1].content).toContain('Japan trip in March');
    const off = routeCoach('What happens if Sam loses his job?', [], new Map([['sam', 'B']]), { http, primary: null, secondary: null });
    expect(off.feature).toBe('stress');
    expect(off.request).toContain('member B');
  });

  it('health check: verifies indicator names and a simulated best move', () => {
    const http = fakeHttp([
      () => ({ body: toolCall('simulate_scenario', { title: 'Pay down the card', levers: [{ kind: 'extra_payment', loan: buildSnapshot(patelInput()).twin.accounts.find(a => a.kind === 'credit_card')!.token, amount: 1000, date: '2026-11-20' }] }) }),
      () => ({ body: final({ title: 'Health', answer: 'Mostly healthy; card use is the weak spot.', indicators: [{ vital: 'runway', meaning: 'Months of bills covered.' }, { vital: 'utilization', meaning: 'Card limits in use.' }, { vital: 'dti', meaning: 'Income going to debt.' }], best_move_sim: 'sim_1', best_move_why: 'It lowers card use.' }) }),
    ]);
    const out = runAgent(state('health', 'How are we doing?'), { http, primary: cfg, secondary: null });
    expect(out.status).toBe('done');
    expect(out.result.highlights).toHaveLength(7);
    expect(out.result.sections[0].items[0]).toMatch(/^Cash runway \(3\.\d months\)/);
  });

  it('sentinel briefing must cite a fix that lowers risk; the fallback finds one itself', () => {
    const s = state('briefing', 'Overdraft risk is high', { mode: 'sentinel' });
    const http = fakeHttp([() => ({ body: final({ title: 'Crunch', answer: 'Risk is high.', upcoming: [], watch_out: [] }) })]);
    const out = runAgent(s, { http, primary: cfg, secondary: null, maxRetries: 0 });
    expect(out.steps.some(x => x.step === 'verify' && /fix_sim must be a sim_id/.test(x.detail))).toBe(true);
    expect(out.status).toBe('fallback');
  });

  it('rejects advice to pause debt payments', () => {
    const http = fakeHttp([
      () => ({ body: toolCall('simulate_scenario', { title: 'Job loss', levers: [{ kind: 'income_change', member: 'B', percent: -100, start_date: '2026-11-10', end_date: '2027-01-10', label: 'Job loss' }] }) }),
      () => ({ body: final({ title: 'Job loss', answer: 'Pause the Visa autopay for two months.', scenarios: [{ sim_id: 'sim_1', name: 'Job loss', severity: 'expected' }], weakest_point: 'January.', mitigations: [] }) }),
    ]);
    const out = runAgent(state('stress', 'job loss'), { http, primary: cfg, secondary: null, maxRetries: 0 });
    expect(out.steps.some(x => x.step === 'verify' && /never paused/.test(x.detail))).toBe(true);
  });

  it('check_bank cross-checks live balances and finds bills missing from the forecast', () => {
    const s = state('twin', 'x');
    expect(checkBank(s)).toMatchObject({ available: false });
    const joint = s.snap.twin.accounts.find(a => a.kind === 'checking' && a.owner === 'joint')!.token;
    s.bank = {
      account: tok => (tok === joint ? { balance: 4100 } : { error: 'not linked to the bank' }),
      bills: tok => (tok === joint ? [{ amount: 2350, date: '2026-12-01', status: 'recurring' }, { amount: 99, date: '2026-11-20', status: 'pending' }] : { error: 'x' }),
    };
    const r = checkBank(s) as any;
    expect(r.accounts.find((a: any) => a.account === joint)).toMatchObject({ ledger_balance: 4200, bank_balance: 4100, difference: -100, in_sync: false });
    expect(r.bills_not_in_forecast).toEqual([{ account: joint, amount: 99, date: '2026-11-20', status: 'pending' }]);
  });

  it('ripple results say where cash is on the decision day and whether the low point moved', () => {
    const s = state('ripple', 'x');
    const out = executeTool(s, 'simulate_scenario', { title: 'Laptop', levers: [{ kind: 'one_time', amount: 1500, date: '2026-11-14', label: 'Laptop' }] }) as any;
    expect(out.cash_on_decision_date_before - out.cash_on_decision_date_after).toBe(1500);
    expect(out.lowest_point_moved).toBe(false);
    expect(out.cushion_above_buffer_after).toBe(out.lowest_cash_after - 800);
  });
});

describe('live-run fixes, round 4', () => {
  it('waits and retries on HTTP 429, then succeeds', () => {
    const waits: number[] = [];
    let n = 0;
    const http = { fetch: () => (n++ < 2 ? { status: 429, text: () => '{"title":"Too Many Requests"}' } : { status: 200, text: () => JSON.stringify(final({ title: 'x', answer: 'Nothing recorded.', cited: [], commitments: [], still_relevant: '' })) }) };
    const out = runAgent(state('memory', 'why?'), { http, primary: cfg, secondary: null, sleep: ms => waits.push(ms) });
    expect(waits).toEqual([2000, 5000]);
    expect(out.status).toBe('done');
  });

  it('recovers from a prose reply and reads JSON from reasoning_content', () => {
    const http = fakeHttp([
      () => ({ body: { choices: [{ message: { content: 'Here is what I found about the car.' } }] } }),
      () => ({ body: { choices: [{ message: { content: '', reasoning_content: JSON.stringify({ title: 'Car', answer: 'Nothing recorded.', cited: [], commitments: [], still_relevant: '' }) } }] } }),
    ]);
    const out = runAgent(state('memory', 'why?'), { http, primary: cfg, secondary: null });
    expect(out.status).toBe('done');
    expect(out.steps.some(s => s.step === 'parse' && /Here is what I found/.test(s.detail))).toBe(true);
    expect(http.sent[1].tools).toBeUndefined();
  });

  it('tells the model when a slot names a fork it never simulated', () => {
    const http = fakeHttp([() => ({ body: final({ title: 'B', answer: 'All steady.', upcoming: [], watch_out: [], fix_why: 'Saves {sim_1.monthly_surplus_after}.' }) })]);
    const out = runAgent(state('briefing', 'weekly', { mode: 'weekly' }), { http, primary: cfg, secondary: null, maxRetries: 0 });
    expect(out.steps.some(s => s.step === 'verify' && /sim_1 does not exist; call simulate_scenario first/.test(s.detail))).toBe(true);
  });

  it('get_vitals includes the band rules so thresholds are citable', () => {
    const v = executeTool(state('health', 'x'), 'get_vitals', {}) as any;
    expect(v.vitals.find((x: any) => x.vital === 'utilization').bands).toContain('30%');
  });
});

describe('live-run fixes, round 5', () => {
  it('sentinel: the engine picks the best simulated fix when the model forgets to name one', () => {
    const input = patelInput(0n);
    input.accounts = input.accounts.map(a => (a.id === 10n ? { ...a, balanceCents: 90_000n } : a.id === 11n ? { ...a, balanceCents: 20_000n } : a.id === 13n ? { ...a, balanceCents: 10_000n } : a));
    const s = newState('briefing', buildSnapshot(input), 'risk', [], { mode: 'sentinel' });
    const http = fakeHttp([
      () => ({ body: toolCall('simulate_scenario', { title: 'Trim dining', levers: [{ kind: 'recurring_change', category: 'dining', monthly_delta: -300, start_date: '2026-11-08', end_date: '2026-12-08', label: 'Trim dining' }] }) }),
      () => ({ body: final({ title: 'Crunch ahead', answer: 'Risk is high early this month.', upcoming: [], watch_out: [] }) }),
    ]);
    const out = runAgent(s, { http, primary: cfg, secondary: null });
    expect(out.status).toBe('done');
    expect(out.result.scenarios[0].title).toBe('Trim dining');
  });

  it('gives tools back when verification asks for a simulation after a forced final answer', () => {
    const http = fakeHttp([
      () => ({ body: { choices: [{ message: { content: 'Yes, you can afford it.' } }] } }), // prose -> forced final, tools off
      () => ({ body: final({ title: 'Trip', verdict: 'yes', answer: 'Yes.', tradeoffs: [], recommended_sim: 'sim_1' }) }),
      () => ({ body: toolCall('simulate_scenario', { title: 'Trip', levers: [{ kind: 'one_time', amount: 3200, date: '2027-03-01', label: 'Trip' }] }) }),
      () => ({ body: final({ title: 'Trip', verdict: 'yes', answer: 'Yes.', tradeoffs: [], recommended_sim: 'sim_1' }) }),
    ]);
    const out = runAgent(state('twin', 'Can we afford a $3,200 trip?'), { http, primary: cfg, secondary: null, maxRetries: 3 });
    expect(out.steps.some(s => s.step === 'plan' && /tools re-enabled/.test(s.detail))).toBe(true);
    expect(http.sent[2].tools).toBeDefined();
    expect(out.status).toBe('done');
  });

  it('health: the engine pre-simulates candidate moves for Nemotron to choose from', () => {
    const http = fakeHttp([() => ({ body: final({ title: 'H', answer: 'Mostly healthy.', indicators: [{ vital: 'runway', meaning: 'a' }, { vital: 'dti', meaning: 'b' }, { vital: 'utilization', meaning: 'c' }], best_move_sim: 'sim_1', best_move_why: 'Cuts interest.' }) })]);
    const out = runAgent(state('health', 'how are we doing'), { http, primary: cfg, secondary: null });
    expect(out.status).toBe('done');
    expect(JSON.parse(http.sent[0].messages[1].content).observations.candidate_moves.length).toBeGreaterThanOrEqual(2);
    expect(out.steps.some(s => s.step === 'candidates')).toBe(true);
  });
});

describe('pre-demo fixes', () => {
  it('rejects a goal shift described in the wrong direction', () => {
    const http = fakeHttp([
      () => ({ body: toolCall('simulate_scenario', { title: 'Laptop', levers: [{ kind: 'one_time', amount: 1500, date: '2026-11-14', label: 'Laptop' }] }) }),
      () => ({ body: final({ title: 'Laptop', answer: 'The Japan trip arrives 18 days sooner.', decision_sim: 'sim_1', chain: [{ step: 'Cash drops.', area: 'cash' }, { step: 'Trip moves.', area: 'goal' }] }) }),
      () => ({ body: final({ title: 'Laptop', answer: 'The Japan trip arrives 18 days later.', decision_sim: 'sim_1', chain: [{ step: 'Cash drops.', area: 'cash' }, { step: 'The trip is delayed by 18 days.', area: 'goal' }] }) }),
    ]);
    const out = runAgent(state('ripple', 'laptop'), { http, primary: cfg, secondary: null });
    expect(out.steps.some(s => s.step === 'verify' && /"18 days sooner" but the engine shows 18 days later/.test(s.detail))).toBe(true);
    expect(out.status).toBe('done');
  });

  it('a card paydown now saves interest in the forecast', () => {
    const s = state('health', 'x');
    const card = s.snap.twin.accounts.find(a => a.kind === 'credit_card')!.token;
    const out = executeTool(s, 'simulate_scenario', { title: 'Pay card', levers: [{ kind: 'extra_payment', loan: card, amount: 1200, date: '2026-11-20' }] }) as any;
    expect(out.monthly_surplus_after).toBeGreaterThan(out.monthly_surplus_before); // ~$23/month of 22.99% interest
  });
});

describe('names in real household data (NemoTrial)', () => {
  // Real data: full display names, first names in bill labels, names in account nicknames.
  const realistic = () => {
    const input = patelInput();
    input.persons = input.persons.map(p => ({ ...p, displayName: `${p.displayName} Patel`, personaKey: p.displayName.toLowerCase() }));
    input.obligations = input.obligations.map(o => (o.id === 103n ? { ...o, label: "Sam's car payment" } : o));
    return input;
  };

  it('lets the question through and never blocks on names in bill labels', () => {
    const http = fakeHttp([() => ({ status: 500, body: {} })]);
    const s = newState('twin', buildSnapshot(realistic()), 'Can Priya and Sam afford a $3,200 Japan trip in March? Ask Mrs. Patel too.');
    const out = runAgent(s, { http, primary: cfg, secondary: null });
    expect(out.steps.some(x => x.step === 'pii_scan' && x.flagged)).toBe(false);
    expect(http.sent).toHaveLength(1); // the request went out
    const sent = JSON.stringify(http.sent[0]);
    expect(sent).not.toMatch(/Priya|Sam\b|Maya|Patel/);
    expect(sent).toContain('member A');
    expect(sent).toContain('member B');
  });

  it('still blocks what cannot be redacted safely', () => {
    const http = fakeHttp([() => ({ status: 500, body: {} })]);
    const input = realistic();
    input.goals = [{ ...input.goals[0], name: 'Fund 4417889921 escrow' }];
    const s = newState('twin', buildSnapshot(input), 'Can we afford it?');
    // Goal names with account-number-shaped text are dropped by the snapshot, so this still goes out clean.
    runAgent(s, { http, primary: cfg, secondary: null });
    expect(JSON.stringify(http.sent)).not.toContain('4417889921');
  });
});

describe('big purchases (Ferrari report)', () => {
  const rich = () => {
    const input = patelInput();
    input.accounts = input.accounts.map(a => (a.id === 10n ? { ...a, balanceCents: 500_000_000n } : a)); // $5M cash
    return buildSnapshot(input);
  };
  it('a $10,000,000 purchase is not mistaken for an account number, and simulates', () => {
    const http = fakeHttp([
      () => ({ body: toolCall('simulate_scenario', { title: 'Ferrari', levers: [{ kind: 'one_time', amount: 10000000, date: '2026-12-01', label: 'Ferrari' }] }) }),
      () => ({ body: final({ title: 'Ferrari', verdict: 'no', answer: 'No. Cash would fall to {sim_1.lowest_cash_after}.', tradeoffs: [], recommended_sim: 'sim_1' }) }),
    ]);
    const out = runAgent(newState('twin', rich(), 'Can I buy a ferrari worth 10000000?'), { http, primary: cfg, secondary: null });
    expect(out.status).toBe('done');
    expect(out.result.answer).toMatch(/^No\. Cash would fall to -\$[\d,]+\.$/);
  });
  it('the rule-based answer reads the amount and says No when it is out of reach', () => {
    const out = runAgent(newState('twin', rich(), 'Can I buy a Ferrari worth 10,000,000?'), { http: fakeHttp([]), primary: null, secondary: null });
    expect(out.result.verdict).toBe('no');
    expect(out.result.answer).toMatch(/^No\. At \$10,000,000 it costs more than/);
  });
  it('still blocks real account numbers', () => {
    expect(scanOutbound('{"note":"wire it to account 12345678"}', []).ok).toBe(false);
    expect(scanOutbound('{"note":"card 4111111111111111"}', []).ok).toBe(false);
    expect(scanOutbound('{"note":"worth 10000000","amount":25000000}', []).ok).toBe(true);
    expect(sanitizeUserText('Pay from account 12345678 a $10000000 car', new Map())).toBe('Pay from account [number] a $10000000 car');
  });
});

describe('conversational coach with online prices (Rolex)', () => {
  const ddg = (snippets: string[]) =>
    `<html>${snippets.map((t, i) => `<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(`https://shop${i}.example.com/rolex`)}&amp;rut=x" class='result-link'>Rolex prices ${i}</a></td></tr><tr><td class='result-snippet'>${t}</td></tr>`).join('')}</html>`;
  const web = (url: string) => {
    if (url.includes('lite.duckduckgo.com')) return { status: 200, text: () => (url.includes('under') ? ddg(['Pre-owned Rolex Oyster Perpetual from $6,643 and Datejust models around $9,500.']) : ddg(['Rolex watches cost around $14,000 on average, from $6,643 to $35,000 for popular steel models.'])) };
    return { status: 200, text: () => '{}' }; // wikipedia: nothing useful
  };

  it('spending_budget is lowest 12-month cash minus buffer minus three months of essentials', () => {
    const s = state('twin', 'x');
    const b = executeTool(s, 'spending_budget', {}) as any;
    expect(b.comfortable_budget).toBe(Math.max(0, Math.floor((s.baseline.minBalance12m - s.baseline.buffer - 3 * s.baseline.essentialMonthly) / 100) * 100));
    expect(b.stretch_budget).toBeGreaterThanOrEqual(b.comfortable_budget);
  });

  it('looks up prices, checks the budget, suggests a cheaper fit, cites sources and asks a follow-up', () => {
    const s = state('twin', 'I wanna buy a rolex');
    const lev = (amount: number, label: string) => ({ kind: 'one_time', amount, date: '2026-11-20', label });
    const model = fakeHttp([
      () => ({ body: toolCall('lookup_information', { query: 'Rolex watch price' }) }),
      () => ({ body: toolCall('spending_budget', {}) }),
      () => ({ body: toolCall('simulate_scenario', { title: 'Rolex at typical price', levers: [lev(14000, 'Rolex')] }) }),
      () => ({ body: toolCall('lookup_information', { query: 'Rolex under $10,000' }) }),
      () => ({ body: toolCall('simulate_scenario', { title: 'Pre-owned Datejust', levers: [lev(9500, 'Pre-owned Rolex')] }) }),
      () => ({
        body: final({
          title: 'A Rolex that fits', verdict: 'yes_with_tradeoffs',
          answer: 'Rolex prices I found average about $14,000. You can comfortably spend about {budget.comfortable_budget} right now, so a pre-owned Datejust around $9,500 fits better.',
          follow_up: 'Want me to look at pre-owned models around that price?',
          recommended_sim: 'sim_1', alternative_sims: ['sim_2'],
          sources: [{ title: 'x', url: 'https://shop0.example.com/rolex' }, { title: 'made up', url: 'https://not-returned.example.com' }],
        }),
      }),
    ]);
    // One client for everything, as in production: search URLs go to the fake web, the rest to the fake model.
    const http = { fetch: (url: string, init: any) => (/duckduckgo|wikipedia/.test(url) ? web(url) : model.fetch(url, init)) };
    const out = runAgent(s, { http, primary: cfg, secondary: null });
    expect(out.status).toBe('done');
    expect(out.result.answer).toMatch(/comfortably spend about \$[\d,]+ right now/);
    expect(out.result.followUp).toBe('Want me to look at pre-owned models around that price?');
    expect(out.result.sources).toEqual([{ title: 'Rolex prices 0', url: 'https://shop0.example.com/rolex' }]); // only pages lookup returned
    expect(out.result.scenarios.map(x => x.levers[0].amount)).toEqual([14000, 9500]);
  });

  it('asks for the price instead of guessing when nothing online states one', () => {
    const model = fakeHttp([() => ({ body: final({ title: 'Which one?', verdict: 'not_yet', answer: "I couldn't find a price for that.", follow_up: 'What price range do you have in mind?' }) })]);
    const out = runAgent(state('twin', 'I want a custom yacht'), { http: model, primary: cfg, secondary: null });
    expect(out.status).toBe('done');
    expect(out.result.followUp).toBe('What price range do you have in mind?');
  });
});

describe('asks before planning when the request is vague', () => {
  it('rule-based: a vague multi-country trip gets questions, not a guessed budget', async () => {
    const { clarifyQuestions } = await import('../intent');
    const c = clarifyQuestions('Plan a trip to a couple countries in Africa and Asia', [])!;
    expect(c.questions.length).toBeGreaterThanOrEqual(3);
    expect(c.questions.join(' ')).toMatch(/Which countries/);
    expect(c.questions.join(' ')).toMatch(/economy, business or first class/);
    expect(c.questions.join(' ')).not.toMatch(/\$\d/);
  });

  it('rule-based: specific requests and single purchases go straight through', async () => {
    const { clarifyQuestions } = await import('../intent');
    expect(clarifyQuestions('Can we afford a $3,200 trip to Japan in March for 10 days, just the two of us, mid-range hotels?', [])).toBeNull();
    expect(clarifyQuestions('I wanna buy a rolex', [])).toBeNull();
    // Already asked once and answered: proceed.
    expect(clarifyQuestions('Kenya and Thailand, two weeks in July, just me, mid-range', [{ question: 'Plan a trip', answer: 'Which countries?' }, { question: 'x', answer: 'y' }])).toBeNull();
  });

  it('Nemotron router: asks warm questions; rejects questions with invented figures', () => {
    const ask = fakeHttp([() => ({ body: final({ workflow: 'life_event', request: 'Plan a multi-country trip', needs_clarification: true, message: "Love that idea! A few questions so the numbers are real:", questions: ['Which countries are you thinking of?', 'When and for how long?', 'Economy or business class, and what kind of hotels?'] }) })]);
    const r = routeCoach('Plan a trip to a couple countries in Africa and Asia', [], new Map(), { http: ask, primary: cfg, secondary: null });
    expect(r.clarify?.questions).toHaveLength(3);
    expect(r.clarify?.message).toMatch(/^Love that idea/);

    const invents = fakeHttp([() => ({ body: final({ workflow: 'life_event', request: 'x', needs_clarification: true, message: 'Sure!', questions: ['Is $8,000 your budget?', 'Is June good?'] }) })]);
    const r2 = routeCoach('Plan a trip to a couple countries in Africa and Asia', [], new Map(), { http: invents, primary: cfg, secondary: null });
    expect(r2.clarify?.questions.join(' ')).not.toMatch(/8,000/); // fell back to rule-based questions
  });

  it('when the member has answered, the router plans instead of asking again', () => {
    const go = fakeHttp([() => ({ body: final({ workflow: 'life_event', request: 'Plan a two-week trip to Kenya and Thailand in July 2027, solo, mid-range hotels, economy flights', needs_clarification: false }) })]);
    const r = routeCoach('Kenya and Thailand, two weeks in July, just me, mid-range and economy', [{ question: 'Plan a trip to a couple countries in Africa and Asia', answer: 'Which countries? When? How long?' }], new Map(), { http: go, primary: cfg, secondary: null });
    expect(r.clarify).toBeUndefined();
    expect(r.feature).toBe('life_event');
  });
});

describe('asks at most once', () => {
  it('after one round of questions it plans instead of asking again, even if the model wants to', () => {
    const reAsk = fakeHttp([() => ({ body: final({ workflow: 'life_event', request: 'Plan a trip to Kenya and Vietnam', needs_clarification: true, message: 'Great!', questions: ['Which countries and cities are you considering?', 'How long?'] }) })]);
    const history = [{ question: 'Plan a trip to a couple countries in Africa and Asia', answer: 'Happy to help! Which countries?', clarified: true }];
    const r = routeCoach('Kenya and Vietnam', history, new Map(), { http: reAsk, primary: cfg, secondary: null });
    expect(r.clarify).toBeUndefined();
    expect(r.feature).toBe('life_event');
    const rules = routeCoach('Kenya and Vietnam', history, new Map(), { http: reAsk, primary: null, secondary: null });
    expect(rules.clarify).toBeUndefined();
  });
});

describe('Reviewer agent', () => {
  const draftThen = (reviewer: unknown) => fakeHttp([
    () => ({ body: toolCall('simulate_scenario', { title: 'Trip in July', levers: [{ kind: 'one_time', amount: 3200, date: '2027-07-01', label: 'Japan trip' }] }) }),
    () => ({ body: final({ title: 'Trip', verdict: 'yes', answer: 'Moving the trip to July delays the house goal by {sim_1.goal_1.shift_days} days.', tradeoffs: [], recommended_sim: 'sim_1' }) }),
    () => ({ body: final(reviewer) }),
  ]);

  it('fixes framing errors the number check cannot see', () => {
    const http = draftThen({ verdict: 'revise', issues: ['compares July against having no trip, not against March'], answer: 'A July trip costs the same as a March one; either way the house goal moves {sim_1.goal_1.shift_days} days later than with no trip.' });
    const out = runAgent(state('twin', 'What if we did the Japan trip in July instead of March?'), { http, primary: cfg, secondary: null });
    expect(out.status).toBe('done');
    expect(out.result.review?.verdict).toBe('revised');
    expect(out.result.answer).toMatch(/^A July trip costs the same as a March one; either way the house goal moves \d+ days later than with no trip\.$/);
    expect(http.sent[2].messages[0].content).toContain('You are the Reviewer');
    expect(out.steps.some(s => s.step === 'review' && /revised/.test(s.detail))).toBe(true);
  });

  it("keeps the verified draft when the Reviewer's rewrite invents a number", () => {
    const http = draftThen({ verdict: 'revise', issues: ['x'], answer: 'It will cost you $77,777.' });
    const out = runAgent(state('twin', 'trip'), { http, primary: cfg, secondary: null });
    expect(out.result.review?.verdict).toBe('skipped');
    expect(out.result.answer).toMatch(/^Moving the trip to July delays the house goal by \d+ days\.$/);
  });

  it('approves sound answers and every result carries a 12-month baseline series for charts', () => {
    const http = draftThen({ verdict: 'approve', issues: [] });
    const out = runAgent(state('twin', 'trip'), { http, primary: cfg, secondary: null });
    expect(out.result.review?.verdict).toBe('approved');
    expect(out.result.baselineSeries!.length).toBe(53);
    expect(out.result.scenarios[0].series!.length).toBe(53);
  });
});

describe('Debate it (Advocate, Skeptic, Judge)', () => {
  it('argues both sides from the simulation, drops unsupported points, and returns a verdict', async () => {
    const { runDebate } = await import('../agent');
    const http = fakeHttp([
      () => ({ body: toolCall('simulate_scenario', { title: 'Car in March', levers: [{ kind: 'one_time', amount: 3500, date: '2027-03-01', label: 'Used car' }] }) }),
      () => ({ body: final({ title: 'Car', verdict: 'yes_with_tradeoffs', answer: 'You can, with trade-offs.', tradeoffs: [], recommended_sim: 'sim_1' }) }),
      () => ({ body: final({ points: ['Lowest cash stays at {sim_1.lowest_cash_after}, above your buffer.', 'It will make you $9,999,999 richer.'] }) }),
      () => ({ body: final({ points: ['The house goal moves {sim_1.goal_1.shift_days} days later.'] }) }),
      () => ({ body: final({ verdict: 'wait', answer: 'Waiting a few months keeps the house goal closer to on time.', follow_up: 'Want me to check a later date?' }) }),
    ]);
    const s = state('twin', 'Should we buy a $3,500 used car in March?');
    const deps = { http, primary: cfg, secondary: null, skipReview: true };
    const out = runAgent(s, deps);
    const d = runDebate(s, out.result, deps);
    expect(d.ok).toBe(true);
    expect(out.result.kind).toBe('debate');
    expect(out.result.verdict).toBe('wait');
    const debate = out.result.extra!.debate as { for: string[]; against: string[] };
    expect(debate.for).toEqual([expect.stringMatching(/^Lowest cash stays at \$[\d,]+, above your buffer\.$/)]); // invented point dropped
    expect(debate.against[0]).toMatch(/moves \d+ days later/);
    expect(s.steps.filter(x => x.step === 'debate').map(x => x.detail.split(':')[0])).toEqual(['Advocate', 'Skeptic', 'Judge']);
  });
});

describe('decisions beyond the 60-day window', () => {
  it('flags them so agents argue from the 12-month figures', () => {
    const s = state('twin', 'x');
    const soon = executeTool(s, 'simulate_scenario', { title: 'Laptop', levers: [{ kind: 'one_time', amount: 1500, date: '2026-11-14', label: 'Laptop' }] }) as any;
    const later = executeTool(s, 'simulate_scenario', { title: 'Car', levers: [{ kind: 'one_time', amount: 35000, date: '2027-03-01', label: 'Car' }] }) as any;
    expect(soon.decision_beyond_60_days).toBe(false);
    expect(later.decision_beyond_60_days).toBe(true);
    expect(later.lowest_cash_12_months_after).toBeLessThan(later.lowest_cash_12_months_before);
  });
});
