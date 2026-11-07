import { table, t } from 'spacetimedb/server';

// ---------- Household & people ----------
export const household = table({ name: 'household' }, {
  id: t.u64().primaryKey().autoInc(),
  name: t.string(),
  inviteCode: t.string().unique(),
  cosignThresholdCents: t.i64(),          // default 50_000 ($500)
  baselineScenarioId: t.u64(),            // current merged plan
  simDay: t.i32(),                        // Time Machine "today"
  clockScheduleId: t.u64(),               // 0 = clock stopped
  secondsPerDay: t.u32(),                 // Time Machine speed
  aiEnabled: t.bool(),                    // KILL SWITCH
  seed: t.u64(),                          // generator + forecast seed
  createdAt: t.timestamp(),
});

export const person = table({ name: 'person' }, {      // a human in the household (seeded); devices claim persons
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  displayName: t.string(),
  role: t.string(),                       // 'coowner' | 'member'
  personaKey: t.string(),                 // 'priya' | 'sam' | 'maya'
  pinHash: t.string(),                    // DEMO step-up PIN digest ('' = not set) — see §10
});

export const member = table({ name: 'member' }, {      // a connected identity (device) bound to a person
  identity: t.identity().primaryKey(),
  householdId: t.u64().index('btree'),
  personId: t.u64().index('btree'),       // 0 for banker
  kind: t.string(),                       // 'person' | 'banker'
  online: t.bool(),
  lastActiveAt: t.timestamp(),
  stepUpAt: t.timestamp(),                // last successful PIN check
});

// ---------- Accounts & activity ----------
export const account = table({ name: 'account' }, {
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  ownerPersonId: t.u64().index('btree'),  // for joint accounts = 0
  isJoint: t.bool(),
  kind: t.string(),                       // 'checking'|'savings'|'credit_card'|'cd'|'ira'|'auto_loan'|'personal_loan'|'mortgage'
  nickname: t.string(),
  balanceCents: t.i64(),                  // loans/cards: amount owed (positive)
  limitCents: t.i64(),                    // cards only (Nessie has no limits — we add them here)
  aprBps: t.i32(),                        // 2299 = 22.99%
  bufferCents: t.i64(),                   // checking: "don't go below" line for Crunch Risk
  maturityDay: t.i32(),                   // CDs; -1 otherwise
  nessieId: t.string(),                   // '' if not mirrored in Nessie (CD/IRA/mortgage)
});

export const txn = table({ name: 'txn' }, {
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  accountId: t.u64().index('btree'),
  day: t.i32(),
  amountCents: t.i64(),                   // negative = money out of this account
  category: t.string(),                   // 'income'|'groceries'|'dining'|'gas'|'shopping'|'entertainment'|'utilities'|'housing'|'auto'|'insurance'|'subscriptions'|'kids'|'transfer'|'shock'|'other'
  merchantCode: t.string(),               // normalized, e.g. 'GROCERY_017' — the ONLY merchant field ever sent to AI
  rawDescription: t.string(),             // untrusted text (from Nessie/generator). NEVER sent to AI.
  nessieId: t.string().index('btree'),
});

export const futureTxn = table({ name: 'future_txn' }, {   // hidden "what actually happens" ledger the Time Machine reveals day by day
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  accountId: t.u64(),
  day: t.i32().index('btree'),
  amountCents: t.i64(),
  category: t.string(),
  merchantCode: t.string(),
  rawDescription: t.string(),
});

export const obligation = table({ name: 'obligation' }, {
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  accountId: t.u64().index('btree'),      // account it's paid from (or paid into for income)
  kind: t.string(),                       // 'income'|'mortgage'|'auto_loan'|'card_payment'|'utility'|'insurance'|'subscription'|'tuition'|'transfer'
  label: t.string(),
  amountCents: t.i64(),                   // positive
  cadence: t.string(),                    // 'monthly'|'biweekly'|'semimonthly'|'once'
  anchorDay: t.i32(),                     // first occurrence (sim day)
  flexible: t.bool(),                     // can be moved by a lever (e.g. card autopay date)
  active: t.bool(),
  nessieId: t.string(),
});

