import { describe, expect, it } from 'vitest';
import { DEMO_PATELS, DEMO_SEED, generateHousehold } from '../generator';
import { runForecast } from '../forecast';
import { validateChange } from '../levers';
import { computeVitals } from '../vitals';
import type { ForecastInput, ForecastResult } from '../types';

function demoInput(): ForecastInput {
  const household = generateHousehold(DEMO_PATELS, DEMO_SEED);
  const income = household.obligations
    .filter(row => row.kind === 'income')
    .reduce((sum, row) => sum + row.amountCents, 0);
  return {
    startDay: 0,
    horizon: 60,
    accounts: household.accounts.map(account => ({
      id: account.id,
      kind: account.kind,
      balance: account.balanceCents,
      limit: account.limitCents,
      buffer: account.bufferCents,
      maturityDay: account.maturityDay,
      aprBps: account.aprBps,
    })),
    obligations: household.obligations.map(row => ({
      id: row.id,
      accountId: row.accountId,
      kind: row.kind,
      amount: row.amountCents,
      cadence: row.cadence,
      anchorDay: row.anchorDay,
      flexible: row.flexible,
    })),
    spend: household.spendProfiles.map(row => ({
      accountId: row.accountId,
      category: row.category,
      dailyProb: row.dailyProb,
      logMean: row.logMean,
      logSd: row.logSd,
      weekendMult: row.weekendMult,
    })),
    shocksPerMonth: 0,
    shockLogMean: 0,
    shockLogSd: 1,
    shockAccountId: 7,
    goals: household.goals.map(goal => ({
      id: goal.id,
      accountId: goal.accountId,
      target: goal.targetCents,
      targetDay: goal.targetDay,
    })),
    monthlyIncome: income,
  };
}

function risk(result: ForecastResult, accountId: number, day: number): number {
  const series = result.byAccount.get(accountId);
  const index = result.days.indexOf(day);
  return series?.pBelowBuffer[index] ?? -1;
}

describe('forecast', () => {
  const input = demoInput();

  it('matches a fork that changes nothing', () => {
    const baseline = runForecast(input, [], { paths: 40, seed: DEMO_SEED });
    const fork = runForecast(input, [], { paths: 40, seed: DEMO_SEED });
    expect(fork.days).toEqual(baseline.days);
    expect(fork.householdLiquid).toEqual(baseline.householdLiquid);
    expect([...fork.byAccount.entries()]).toEqual([...baseline.byAccount.entries()]);
  });

  it('shows a $500 expense on the selected day throughout the 60-day forecast', () => {
    const options = { paths: 40, seed: DEMO_SEED };
    const baseline = runForecast(input, [], options);
    const changed = runForecast(input, [{ kind: 'one_time', params: { accountId: 7, amount: -50_000, day: 10 } }], options);
    expect(changed.days).toHaveLength(60);
    const before = baseline.byAccount.get(7)!;
    const after = changed.byAccount.get(7)!;
    changed.days.forEach((day, index) => {
      const delta = day < 10 ? 0 : -50_000;
      expect(after.p50[index]).toBeCloseTo(before.p50[index] + delta, 3);
      expect(after.p10[index]).toBeCloseTo(before.p10[index] + delta, 3);
      expect(after.p90[index]).toBeCloseTo(before.p90[index] + delta, 3);
      expect(after.pBelowBuffer[index]).toBeGreaterThanOrEqual(before.pBelowBuffer[index]);
    });
  });

  it('puts the joint checking crunch on day 27 and Maya under her buffer on day 12', () => {
    const started = Date.now();
    const result = runForecast(input, [], { paths: 300, seed: DEMO_SEED });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(risk(result, 7, 0)).toBeLessThan(0.15);
    expect(risk(result, 7, 27)).toBeGreaterThanOrEqual(0.55);
    const maya = [10, 11, 12, 13, 14].map(day => risk(result, 13, day));
    expect(Math.max(...maya)).toBeGreaterThanOrEqual(0.5);
    console.log(`forecast 300x60 ${elapsed}ms`);
  });
});

describe('vitals bands', () => {
  it('classifies the boundary values', () => {
    const empty: ForecastResult = {
      days: [0],
      byAccount: new Map(),
      householdLiquid: { p10: [0], p50: [0], p90: [0], pBelowZero: [0] },
      goalEtaDay: new Map(),
    };
    const base = {
      forecast: empty,
      checkingIds: [],
      cardBalances: 0,
      cardLimits: 100,
      monthlyDebtPayments: 0,
      monthlyIncome: 100,
      trailingIncome: 100,
      trailingSpending: 0,
      essentialMonthly: 100,
      liquidNow: 300,
      goals: [],
    };
    const at = (patch: Partial<typeof base>) => computeVitals({ ...base, ...patch });
    expect(at({ liquidNow: 300 }).find(row => row.key === 'runway')?.band).toBe('green');
    expect(at({ liquidNow: 100 }).find(row => row.key === 'runway')?.band).toBe('yellow');
    expect(at({ liquidNow: 99 }).find(row => row.key === 'runway')?.band).toBe('red');
    expect(at({ monthlyIncome: 0, trailingIncome: 0 }).find(row => row.key === 'dti')?.why).toMatch(/Needs more data/);
  });

  it('explains each vital with its own inputs and names the at-risk account', () => {
    const forecast: ForecastResult = {
      days: [0, 1],
      byAccount: new Map([[7, { p10: [0, 0], p50: [0, 0], p90: [0, 0], pBelowBuffer: [0, 0.64] }]]),
      householdLiquid: { p10: [0, 0], p50: [0, 0], p90: [0, 0], pBelowZero: [0, 0] },
      goalEtaDay: new Map(),
    };
    const vitals = computeVitals({
      forecast,
      checkingIds: [7],
      cardBalances: 20_000,
      cardLimits: 100_000,
      monthlyDebtPayments: 30_000,
      monthlyIncome: 100_000,
      trailingIncome: 100_000,
      trailingSpending: 80_000,
      essentialMonthly: 30_000,
      liquidNow: 90_000,
      goals: [],
      accountNames: new Map([[7, 'Joint checking']]),
    });
    const why = (key: string) => vitals.find(row => row.key === key)?.why ?? '';
    expect(why('crunch_risk')).toMatch(/^Joint checking dips below its buffer .* 64% of simulated paths/);
    expect(why('runway')).toMatch(/3\.0 months/);
    expect(why('utilization')).toMatch(/20%/);
    expect(new Set(vitals.map(row => row.why)).size).toBe(vitals.length);
  });
});

describe('levers', () => {
  it('rejects an account the author cannot see', () => {
    const result = validateChange(
      { kind: 'one_time', params: { accountId: 5, amount: -1000, day: 3, label: 'trip' } },
      [1, 7],
    );
    expect(result.ok).toBe(false);
  });
});
