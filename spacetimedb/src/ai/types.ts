// Shared types for the Nemotron layer.
//
// Everything in this folder works on *tokens* (A, B, acct_3f, obl_1c, goal_2) rather than
// database ids or names. The module keeps the token -> id map locally (PseudoMap) and only
// the tokenized view ever reaches the model. Money here is whole or fractional dollars;
// conversion to/from integer cents happens at the database boundary.

export type FeatureKind =
  | 'twin' // 1. AI Financial Digital Twin: "Can we afford X?"
  | 'ripple' // 2. Financial Ripple Effect: cascading consequences of one decision
  | 'negotiation' // 3. Financial Negotiation Room: impartial mediator
  | 'stress' // 4. AI Financial Stress Testing: hypothetical emergencies
  | 'life_event' // 5. Life Event Simulator: event -> assumptions -> scenario
  | 'memory' // 6. Financial Memory: why did we decide X?
  | 'opportunity' // 7. Opportunity Radar
  | 'health' // PNC: the six vitals explained, with the best next move
  | 'briefing' // Proactive: forecast + obligations + risks, run on a schedule; Sentinel mode proposes a fix
  | 'coach'; // Conversational coach: Nemotron routes the message to one of the features above

export const FEATURE_KINDS: FeatureKind[] = [
  'twin',
  'ripple',
  'negotiation',
  'stress',
  'life_event',
  'memory',
  'opportunity',
  'health',
  'briefing',
  'coach',
];

/** Features the coach can route a message to. */
export const ROUTABLE: FeatureKind[] = ['twin', 'ripple', 'stress', 'life_event', 'memory', 'opportunity', 'health', 'briefing'];

export type Visibility = 'full' | 'summary' | 'signal';

export interface TwinMember {
  token: string; // 'A', 'B', 'C'
  role: string; // 'coowner' | 'member'
  isRequester: boolean;
}

export interface TwinAccount {
  token: string;
  kind: string; // checking | savings | credit_card | cd | ira | auto_loan | personal_loan | mortgage
  owner: string; // member token or 'joint'
  visibility: Visibility; // what the *requester* may see; signal = aggregate only
  balance: number; // dollars; debts are positive amounts owed
  limit: number; // credit cards
  aprPct: number;
  buffer: number; // checking "don't go below" line
  maturityDay: number; // CDs; -1 otherwise
}

export interface TwinObligation {
  token: string;
  kind: string; // income | mortgage | auto_loan | card_payment | utility | insurance | subscription | tuition | transfer | rent
  label: string; // sanitized, never raw user/merchant text
  amount: number; // positive dollars
  cadence: string; // monthly | biweekly | semimonthly | once
  anchorDay: number;
  accountToken: string;
  owner: string; // member token or 'joint'
  flexible: boolean;
  visible: boolean; // false when it sits on a signal account
}

export interface TwinSpending {
  category: string;
  dailyMean: number; // expected dollars per day, liquid accounts only
  dailyVar: number;
}

export interface TwinGoal {
  token: string;
  name: string;
  target: number;
  saved: number;
  targetDay: number;
  shared: boolean;
}

export interface TwinData {
  today: number;
  members: TwinMember[];
  accounts: TwinAccount[];
  obligations: TwinObligation[];
  spending: TwinSpending[];
  goals: TwinGoal[];
}

// ---------- Levers (what the model may ask the engine to simulate) ----------
// Dates are ISO strings (YYYY-MM-DD) on the model side; the engine converts them to day numbers.

export type Lever =
  | { kind: 'one_time'; amount: number; date: string; label: string; flow?: 'out' | 'in'; account?: string }
  | {
      kind: 'recurring_change';
      category: string;
      monthly_delta: number;
      start_date: string;
      end_date?: string;
      label: string;
    }
  | {
      kind: 'income_change';
      member: string;
      percent?: number; // -100 = income stops
      monthly_delta?: number;
      start_date: string;
      end_date?: string;
      label: string;
    }
  | { kind: 'transfer'; from: string; to: string; amount: number; date: string; label?: string }
  | { kind: 'extra_payment'; loan: string; amount: number; date: string; label?: string }
  | { kind: 'move_obligation'; obligation: string; new_date: string; label?: string }
  | { kind: 'pause_obligation'; obligation: string; start_date: string; end_date?: string; label?: string };