export const spendProfile = table({ name: 'spend_profile' }, { // per account × category spending model (fit from history by engine)
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  accountId: t.u64(),
  category: t.string(),
  dailyProb: t.f64(),                     // P(at least one purchase today)
  logMean: t.f64(),                       // lognormal params of amount in dollars
  logSd: t.f64(),
  weekendMult: t.f64(),                   // >1 boosts dailyProb on Fri/Sat
});

export const goal = table({ name: 'goal' }, {
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  ownerPersonId: t.u64(),                 // 0 = shared goal
  name: t.string(),
  targetCents: t.i64(),
  targetDay: t.i32(),
  accountId: t.u64(),                     // savings account the goal tracks
});

// ---------- Futures (scenarios) ----------
export const scenario = table({ name: 'scenario' }, {
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  parentId: t.u64(),                      // 0 for the first baseline
  authorPersonId: t.u64(),                // 0 if agent-authored
  agentKind: t.string(),                  // '' | 'sentinel' | 'coach' | 'mediator'
  title: t.string(),
  explanation: t.string(),                // engine-filled text (AI template + slots) or deterministic template
  status: t.string(),                     // 'baseline'|'draft'|'proposed'|'merged'|'declined'|'superseded'|'stale'
  scope: t.string(),                      // 'household'|'individual'|'routed'
  audiencePersonId: t.u64(),              // individual/routed: who sees it; 0 = household
  createdAt: t.timestamp(),
  computedAtDay: t.i32(),                 // simDay of last recompute
});

export const scenarioChange = table({ name: 'scenario_change' }, {
  id: t.u64().primaryKey().autoInc(),
  scenarioId: t.u64().index('btree'),
  householdId: t.u64().index('btree'),
  kind: t.string(),                       // 'one_time'|'recurring_change'|'move_obligation'|'transfer'|'extra_payment'|'delay_change'
  paramsJson: t.string(),                 // validated by engine/levers.ts
  label: t.string(),
});

export const forecastDay = table({ name: 'forecast_day' }, {
  id: t.u64().primaryKey().autoInc(),
  scenarioId: t.u64().index('btree'),
  householdId: t.u64().index('btree'),
  accountId: t.u64(),                     // 0 = household liquid total (safe to show everyone)
  day: t.i32(),
  p10Cents: t.i64(),
  p50Cents: t.i64(),
  p90Cents: t.i64(),
  pBelowBuffer: t.f64(),
});

export const vital = table({ name: 'vital' }, {
  id: t.u64().primaryKey().autoInc(),
  scenarioId: t.u64().index('btree'),
  householdId: t.u64().index('btree'),
  scopePersonId: t.u64(),                 // 0 = household vital; else that person's individual vital
  key: t.string(),                        // 'runway'|'crunch_risk'|'dti'|'utilization'|'savings_rate'|'goal_track'|'score'
  value: t.f64(),
  band: t.string(),                       // 'green'|'yellow'|'red'
  why: t.string(),                        // one-line plain English, engine-written
  mathJson: t.string(),                   // inputs used ("show your math") — totals only for others' accounts
});

export const approval = table({ name: 'approval' }, {
  id: t.u64().primaryKey().autoInc(),
  scenarioId: t.u64().index('btree'),
  householdId: t.u64().index('btree'),
  personId: t.u64(),
  decision: t.string(),                   // 'approve'|'decline'|'counter'
  at: t.timestamp(),
});

export const commitment = table({ name: 'commitment' }, {
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  scenarioId: t.u64(),
  label: t.string(),
  dueDay: t.i32(),
  done: t.bool(),
  transferFromAccountId: t.u64(),         // 0 if not a transfer
  transferToAccountId: t.u64(),
  amountCents: t.i64(),
  bankStatus: t.string(),                 // 'n/a'|'queued'|'pending_at_bank'|'executed'|'failed'
  nessieTransferId: t.string(),
});

// ---------- Alerts & recommendations ----------
export const alert = table({ name: 'alert' }, {
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  routedToPersonId: t.u64().index('btree'),
  aboutPersonId: t.u64(),
  kind: t.string(),                       // 'crunch'|'grant_expiring'|'grant_expired'|'proposal'|'injection_blocked'
  day: t.i32(),
  riskPct: t.f64(),
  scenarioId: t.u64(),                    // attached fix, 0 if none
  message: t.string(),
  read: t.bool(),
  createdAt: t.timestamp(),
});

