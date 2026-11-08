// Drives the full agent loop with a scripted fake Nemotron endpoint.
import { describe, expect, it } from 'vitest';
import { runAgent } from '../agent';
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
