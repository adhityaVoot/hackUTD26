import type { Ctx } from './auth';
import { runForecast } from './engine/forecast';
import type { Change, ForecastInput } from './engine/types';
import { computeVitals } from './engine/vitals';

function listed<T>(rows: Iterable<T>): T[] {
  const out: T[] = [];
  for (const row of rows) out.push(row);
  return out;
}

function n(id: bigint): number {
  return Number(id);
}

function changesFor(ctx: Ctx, scenarioId: bigint): Change[] {
  const changes: Change[] = [];
  for (const row of listed(ctx.db.scenarioChange.scenarioId.filter(scenarioId))) {
    try {
      const params = JSON.parse(row.paramsJson) as Record<string, unknown>;
      changes.push({ kind: row.kind, params });
    } catch {
      changes.push({ kind: row.kind, params: {} });
    }
  }
  return changes;
}

export function recomputeScenario(ctx: Ctx, scenarioId: bigint): void {
  const scenario = ctx.db.scenario.id.find(scenarioId);
  if (!scenario) return;
  const household = ctx.db.household.id.find(scenario.householdId);
  if (!household) return;

  for (const row of listed(ctx.db.forecastDay.scenarioId.filter(scenarioId))) {
    ctx.db.forecastDay.id.delete(row.id);
  }
  for (const row of listed(ctx.db.vital.scenarioId.filter(scenarioId))) {
    ctx.db.vital.id.delete(row.id);
  }

  const accounts = listed(ctx.db.account.householdId.filter(household.id));
  const obligations = listed(ctx.db.obligation.householdId.filter(household.id)).filter(row => row.active);
  const spend = listed(ctx.db.spendProfile.householdId.filter(household.id));
  const goals = listed(ctx.db.goal.householdId.filter(household.id));
  const history = listed(ctx.db.txn.householdId.filter(household.id)).filter(
    row => row.day >= household.simDay - 90 && row.day < household.simDay,
  );

  let monthlyIncome = 0;
  let monthlyDebt = 0;
  for (const row of obligations) {
    if (row.kind === 'income') {
      const times = row.cadence === 'semimonthly' || row.cadence === 'biweekly' ? 2 : 1;
      monthlyIncome += n(row.amountCents) * times;
    } else if (row.kind === 'mortgage' || row.kind === 'auto_loan' || row.kind === 'card_payment') {
      monthlyDebt += n(row.amountCents);
    }
  }
  let trailingIncome = 0;
  let trailingSpending = 0;
  for (const row of history) {
    const amount = n(row.amountCents);
    if (amount > 0) trailingIncome += amount;
    else trailingSpending += -amount;
  }
  if (monthlyIncome === 0) monthlyIncome = trailingIncome;

  const input: ForecastInput = {
    startDay: household.simDay,
    horizon: 60,
    accounts: accounts.map(row => ({
      id: n(row.id),
      kind: row.kind,
      balance: n(row.balanceCents),
      limit: n(row.limitCents),
      buffer: n(row.bufferCents),
      maturityDay: row.maturityDay,
      aprBps: row.aprBps,
    })),
    obligations: obligations.map(row => ({
      id: n(row.id),
      accountId: n(row.accountId),
      kind: row.kind,
      amount: n(row.amountCents),
      cadence: row.cadence,
      anchorDay: row.anchorDay,
      flexible: row.flexible,
    })),
    spend: spend.map(row => ({
      accountId: n(row.accountId),
      category: row.category,
      dailyProb: row.dailyProb,
      logMean: row.logMean,
      logSd: row.logSd,
      weekendMult: row.weekendMult,
    })),
    shocksPerMonth: 0.4,
    shockLogMean: Math.log(80),
    shockLogSd: 0.4,
    shockAccountId: n(accounts.find(row => row.kind === 'checking')?.id ?? 0n),
    goals: goals.map(row => ({
      id: n(row.id),
      accountId: n(row.accountId),
      target: n(row.targetCents),
      targetDay: row.targetDay,
    })),
    monthlyIncome,
  };

  const paths = household.isBot ? 40 : 300;
  const forecast = runForecast(input, changesFor(ctx, scenarioId), {
    paths,
    seed: n(household.seed),
  });

  const writeSeries = (
    accountId: number,
    series: { p10: number[]; p50: number[]; p90: number[]; pBelowBuffer?: number[]; pBelowZero?: number[] },
  ) => {
    forecast.days.forEach((day, index) => {
      ctx.db.forecastDay.insert({
        id: 0n,
        scenarioId,
        householdId: household.id,
        accountId: BigInt(accountId),
        day,
        p10Cents: BigInt(Math.round(series.p10[index] ?? 0)),
        p50Cents: BigInt(Math.round(series.p50[index] ?? 0)),
        p90Cents: BigInt(Math.round(series.p90[index] ?? 0)),
        pBelowBuffer: series.pBelowBuffer?.[index] ?? series.pBelowZero?.[index] ?? 0,
      });
    });
  };

  for (const account of accounts) {
    const series = forecast.byAccount.get(n(account.id));
    if (series) writeSeries(n(account.id), series);
  }
  writeSeries(0, forecast.householdLiquid);

  const checkingIds = accounts.filter(row => row.kind === 'checking').map(row => n(row.id));
  const cards = accounts.filter(row => row.kind === 'credit_card');
  const liquidNow = accounts
    .filter(row => row.kind === 'checking' || row.kind === 'savings')
    .reduce((sum, row) => sum + n(row.balanceCents), 0);
  const essential = Math.max(monthlyDebt, 1);
  const vitals = computeVitals({
    forecast,
    checkingIds,
    cardBalances: cards.reduce((sum, row) => sum + n(row.balanceCents), 0),
    cardLimits: cards.reduce((sum, row) => sum + n(row.limitCents), 0),
    monthlyDebtPayments: monthlyDebt,
    monthlyIncome,
    trailingIncome,
    trailingSpending,
    essentialMonthly: accounts.length === 0 ? 0 : essential,
    liquidNow,
    goals: input.goals,
    accountNames: new Map(accounts.map(row => [n(row.id), row.nickname])),
  });
  for (const vital of vitals) {
    ctx.db.vital.insert({
      id: 0n,
      scenarioId,
      householdId: household.id,
      scopePersonId: 0n,
      key: vital.key,
      value: vital.value,
      band: vital.band,
      why: accounts.length === 0 || monthlyIncome === 0 ? 'Needs more data' : vital.why,
      mathJson: JSON.stringify(vital.math),
    });
  }
}
