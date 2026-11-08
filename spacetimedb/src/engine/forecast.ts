import { expandCadence, isWeekend } from './calendar';
import { applyChanges } from './levers';
import { lognormal, mulberry32, poisson, seedFor } from './rng';
import type { Change, ForecastInput, ForecastResult } from './types';

const DEBT = new Set(['credit_card', 'auto_loan', 'personal_loan', 'mortgage']);

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo] ?? 0;
  const weight = index - lo;
  return (sorted[lo] ?? 0) * (1 - weight) + (sorted[hi] ?? 0) * weight;
}

function signedObligation(kind: string, amount: number, accountKind: string): number {
  if (kind === 'one_time') return amount;
  if (kind === 'income') return Math.abs(amount);
  if (kind === 'transfer' && (accountKind === 'savings' || accountKind === 'cd' || accountKind === 'ira')) {
    return Math.abs(amount);
  }
  return -Math.abs(amount);
}

export function runForecast(
  input: ForecastInput,
  changes: Change[],
  opts: { paths: number; seed: number },
): ForecastResult {
  const planned = applyChanges(input, changes);
  const lastDay = planned.startDay + planned.horizon - 1;
  const days: number[] = [];
  for (let day = planned.startDay; day <= lastDay; day += 1) days.push(day);
  const accounts = [...planned.accounts].sort((a, b) => a.id - b.id);
  const obligations = [...planned.obligations].sort((a, b) => a.id - b.id);
  const spend = [...planned.spend].sort(
    (a, b) => a.accountId - b.accountId || a.category.localeCompare(b.category),
  );
  const due = new Map<number, number[]>();
  for (const obligation of obligations) {
    due.set(
      obligation.id,
      expandCadence(obligation.cadence as 'monthly', obligation.anchorDay, planned.startDay, lastDay),
    );
  }
  const accountIndex = new Map(accounts.map((account, index) => [account.id, index]));
  const paths = Math.max(1, opts.paths);
  const samples = accounts.map(() => days.map(() => new Array<number>(paths)));
  const liquidSamples = days.map(() => new Array<number>(paths));

  for (let path = 0; path < paths; path += 1) {
    const random = mulberry32(seedFor(opts.seed, path));
    const balances = accounts.map(account => account.balance);
    const matured = new Set<number>();
    for (let step = 0; step < days.length; step += 1) {
      const day = days[step] ?? 0;
      for (const obligation of obligations) {
        if (!due.get(obligation.id)?.includes(day)) continue;
        const index = accountIndex.get(obligation.accountId);
        if (index === undefined) continue;
        const account = accounts[index];
        if (!account) continue;
        balances[index] =
          (balances[index] ?? 0) + signedObligation(obligation.kind, obligation.amount, account.kind);
      }
      const weekend = isWeekend(day);
      for (const row of spend) {
        const index = accountIndex.get(row.accountId);
        if (index === undefined) continue;
        const probability = Math.min(1, row.dailyProb * (weekend ? row.weekendMult : 1));
        const roll = random();
        const cents = Math.max(1, Math.round(lognormal(random, row.logMean, row.logSd) * 100));
        if (roll >= probability) continue;
        const account = accounts[index];
        const sign = account && DEBT.has(account.kind) ? 1 : -1;
        balances[index] = (balances[index] ?? 0) + sign * cents;
      }
      if (planned.shocksPerMonth > 0) {
        const shocks = poisson(random, planned.shocksPerMonth / 30);
        const index = accountIndex.get(planned.shockAccountId);
        for (let n = 0; n < shocks; n += 1) {
          const cents = Math.max(1, Math.round(lognormal(random, planned.shockLogMean, planned.shockLogSd) * 100));
          if (index === undefined) continue;
          const account = accounts[index];
          const sign = account && DEBT.has(account.kind) ? 1 : -1;
          balances[index] = (balances[index] ?? 0) + sign * cents;
        }
      }
      for (const account of accounts) {
        if (account.kind !== 'cd' || account.maturityDay < 0 || day < account.maturityDay || matured.has(account.id)) {
          continue;
        }
        const from = accountIndex.get(account.id);
        const savings = accounts.find(row => row.kind === 'savings');
        const to = savings ? accountIndex.get(savings.id) : undefined;
        if (from === undefined || to === undefined) continue;
        balances[to] = (balances[to] ?? 0) + (balances[from] ?? 0);
        balances[from] = 0;
        matured.add(account.id);
      }
      let liquid = 0;
      for (let i = 0; i < accounts.length; i += 1) {
        const account = accounts[i];
        const balance = balances[i] ?? 0;
        const daySamples = samples[i]?.[step];
        if (daySamples) daySamples[path] = balance;
        if (account && (account.kind === 'checking' || account.kind === 'savings' || matured.has(account.id))) {
          liquid += account.kind === 'cd' ? 0 : balance;
        }
      }
      const row = liquidSamples[step];
      if (row) row[path] = liquid;
    }
  }

  const byAccount: ForecastResult['byAccount'] = new Map();
  accounts.forEach((account, index) => {
    const series = samples[index] ?? [];
    byAccount.set(account.id, {
      p10: series.map(day => quantile(day, 0.1)),
      p50: series.map(day => quantile(day, 0.5)),
      p90: series.map(day => quantile(day, 0.9)),
      pBelowBuffer: series.map(day => day.filter(value => value < account.buffer).length / paths),
    });
  });
  const goalEtaDay = new Map<number, number | null>();
  for (const goal of planned.goals) {
    const path = byAccount.get(goal.accountId)?.p50 ?? [];
    const hit = path.findIndex(value => value >= goal.target);
    goalEtaDay.set(goal.id, hit < 0 ? null : (days[hit] ?? null));
  }
  return {
    days,
    byAccount,
    householdLiquid: {
      p10: liquidSamples.map(day => quantile(day, 0.1)),
      p50: liquidSamples.map(day => quantile(day, 0.5)),
      p90: liquidSamples.map(day => quantile(day, 0.9)),
      pBelowZero: liquidSamples.map(day => day.filter(value => value < 0).length / paths),
    },
    goalEtaDay,
  };
}
