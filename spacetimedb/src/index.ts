import { SenderError, schema, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import {
  PIN_FAIL_WINDOW_MICROS,
  PIN_LOCKOUT_MICROS,
  PIN_MAX_FAILURES,
  demoPinDigest,
  envValue,
  requireAdmin,
  requireCoOwner,
  requireMember,
  requireStepUp,
  stepUpValidUntilMicros,
} from './auth';
import {
  addScenarioChange,
  forkScenario,
  proposeScenario,
  removeScenarioChange,
  voteScenario,
} from './futures';
import { createGrant as makeGrant, renewGrant as renewGrantRow, revokeGrant as revokeGrantRow } from './grants';
import {
  addAccount as addAccountRow,
  addGoal as addGoalRow,
  addObligation as addObligationRow,
  addPerson as addPersonRow,
  addTransaction as addTransactionRow,
  createHousehold as makeHousehold,
  removeAccount as removeAccountRow,
  removeGoal as removeGoalRow,
  removeObligation as removeObligationRow,
  setAiEnabled as setAiFlag,
  setMonthlySpending as setMonthlySpendingRow,
  updateAccount as updateAccountRow,
} from './life';
import { seedDemo } from './seed';
import { timestampAt } from './time';
import {
  accountViewRow,
  consentEntryRow,
  grantViewRow,
  householdPersonRow,
  householdSessionRow,
  inviteCodeRow,
  obligationViewRow,
  readHouseholdConsentLog,
  readHouseholdPeople,
  readHouseholdScenarios,
  readMyAccounts,
  readMyForecast,
  readMyVitals,
  readScenarioChanges,
  readMyGrants,
  readMyHousehold,
  readMyInviteCode,
  readMyObligations,
  readMyTxns,
  txnViewRow,
} from './visibility';
import {
  account,
  agentLog,
  aiJob,
  aiRun,
  aiUsage,
  alert,
  approval,
  backtestResult,
  clockTick,
  commitment,
  consentLog,
  dailyMaintenance,
  forecastDay,
  futureTxn,
  goal,
  grant,
  grantExpiry,
  household,
  member,
  nessieJob,
  nessieMap,
  nessieStatus,
  obligation,
  person,
  presence,
  scenario,
  scenarioChange,
  spendProfile,
  txn,
  vital,
} from './tables';
import { registerNemotron } from './ai/module';
import { aiInsight, decisionMemory, negotiation, negotiationPosition, nemotronWatch, nemotronWatchState } from './ai/tables';

const spacetimedb = schema(
  {
    household,
    person,
    member,
    account,
    txn,
    futureTxn,
    obligation,
    spendProfile,
    goal,
    scenario,
    scenarioChange,
    forecastDay,
    vital,
    approval,
    commitment,
    alert,
    grant,
    grantExpiry,
    consentLog,
    aiRun,
    aiJob,
    agentLog,
    aiUsage,
    nessieMap,
    nessieJob,
    nessieStatus,
    presence,
    clockTick,
    dailyMaintenance,
    backtestResult,
    aiInsight,
    decisionMemory,
    negotiation,
    negotiationPosition,
    nemotronWatch,
    nemotronWatchState,
  },
  {
    env: {
      AI_API_KEY: t.string().optional(),
      AI_BASE_URL: t.string().optional(),
      AI_MODEL: t.string().optional(),
      AI_NO_THINK: t.string().optional(),
      AI_FALLBACK_API_KEY: t.string().optional(),
      AI_FALLBACK_BASE_URL: t.string().optional(),
      AI_FALLBACK_MODEL: t.string().optional(),
      NESSIE_API_KEY: t.string().optional(),
      NESSIE_BASE_URL: t.string().optional(),
      ADMIN_CODE: t.string().optional(),
    },
  },
);
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

function updateMemberPresence(ctx: Ctx, online: boolean): void {
  const row = ctx.db.member.identity.find(ctx.sender);
  if (!row) return;
  ctx.db.member.identity.update({
    ...row,
    online,
    lastActiveAt: ctx.timestamp,
  });
}

export const init = spacetimedb.init(ctx => {
  const row = ctx.db.member.identity.find(ctx.sender);
  if (!row) return;
  updateMemberPresence(ctx, row.online);
});

export const onConnect = spacetimedb.clientConnected(ctx => {
  updateMemberPresence(ctx, true);
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  updateMemberPresence(ctx, false);
});

const myMemberRow = t.row('MemberSession', {
  personId: t.u64().primaryKey(),
  displayName: t.string(),
  role: t.string(),
  householdId: t.u64(),
  stepUpValidUntilMicros: t.i64(),
});

/** Per-caller view. Empty until this identity has joined a household. */
export const myMember = spacetimedb.view(
  { name: 'my_member', public: true },
  t.option(myMemberRow),
  ctx => {
    const member = ctx.db.member.identity.find(ctx.sender);
    if (!member || member.personId === 0n) return undefined;
    const person = ctx.db.person.id.find(member.personId);
    if (!person) return undefined;
    return {
      personId: person.id,
      displayName: person.displayName,
      role: person.role,
      householdId: member.householdId,
      stepUpValidUntilMicros: stepUpValidUntilMicros(
        member.stepUpAt.microsSinceUnixEpoch,
      ),
    };
  },
);

export const myHousehold = spacetimedb.view(
  { name: 'my_household', public: true },
  t.option(householdSessionRow),
  readMyHousehold,
);

export const myInviteCode = spacetimedb.view(
  { name: 'my_invite_code', public: true },
  t.option(inviteCodeRow),
  readMyInviteCode,
);

export const householdPeople = spacetimedb.view(
  { name: 'household_people', public: true },
  t.array(householdPersonRow),
  readHouseholdPeople,
);

export const myAccounts = spacetimedb.view(
  { name: 'my_accounts', public: true },
  t.array(accountViewRow),
  readMyAccounts,
);

export const myTxns = spacetimedb.view(
  { name: 'my_txns', public: true },
  t.array(txnViewRow),
  readMyTxns,
);

export const myObligations = spacetimedb.view(
  { name: 'my_obligations', public: true },
  t.array(obligationViewRow),
  readMyObligations,
);

export const myGrants = spacetimedb.view(
  { name: 'my_grants', public: true },
  t.array(grantViewRow),
  readMyGrants,
);

export const householdScenarios = spacetimedb.view(
  { name: 'household_scenarios', public: true },
  t.array(scenario.rowType),
  readHouseholdScenarios,
);

export const scenarioChanges = spacetimedb.view(
  { name: 'scenario_changes', public: true },
  t.array(scenarioChange.rowType),
  readScenarioChanges,
);

export const myForecast = spacetimedb.view(
  { name: 'my_forecast', public: true },
  t.array(forecastDay.rowType),
  readMyForecast,
);

export const myVitals = spacetimedb.view(
  { name: 'my_vitals', public: true },
  t.array(vital.rowType),
  readMyVitals,
);

export const householdApprovals = spacetimedb.view(
  { name: 'household_approvals', public: true },
  t.array(approval.rowType),
  ctx => {
    const me = ctx.db.member.identity.find(ctx.sender);
    return ctx.from.approval.where(row => row.householdId.eq(me?.householdId ?? 0n));
  },
);

export const householdCommitments = spacetimedb.view(
  { name: 'household_commitments', public: true },
  t.array(commitment.rowType),
  ctx => {
    const me = ctx.db.member.identity.find(ctx.sender);
    return ctx.from.commitment.where(row => row.householdId.eq(me?.householdId ?? 0n));
  },
);

export const myAlerts = spacetimedb.view(
  { name: 'my_alerts', public: true },
  t.array(alert.rowType),
  ctx => {
    const me = ctx.db.member.identity.find(ctx.sender);
    return ctx.from.alert.where(row => row.routedToPersonId.eq(me?.personId ?? 0n));
  },
);

export const householdPresence = spacetimedb.view(
  { name: 'household_presence', public: true },
  t.array(presence.rowType),
  ctx => {
    const me = ctx.db.member.identity.find(ctx.sender);
    return ctx.from.presence.where(row => row.householdId.eq(me?.householdId ?? 0n));
  },
);

export const householdConsentLog = spacetimedb.view(
  { name: 'household_consent_log', public: true },
  t.array(consentEntryRow),
  readHouseholdConsentLog,
);

function isPin(pin: string): boolean {
  return /^[0-9]{4,6}$/.test(pin);
}

export const adminSeedDemo = spacetimedb.reducer(
  { adminCode: t.string(), inviteCode: t.string() },
  (ctx, { adminCode, inviteCode }) => {
    requireAdmin(ctx, adminCode);
    const code = inviteCode.trim();
    if (code === '') throw new SenderError('Invite code is required');
    seedDemo(ctx, code);
  },
);

export const joinHousehold = spacetimedb.reducer(
  { inviteCode: t.string(), name: t.string() },
  (ctx, { inviteCode, name }) => {
    // The invite code is the secret. The caller is not a member yet.
    const code = inviteCode.trim();
    const needle = name.trim().toLowerCase();
    if (code === '' || needle === '') {
      throw new SenderError('Invite code and name are required');
    }
    const household = ctx.db.household.inviteCode.find(code);
    if (!household) throw new SenderError('Invite code is not valid');
    let person = undefined;
    for (const row of ctx.db.person.householdId.filter(household.id)) {
      const listedName = row.displayName.toLowerCase();
      const personaKey = row.personaKey.toLowerCase();
      if (listedName === needle || personaKey === needle) person = row;
    }
    if (!person) throw new SenderError('That name is not in this household');

    const otherDevices = [];
    for (const row of ctx.db.member.personId.filter(person.id)) {
      if (!row.identity.equals(ctx.sender)) otherDevices.push(row);
    }
    for (const row of otherDevices) ctx.db.member.identity.delete(row.identity);

    const mine = ctx.db.member.identity.find(ctx.sender);
    const epoch = timestampAt(ctx.timestamp, 0n);
    if (mine && mine.personId === person.id) {
      ctx.db.member.identity.update({
        ...mine,
        householdId: household.id,
        kind: 'person',
        online: true,
        lastActiveAt: ctx.timestamp,
      });
    } else if (mine) {
      ctx.db.member.identity.update({
        ...mine,
        householdId: household.id,
        personId: person.id,
        kind: 'person',
        online: true,
        lastActiveAt: ctx.timestamp,
        stepUpAt: epoch,
        pinFailCount: 0,
        pinFailWindowStartMicros: 0n,
        pinLockedUntilMicros: 0n,
      });
    } else {
      ctx.db.member.insert({
        identity: ctx.sender,
        householdId: household.id,
        personId: person.id,
        kind: 'person',
        online: true,
        lastActiveAt: ctx.timestamp,
        stepUpAt: epoch,
        pinFailCount: 0,
        pinFailWindowStartMicros: 0n,
        pinLockedUntilMicros: 0n,
      });
    }

    ctx.db.consentLog.insert({
      id: 0n,
      householdId: household.id,
      actorPersonId: person.id,
      accountId: 0n,
      action: 'member_joined',
      detail: person.personaKey,
      at: ctx.timestamp,
    });
  },
);

export const setPin = spacetimedb.reducer({ pin: t.string() }, (ctx, { pin }) => {
  const me = requireMember(ctx);
  if (!isPin(pin)) throw new SenderError('PIN must be 4 to 6 digits');
  if (me.person.pinHash !== '') requireStepUp(ctx, me);
  ctx.db.person.id.update({
    ...me.person,
    pinHash: demoPinDigest(me.person.id, pin),
  });
});

function checkPin(ctx: Ctx, pin: string): string | undefined {
  const me = requireMember(ctx);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  if (me.member.pinLockedUntilMicros > now) {
    throw new SenderError('PIN locked. Try again in a few minutes');
  }
  if (me.person.pinHash === '') throw new SenderError('Set a PIN first');
  if (!isPin(pin)) throw new SenderError('PIN must be 4 to 6 digits');
  if (demoPinDigest(me.person.id, pin) === me.person.pinHash) {
    ctx.db.member.identity.update({
      ...me.member,
      stepUpAt: ctx.timestamp,
      pinFailCount: 0,
      pinFailWindowStartMicros: 0n,
      pinLockedUntilMicros: 0n,
    });
    return undefined;
  }

  let windowStart = me.member.pinFailWindowStartMicros;
  let count = me.member.pinFailCount;
  if (windowStart === 0n || now - windowStart > PIN_FAIL_WINDOW_MICROS) {
    windowStart = now;
    count = 1;
  } else {
    count += 1;
  }
  let lockedUntil = 0n;
  if (count >= PIN_MAX_FAILURES) {
    lockedUntil = now + PIN_LOCKOUT_MICROS;
    count = 0;
    windowStart = 0n;
  }
  ctx.db.member.identity.update({
    ...me.member,
    pinFailCount: count,
    pinFailWindowStartMicros: windowStart,
    pinLockedUntilMicros: lockedUntil,
  });
  return lockedUntil === 0n
    ? 'PIN is incorrect'
    : 'PIN locked. Try again in a few minutes';
}

// A reducer that throws rolls the failure count back, so the check commits
// in its own transaction and the error is reported after that commit.
export const verifyPin = spacetimedb.procedure(
  { pin: t.string() },
  t.unit(),
  (ctx, { pin }) => {
    const error = ctx.withTx(tx => checkPin(tx, pin));
    if (error !== undefined) throw new SenderError(error);
    return {};
  },
);

/** Scheduled from grantExpiry. Marks the grant expired and appends consentLog. */
export const expireGrant = spacetimedb.reducer(
  { onSchedule: grantExpiry },
  { arg: grantExpiry.rowType },
  (ctx, { arg }) => {
    if (!ctx.senderAuth.isInternal) {
      throw new SenderError('Grant expiry runs on a schedule');
    }
    const grantRow = ctx.db.grant.id.find(arg.grantId);
    if (!grantRow || grantRow.status === 'expired' || grantRow.status === 'revoked') return;
    ctx.db.grant.id.update({ ...grantRow, status: 'expired' });
    ctx.db.consentLog.insert({
      id: 0n,
      householdId: grantRow.householdId,
      actorPersonId: grantRow.grantorPersonId,
      accountId: grantRow.accountId,
      action: 'grant_expired',
    detail: 'signal access ended',
    at: ctx.timestamp,
  });
},
);

export const fork = spacetimedb.reducer(
  { parentId: t.u64(), title: t.string() },
  (ctx, { parentId, title }) => forkScenario(ctx, parentId, title),
);

export const addChange = spacetimedb.reducer(
  { scenarioId: t.u64(), kind: t.string(), paramsJson: t.string(), label: t.string() },
  (ctx, { scenarioId, kind, paramsJson, label }) =>
    addScenarioChange(ctx, scenarioId, kind, paramsJson, label),
);

export const removeChange = spacetimedb.reducer(
  { changeId: t.u64() },
  (ctx, { changeId }) => removeScenarioChange(ctx, changeId),
);

export const propose = spacetimedb.reducer(
  { scenarioId: t.u64() },
  (ctx, { scenarioId }) => proposeScenario(ctx, scenarioId),
);

export const vote = spacetimedb.reducer(
  { scenarioId: t.u64(), decision: t.string() },
  (ctx, { scenarioId, decision }) => voteScenario(ctx, scenarioId, decision),
);

export const createHousehold = spacetimedb.reducer(
  { name: t.string(), myDisplayName: t.string() },
  (ctx, args) => makeHousehold(ctx, args.name, args.myDisplayName),
);

export const addPerson = spacetimedb.reducer(
  { displayName: t.string(), role: t.string() },
  (ctx, args) => addPersonRow(ctx, args.displayName, args.role),
);

export const addAccount = spacetimedb.reducer(
  {
    kind: t.string(),
    nickname: t.string(),
    isJoint: t.bool(),
    ownerPersonId: t.u64(),
    balanceCents: t.i64(),
    limitCents: t.i64(),
    aprBps: t.i32(),
    bufferCents: t.i64(),
    maturityDay: t.i32(),
  },
  (ctx, args) =>
    addAccountRow(
      ctx,
      args.kind,
      args.nickname,
      args.isJoint,
      args.ownerPersonId,
      args.balanceCents,
      args.limitCents,
      args.aprBps,
      args.bufferCents,
      args.maturityDay,
    ),
);

export const updateAccount = spacetimedb.reducer(
  {
    accountId: t.u64(),
    nickname: t.string(),
    balanceCents: t.i64(),
    limitCents: t.i64(),
    aprBps: t.i32(),
    bufferCents: t.i64(),
  },
  (ctx, args) =>
    updateAccountRow(ctx, args.accountId, args.nickname, args.balanceCents, args.limitCents, args.aprBps, args.bufferCents),
);

export const removeAccount = spacetimedb.reducer(
  { accountId: t.u64() },
  (ctx, { accountId }) => removeAccountRow(ctx, accountId),
);

export const addObligation = spacetimedb.reducer(
  {
    accountId: t.u64(),
    kind: t.string(),
    label: t.string(),
    amountCents: t.i64(),
    cadence: t.string(),
    anchorDate: t.string(),
    flexible: t.bool(),
  },
  (ctx, args) =>
    addObligationRow(ctx, args.accountId, args.kind, args.label, args.amountCents, args.cadence, args.anchorDate, args.flexible),
);

export const removeObligation = spacetimedb.reducer(
  { obligationId: t.u64() },
  (ctx, { obligationId }) => removeObligationRow(ctx, obligationId),
);

export const addGoal = spacetimedb.reducer(
  {
    name: t.string(),
    targetCents: t.i64(),
    targetDate: t.string(),
    accountId: t.u64(),
    shared: t.bool(),
  },
  (ctx, args) => addGoalRow(ctx, args.name, args.targetCents, args.targetDate, args.accountId, args.shared),
);

export const removeGoal = spacetimedb.reducer(
  { goalId: t.u64() },
  (ctx, { goalId }) => removeGoalRow(ctx, goalId),
);

export const addTransaction = spacetimedb.reducer(
  {
    accountId: t.u64(),
    dateISO: t.string(),
    amountCents: t.i64(),
    category: t.string(),
    description: t.string(),
  },
  (ctx, args) => addTransactionRow(ctx, args.accountId, args.dateISO, args.amountCents, args.category, args.description),
);

export const setMonthlySpending = spacetimedb.reducer(
  { accountId: t.u64(), category: t.string(), monthlyCents: t.i64() },
  (ctx, args) => setMonthlySpendingRow(ctx, args.accountId, args.category, args.monthlyCents),
);

export const setAiEnabled = spacetimedb.reducer(
  { enabled: t.bool() },
  (ctx, { enabled }) => setAiFlag(ctx, enabled),
);

export const createGrant = spacetimedb.reducer(
  {
    accountId: t.u64(),
    granteePersonId: t.u64(),
    level: t.string(),
    durationSeconds: t.i64(),
    historyWindowDays: t.i32(),
  },
  (ctx, args) =>
    makeGrant(ctx, args.accountId, args.granteePersonId, args.level, args.durationSeconds, args.historyWindowDays),
);

export const revokeGrant = spacetimedb.reducer(
  { grantId: t.u64() },
  (ctx, { grantId }) => revokeGrantRow(ctx, grantId),
);

export const renewGrant = spacetimedb.reducer(
  { grantId: t.u64(), durationSeconds: t.i64() },
  (ctx, { grantId, durationSeconds }) => renewGrantRow(ctx, grantId, durationSeconds),
);


// Nemotron features: Coach (routes to the rest), Digital Twin, Ripple Effect, Negotiation Room,
// Stress Test, Life Event Simulator, Financial Memory, Opportunity Radar, Health Check, and the
// Sentinel briefing that runs on its own schedule. See src/ai/module.ts.
export const {
  askCoach,
  requestHealthCheck,
  requestBriefing,
  startNemotronWatch,
  stopNemotronWatch,
  nemotronWatchTick,
  askTwin,
  simulateRipple,
  stressTest,
  simulateLifeEvent,
  askMemory,
  scanOpportunities,
  openNegotiation,
  submitPosition,
  requestMediation,
  mediateNegotiation,
  closeNegotiation,
  recordDecision,
  shareInsight,
  seedNemotronDemo,
  runAiJob,
  myAiInsights,
  myAgentLog,
  myDecisions,
  myNegotiations,
  myNegotiationPositions,
} = registerNemotron(spacetimedb);
