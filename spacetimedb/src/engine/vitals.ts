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
}

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
  for (const id of input.checkingIds) {
    const series = input.forecast.byAccount.get(id)?.pBelowBuffer ?? [];
    series.slice(0, 30).forEach((risk, index) => {
      if (risk > crunch) {
        crunch = risk;
        crunchDay = input.forecast.days[index] ?? crunchDay;
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
  const why = needsIncome
    ? 'Needs more data before this vital is meaningful.'
    : `The tightest day in view is ${simDayToIso(crunchDay)}; ${Math.round(crunch * 100)}% of paths dip below the buffer.`;
  return [
    {
      key: 'runway',
      value: runwayMonths,
      band: input.essentialMonthly > 0 ? higherBetter(runwayMonths, 3, 1) : 'yellow',
      why: input.essentialMonthly > 0 ? why : 'Needs more data before runway is meaningful.',
      math: [`liquid ${input.liquidNow}`, `essentials ${input.essentialMonthly}`],
    },
    {
      key: 'crunch_risk',
      value: crunch,
      band: lowerBetter(crunch, 0.1, 0.25, false),
      why,
      math: [`max pBelowBuffer ${crunch}`, `day ${crunchDay}`],
    },
    {
      key: 'dti',
      value: dti,
      band: needsIncome ? 'yellow' : lowerBetter(dti, 0.36, 0.43),
      why: needsIncome ? 'Needs more data before debt-to-income is meaningful.' : why,
      math: [`debt payments ${input.monthlyDebtPayments}`, `income ${income}`],
    },
    {
      key: 'utilization',
      value: utilization,
      band: input.cardLimits > 0 ? lowerBetter(utilization, 0.3, 0.5) : 'green',
      why,
      math: [`cards ${input.cardBalances}`, `limits ${input.cardLimits}`],
    },
    {
      key: 'savings_rate',
      value: savingsRate,
      band: needsIncome ? 'yellow' : higherBetter(savingsRate, 0.15, 0.05),
      why: needsIncome ? 'Needs more data before the savings rate is meaningful.' : why,
      math: [`income ${input.trailingIncome}`, `spending ${input.trailingSpending}`],
    },
    {
      key: 'goal_track',
      value: goalLateMonths,
      band: input.goals.length === 0 ? 'green' : lowerBetter(goalLateMonths, 0, 3),
      why,
      math: [`late months ${goalLateMonths}`],
    },
    {
      key: 'score',
      value: score,
      band: higherBetter(score, 70, 45),
      why,
      math: scoreParts.map(String),
    },
  ];
}
