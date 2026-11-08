// Drives the full agent loop with a scripted fake Nemotron endpoint.
import { describe, expect, it } from 'vitest';
import { runAgent } from '../agent';
import type { ChatMessage, HttpLike, ModelConfig } from '../model';
import { buildSnapshot } from '../snapshot';
import { newState } from '../tools';
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