/** A lever after validation: day numbers resolved, label sanitized. */
export interface ResolvedLever {
  kind: Lever['kind'];
  label: string;
  amount: number; // dollars; meaning depends on kind (monthly for recurring/income)
  day: number; // start / occurrence day
  endDay: number; // -1 = open ended
  from: string; // account token / member token / obligation token depending on kind
  to: string;
  category: string;
  percent: number;
  flowIn: boolean;
  source: Lever;
}

// ---------- Twin output ----------

export interface ForecastPoint {
  day: number;
  p10: number;
  p50: number;
  p90: number;
  pBelowBuffer: number;
}

export interface GoalProjection {
  token: string;
  name: string;
  etaDay: number; // NO_ETA = not within the horizon
  targetDay: number;
  lateDays: number; // positive = late
}

export type VitalKey = 'runway' | 'crunch_risk' | 'dti' | 'utilization' | 'savings_rate' | 'goal_track' | 'score';
export type Band = 'green' | 'yellow' | 'red';

export interface VitalValue {
  key: VitalKey;
  value: number;
  band: Band;
  display: string; // e.g. "1.8 months", "64%"
}

export interface TwinResult {
  points: ForecastPoint[]; // household liquid, next 60 days
  startLiquid: number;
  buffer: number;
  minBalance: number;
  minDay: number;
  minBalance12m: number; // lowest expected cash over the next 12 months
  minDay12m: number;
  firstCrunchDay: number; // first day pBelowBuffer > 0.25, -1 if none
  peakCrunchRisk: number; // max pBelowBuffer over the next 30 days
  peakCrunchDay: number;
  monthlyIncome: number;
  monthlyOutflow: number;
  monthlySurplus: number;
  essentialMonthly: number;
  goals: GoalProjection[];
  vitals: VitalValue[];
}

export interface VitalDelta {
  key: VitalKey;
  before: string;
  after: string;
  beforeValue: number;
  afterValue: number;
  direction: 'better' | 'worse' | 'same';
}

export interface GoalShift {
  token: string;
  name: string;
  beforeEta: string;
  afterEta: string;
  shiftDays: number; // positive = later
}

export interface TwinDiff {
  vitals: VitalDelta[];
  goals: GoalShift[];
  minBalanceBefore: number;
  minBalanceAfter: number;
  minDayAfter: string;
  minBalance12mBefore: number;
  minBalance12mAfter: number;
  minDay12mAfter: string;
  crunchBefore: number; // peak risk %
  crunchAfter: number;
  crunchDayAfter: string;
  bufferBreachDay: string; // first day the p50 path falls below the buffer, '' if never
  monthlySurplusBefore: number;
  monthlySurplusAfter: number;
}

// ---------- Agent result envelope (stored as JSON in ai_insight.result_json) ----------

export interface Highlight {
  label: string;
  before?: string;
  after?: string;
  value?: string;
  direction?: 'better' | 'worse' | 'same' | 'neutral';
}

export interface ScenarioDraft {
  simId: string;
  title: string;
  levers: ResolvedLever[];
  diff: TwinDiff;
}

export interface InsightResult {
  kind: FeatureKind;
  title: string;
  answer: string; // plain text, number-checked
  verdict?: string;
  highlights: Highlight[];
  sections: { heading: string; items: string[] }[];
  scenarios: ScenarioDraft[]; // forks the agent built; the first one becomes a draft scenario row
  extra?: Record<string, unknown>; // feature-specific structured payload (chain, assumptions, opportunities...)
  source: 'nemotron' | 'fallback';
  model?: string;
  disclaimer: string;
}

export interface AgentStep {
  step: string; // observe | plan | tool_call | simulate | verify | model_call | parse | fallback | pii_scan | injection_flag | propose
  detail: string;
  flagged: boolean;
}
