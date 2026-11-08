import { simDayToIso } from './calendar';
import type { ForecastGoal, ForecastResult, VitalBand, VitalResult } from './types';

export interface VitalInput {
  forecast: ForecastResult;
  checkingIds: number[];
  cardBalances: number;
  cardLimits: number;
  monthlyDebtPayments: number;
  monthlyIncome: number;
  trailingIncome: number;
  trailingSpending: number;
  essentialMonthly: number;
  liquidNow: number;
  goals: ForecastGoal[];
  crunchDay?: number;
  /** Optional display names so explanations can say which account is at risk. */
  accountNames?: Map<number, string>;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

function higherBetter(value: number, greenAt: number, yellowAt: number): VitalBand {
  if (value >= greenAt) return 'green';
  if (value >= yellowAt) return 'yellow';
  return 'red';
}

function lowerBetter(value: number, greenAt: number, yellowAt: number, greenInclusive = true): VitalBand {
  const green = greenInclusive ? value <= greenAt : value < greenAt;
  if (green) return 'green';
  if (value <= yellowAt) return 'yellow';
  return 'red';
}

export function computeVitals(input: VitalInput): VitalResult[] {
  const needsIncome = input.monthlyIncome <= 0 && input.trailingIncome <= 0;
  const runwayMonths = input.essentialMonthly > 0 ? input.liquidNow / input.essentialMonthly : 0;
  let crunch = 0;
  let crunchDay = input.forecast.days[0] ?? 0;
  let crunchAccount: number | undefined;
  for (const id of input.checkingIds) {
    const series = input.forecast.byAccount.get(id)?.pBelowBuffer ?? [];
    series.slice(0, 30).forEach((risk, index) => {
      if (risk > crunch) {
        crunch = risk;
        crunchDay = input.forecast.days[index] ?? crunchDay;
        crunchAccount = id;
      }
    });
  }
  const income = input.monthlyIncome > 0 ? input.monthlyIncome : input.trailingIncome;
  const dti = income > 0 ? input.monthlyDebtPayments / income : 0;
  const utilization = input.cardLimits > 0 ? input.cardBalances / input.cardLimits : 0;
  const savingsRate = input.trailingIncome > 0 ? (input.trailingIncome - input.trailingSpending) / input.trailingIncome : 0;
  let goalLateMonths = 0;
  for (const goal of input.goals) {
    const eta = input.forecast.goalEtaDay.get(goal.id);
    if (eta == null) {
      goalLateMonths = Math.max(goalLateMonths, 99);
      continue;
    }
    goalLateMonths = Math.max(goalLateMonths, (eta - goal.targetDay) / 30);
  }
  const scoreParts = [
    crunch < 0.1 ? 25 : crunch <= 0.25 ? 12 : 0,
    runwayMonths >= 3 ? 20 : runwayMonths >= 1 ? 10 : 0,
    !needsIncome && dti <= 0.36 ? 15 : !needsIncome && dti <= 0.43 ? 8 : 0,
    utilization <= 0.3 ? 15 : utilization <= 0.5 ? 8 : 0,
    !needsIncome && savingsRate >= 0.15 ? 15 : !needsIncome && savingsRate >= 0.05 ? 8 : 0,
    goalLateMonths <= 0 ? 10 : goalLateMonths <= 3 ? 5 : 0,
  ];
  const score = scoreParts.reduce((sum, part) => sum + part, 0);
  const noData = 'Needs more data before this vital is meaningful.';
  const where = crunchAccount != null ? input.accountNames?.get(crunchAccount) ?? 'A checking account' : 'A checking account';
  const crunchWhy = crunch <= 0
    ? 'No checking account is projected to dip below its buffer in the next 30 days.'
    : crunch < 0.1
      ? `${where} is the tightest account and stays above its buffer in ${pct(1 - crunch)} of simulated paths.`
      : `${where} dips below its buffer around ${simDayToIso(crunchDay)} in ${pct(crunch)} of simulated paths.`;
  // The household liquid total is not printed: with a signal-shared account in it, subtracting the viewer's own total would reveal that balance.
  const runwayWhy = `Household checking and savings cover ${runwayMonths.toFixed(1)} months of essential monthly payments.`;
  const dtiWhy = `${dollars(input.monthlyDebtPayments)} of monthly debt payments against ${dollars(income)} of monthly income (${pct(dti)}; lenders look for 36% or less).`;
  const utilizationWhy = input.cardLimits > 0
    ? `${dollars(input.cardBalances)} owed on ${dollars(input.cardLimits)} of card limits (${pct(utilization)}; under 30% helps credit scores).`
    : 'No credit card limits on file.';
  const savingsWhy = `${pct(savingsRate)} of recent income was kept after spending (15% or more is healthy).`;
  const goalWhy = input.goals.length === 0
    ? 'No goals set yet.'
    : goalLateMonths <= 0
      ? 'Every goal is projected to land on or before its target date.'
      : goalLateMonths >= 99
        ? 'At least one goal is not reached inside the forecast window.'
        : `The furthest-behind goal is about ${goalLateMonths.toFixed(1)} months late.`;
  const weakest = [
    { label: 'crunch risk', lost: 25 - scoreParts[0] },
    { label: 'cash runway', lost: 20 - scoreParts[1] },
    { label: 'debt-to-income', lost: 15 - scoreParts[2] },
    { label: 'card utilization', lost: 15 - scoreParts[3] },
    { label: 'savings rate', lost: 15 - scoreParts[4] },
    { label: 'goal progress', lost: 10 - scoreParts[5] },
  ].sort((a, b) => b.lost - a.lost)[0];
  const scoreWhy = weakest.lost > 0
    ? `${score}/100 across six vitals; ${weakest.label} costs the most points (${weakest.lost}).`
    : `${score}/100 across six vitals; every vital is in its healthy band.`;
  return [
    {
      key: 'runway',
      value: runwayMonths,
      band: input.essentialMonthly > 0 ? higherBetter(runwayMonths, 3, 1) : 'yellow',
      why: input.essentialMonthly > 0 ? runwayWhy : 'Needs more data before runway is meaningful.',
      math: [`liquid ${input.liquidNow}`, `essentials ${input.essentialMonthly}`],
    },
    {
      key: 'crunch_risk',
      value: crunch,
      band: lowerBetter(crunch, 0.1, 0.25, false),
      why: needsIncome ? noData : crunchWhy,
      math: [`max pBelowBuffer ${crunch}`, `day ${crunchDay}`, ...(crunchAccount != null ? [`account ${crunchAccount}`] : [])],
    },
    {
      key: 'dti',
      value: dti,
      band: needsIncome ? 'yellow' : lowerBetter(dti, 0.36, 0.43),
      why: needsIncome ? 'Needs more data before debt-to-income is meaningful.' : dtiWhy,
      math: [`debt payments ${input.monthlyDebtPayments}`, `income ${income}`],
    },
    {
      key: 'utilization',
      value: utilization,
      band: input.cardLimits > 0 ? lowerBetter(utilization, 0.3, 0.5) : 'green',
      why: utilizationWhy,
      math: [`cards ${input.cardBalances}`, `limits ${input.cardLimits}`],
    },
    {
      key: 'savings_rate',
      value: savingsRate,
      band: needsIncome ? 'yellow' : higherBetter(savingsRate, 0.15, 0.05),
      why: needsIncome ? 'Needs more data before the savings rate is meaningful.' : savingsWhy,
      math: [`income ${input.trailingIncome}`, `spending ${input.trailingSpending}`],
    },
    {
      key: 'goal_track',
      value: goalLateMonths,
      band: input.goals.length === 0 ? 'green' : lowerBetter(goalLateMonths, 0, 3),
      why: goalWhy,
      math: [`late months ${goalLateMonths}`],
    },
    {
      key: 'score',
      value: score,
      band: higherBetter(score, 70, 45),
      why: scoreWhy,
      math: scoreParts.map(String),
    },
  ];
}