// ---------- Consent & security ----------
export const grant = table({ name: 'grant' }, {
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  accountId: t.u64().index('btree'),
  grantorPersonId: t.u64(),
  granteePersonId: t.u64().index('btree'), // 0 = whole household (used for 'signal')
  granteeIdentityHex: t.string(),          // banker grants only
  level: t.string(),                       // 'signal'|'summary'|'full'
  historyWindowDays: t.i32(),              // default 90
  expiresAt: t.timestamp(),                // REQUIRED. max now + 90 days
  status: t.string(),                      // 'active'|'expired'|'revoked'|'paused'
  createdAt: t.timestamp(),
});

export const grantExpiry = table({ name: 'grant_expiry' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
  grantId: t.u64(),
});

export const consentLog = table({ name: 'consent_log' }, {   // append-only
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  actorPersonId: t.u64(),
  accountId: t.u64(),
  action: t.string(),                     // 'grant_created'|'grant_renewed'|'grant_revoked'|'grant_expired'|'grant_paused'|'member_joined'|'member_left'
  detail: t.string(),
  at: t.timestamp(),
});

// ---------- Agents ----------
export const aiRun = table({ name: 'ai_run' }, {
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  kind: t.string(),                       // 'sentinel'|'coach'|'mediator'
  requesterPersonId: t.u64(),             // 0 for sentinel
  inputJson: t.string(),                  // SANITIZED payload actually sent (for audit)
  status: t.string(),                     // 'queued'|'thinking'|'done'|'failed'|'blocked'|'fallback'
  resultScenarioId: t.u64(),
  summary: t.string(),
  createdAt: t.timestamp(),
});

export const aiJob = table({ name: 'ai_job' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
  runId: t.u64(),
});

export const agentLog = table({ name: 'agent_log' }, {        // append-only
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  runId: t.u64(),
  step: t.string(),                       // 'observe'|'candidates'|'prompt_built'|'pii_scan'|'model_call'|'parse'|'verify'|'propose'|'fallback'|'injection_flag'
  detail: t.string(),
  flagged: t.bool(),
  at: t.timestamp(),
});

export const aiUsage = table({ name: 'ai_usage' }, {           // rate limiting
  householdId: t.u64().primaryKey(),
  windowStart: t.timestamp(),
  count: t.u32(),
});

// ---------- Nessie ----------
export const nessieMap = table({ name: 'nessie_map' }, {
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  localKind: t.string(),                  // 'person'|'account'|'merchant'
  localId: t.u64(),
  nessieId: t.string().unique(),
});

export const nessieJob = table({ name: 'nessie_job' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
  householdId: t.u64(),
  kind: t.string(),                       // 'seed'|'sync'|'execute'
  cursor: t.u32(),                        // batch position for seeding (20 requests per run)
});

export const nessieStatus = table({ name: 'nessie_status' }, {
  householdId: t.u64().primaryKey(),
  lastSyncAt: t.timestamp(),
  lastError: t.string(),
  seeded: t.bool(),
});

// ---------- Live & demo ----------
export const presence = table({ name: 'presence' }, {
  identity: t.identity().primaryKey(),
  householdId: t.u64().index('btree'),
  personId: t.u64(),
  scenarioId: t.u64(),                    // what they're looking at/editing
  updatedAt: t.timestamp(),
});

export const clockTick = table({ name: 'clock_tick' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
  householdId: t.u64(),
});

export const dailyMaintenance = table({ name: 'daily_maintenance' }, {   // pauses dormant grants, sends expiry warnings
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

export const backtestResult = table({ name: 'backtest_result' }, {        // P1
  id: t.u64().primaryKey().autoInc(),
  runLabel: t.string(),
  households: t.u32(),
  recallAt5d: t.f64(),
  precision: t.f64(),
  medianLeadDays: t.f64(),
  bandCoverage: t.f64(),
  brier: t.f64(),
  baselineNaiveRecall: t.f64(),
  createdAt: t.timestamp(),
});
