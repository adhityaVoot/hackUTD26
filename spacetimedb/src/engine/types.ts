/** Plain engine values. Money is number cents. No SpacetimeDB types. */

export type Role = 'coowner' | 'member';
export type Cadence = 'monthly' | 'biweekly' | 'semimonthly' | 'once';
export type ShareLevel = 'full' | 'summary' | 'signal' | 'none';
export type VitalBand = 'green' | 'yellow' | 'red';
export type VitalKey =
  | 'runway'
  | 'crunch_risk'
  | 'dti'
  | 'utilization'
  | 'savings_rate'
  | 'goal_track'
  | 'score';

export interface Person {
  id: number;
  displayName: string;
  role: Role;
  personaKey: string;
}

export interface Account {
  id: number;
  ownerPersonId: number;
  isJoint: boolean;
  kind: string;
  nickname: string;
  balanceCents: number;
  limitCents: number;
  aprBps: number;
  bufferCents: number;
  maturityDay: number;
  shareLevel: ShareLevel;
}

export interface Obligation {
  id: number;
  accountId: number;
  kind: string;
  label: string;
  amountCents: number;
  cadence: Cadence;
  anchorDay: number;
  flexible: boolean;
}

export interface SpendProfile {
  id: number;
  accountId: number;
  category: string;
  dailyProb: number;
  logMean: number;
  logSd: number;
  weekendMult: number;
}

export interface Goal {
  id: number;
  ownerPersonId: number;
  name: string;
  targetCents: number;
  targetDay: number;
  accountId: number;
}

export interface Txn {
  accountId: number;
  day: number;
  amountCents: number;
  category: string;
  merchantCode: string;
  rawDescription: string;
}

export interface PersonaConfig {
  householdName: string;
  persons: Person[];
  accounts: Account[];
  obligations: Obligation[];
  spendProfiles: SpendProfile[];
  goals: Goal[];
  scripted: Txn[];
  historyStartDay: number;
  historyEndDay: number;
  futureStartDay: number;
  futureEndDay: number;
}

export interface GeneratedHousehold {
  persons: Person[];
  accounts: Account[];
  obligations: Obligation[];
  spendProfiles: SpendProfile[];
  history: Txn[];
  future: Txn[];
  goals: Goal[];
}

export interface ForecastAccount {
  id: number;
  kind: string;
  balance: number;
  limit: number;
  buffer: number;
  maturityDay: number;
  aprBps: number;
}

export interface ForecastObligation {
  id: number;
  accountId: number;
  kind: string;
  amount: number;
  cadence: string;
  anchorDay: number;
  flexible: boolean;
}

export interface ForecastSpend {
  accountId: number;
  category: string;
  dailyProb: number;
  logMean: number;
  logSd: number;
  weekendMult: number;
}

export interface ForecastGoal {
  id: number;
  accountId: number;
  target: number;
  targetDay: number;
}

export interface ForecastInput {
  startDay: number;
  horizon: number;
  accounts: ForecastAccount[];
  obligations: ForecastObligation[];
  spend: ForecastSpend[];
  shocksPerMonth: number;
  shockLogMean: number;
  shockLogSd: number;
  shockAccountId: number;
  goals: ForecastGoal[];
  monthlyIncome: number;
}

export interface Change {
  kind: string;
  params: Record<string, unknown>;
}

export interface ForecastPath {
  p10: number[];
  p50: number[];
  p90: number[];
  pBelowBuffer: number[];
}

export interface ForecastResult {
  days: number[];
  byAccount: Map<number, ForecastPath>;
  householdLiquid: {
    p10: number[];
    p50: number[];
    p90: number[];
    pBelowZero: number[];
  };
  goalEtaDay: Map<number, number | null>;
}

export interface VitalResult {
  key: VitalKey;
  value: number;
  band: VitalBand;
  why: string;
  math: string[];
}

export interface Candidate {
  title: string;
  changes: Change[];
  effort: number;
  riskBefore: number;
  riskAfter: number;
}
