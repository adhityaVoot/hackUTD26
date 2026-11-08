import {authenticatedEmail,householdAccess,personIdentity,familyInvitation,invitationEmailJob,registerInvitations,recordAuthenticatedEmail} from './familyInvitations';
import {renameAccount as renameAccountRow} from './life';
import {ageProfile,accountPrivacy,isMinor,setBirthDate,setOwnerAccess} from './accountPrivacy';
import {simDayToIso} from './engine/calendar';
import { moneyRequest, createMoneyRequest as createMoneyRequestRow, respondMoneyRequest as respondMoneyRequestRow } from './moneyRequests';
import { registerNessie } from './nessie/module';
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
import { registerNemotron } from './ai/module';
import { aiInsight, decisionMemory, negotiation, negotiationPosition, nemotronJob, nemotronWatch, nemotronWatchState } from './ai/tables';
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

const spacetimedb = schema(
  {
    household,
    authenticatedEmail,
    householdAccess,
    personIdentity,
    familyInvitation,
    invitationEmailJob,
    moneyRequest,
    ageProfile,
    accountPrivacy,
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
    nemotronJob,
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
      NESSIE_DEMO_CUSTOMERS: t.string().optional(),
      NESSIE_API_KEY: t.string().optional(),
      NESSIE_BASE_URL: t.string().optional(),
      AUTH_CLIENT_ID:t.string().optional(),
      RESEND_API_KEY:t.string().optional(),
      INVITE_FROM_EMAIL:t.string().optional(),
      APP_PUBLIC_URL:t.string().optional(),
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
  recordAuthenticatedEmail(ctx);
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
    if(ctx.db.householdAccess.householdId.find(household.id)?.invitationOnly)throw new SenderError('This household requires an email invitation. Sign in with your invited email and accept it.');
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

export const markAlertRead = spacetimedb.reducer({ alertId: t.u64() }, (ctx, { alertId }) => {
  const me = requireMember(ctx);
  const row = ctx.db.alert.id.find(alertId);
  if (!row || row.householdId !== me.household.id || row.routedToPersonId !== me.person.id) {
    throw new SenderError('Alert not found');
  }
  ctx.db.alert.id.update({ ...row, read: true });
});

// Coach, Health Check, Sentinel, Digital Twin, Ripple, Negotiation, Stress Test,
// Life Event, Financial Memory, and Opportunity Radar. The existing setAiEnabled
// reducer stays the co-owner kill switch.
export const {
  askCoach,
  debateDecision,
  proposeAgentPlan,
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


/** Imports only the caller’s server-mapped synthetic bank customer. */
export const syncNessieDemo = registerNessie(spacetimedb);

export const createMoneyRequest = spacetimedb.reducer(
  { recipientPersonId: t.u64(), amountCents: t.i64(), reason: t.string() },
  (ctx,args) => createMoneyRequestRow(ctx,args.recipientPersonId,args.amountCents,args.reason),
);
export const respondMoneyRequest = spacetimedb.reducer(
  { requestId: t.u64(), decision: t.string() },
  (ctx,args) => respondMoneyRequestRow(ctx,args.requestId,args.decision),
);
export const myMoneyRequests = spacetimedb.view(
  { name: 'my_money_requests', public: true }, t.array(moneyRequest.rowType), ctx => {
    const member = ctx.db.member.identity.find(ctx.sender);
    if (!member) return [];
    const person = ctx.db.person.id.find(member.personId);
    return [...ctx.db.moneyRequest.householdId.filter(member.householdId)].filter(row =>
      row.requesterPersonId === member.personId || row.recipientPersonId === member.personId || person?.role === 'coowner');
  },
);

export const setMemberBirthDate=spacetimedb.reducer({personId:t.u64(),birthDate:t.string()},(ctx,args)=>setBirthDate(ctx,args.personId,args.birthDate));
export const setAccountOwnerAccess=spacetimedb.reducer({accountId:t.u64(),allowed:t.bool()},(ctx,args)=>setOwnerAccess(ctx,args.accountId,args.allowed));
export const myAccountPrivacy=spacetimedb.view({name:'my_account_privacy',public:true},t.array(t.row('AccountPrivacySetting',{accountId:t.u64().primaryKey(),ownerAccessDisabled:t.bool(),isMinor:t.bool()})),ctx=>{
 const me=ctx.db.member.identity.find(ctx.sender);if(!me)return [];const h=ctx.db.household.id.find(me.householdId);if(!h)return [];
 const minor=isMinor(ctx.db.ageProfile.personId.find(me.personId)?.birthDate,simDayToIso(h.simDay));
 return [...ctx.db.account.ownerPersonId.filter(me.personId)].filter(a=>a.householdId===me.householdId&&!a.isJoint).map(a=>({accountId:a.id,ownerAccessDisabled:ctx.db.accountPrivacy.accountId.find(a.id)?.ownerAccessDisabled??false,isMinor:minor}));
});

/** Demo-only fixture setup, protected by the database admin secret. */
export const adminSetDemoBirthDates=spacetimedb.reducer({adminCode:t.string(),inviteCode:t.string(),birthDate:t.string()},(ctx,args)=>{
 requireAdmin(ctx,args.adminCode);const h=ctx.db.household.inviteCode.find(args.inviteCode);if(!h)throw new SenderError('Household not found');
 const d=new Date(args.birthDate+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==args.birthDate||args.birthDate>simDayToIso(h.simDay))throw new SenderError('Invalid demo birth date');
 for(const p of ctx.db.person.householdId.filter(h.id)){const row={personId:p.id,householdId:h.id,birthDate:args.birthDate};if(ctx.db.ageProfile.personId.find(p.id))ctx.db.ageProfile.personId.update(row);else ctx.db.ageProfile.insert(row);}
});

export const renameAccount=spacetimedb.reducer({accountId:t.u64(),nickname:t.string()},(ctx,args)=>renameAccountRow(ctx,args.accountId,args.nickname));

/** Verify household PIN before claiming membership; invalid attempts never join. */
export const joinHouseholdWithPin=spacetimedb.reducer({inviteCode:t.string(),name:t.string(),pin:t.string(),createPin:t.bool()},(ctx,args)=>{
 const household=ctx.db.household.inviteCode.find(args.inviteCode.trim().toUpperCase());
 const needle=args.name.trim().toLowerCase();
 const person=household?[...ctx.db.person.householdId.filter(household.id)].find(p=>p.displayName.toLowerCase()===needle||p.personaKey.toLowerCase()===needle):undefined;
 if(!person||!household||!/^\d{4}$/.test(args.pin))throw new SenderError('Check your name, invitation code, and four-digit PIN');
 const digest=demoPinDigest(person.id,args.pin);
 if(person.pinHash&&person.pinHash!==digest)throw new SenderError('Check your name, invitation code, and PIN');
 if(!person.pinHash&&!args.createPin)throw new SenderError('No PIN is set. Select First visit to create your PIN');
 joinHousehold(ctx,{inviteCode:household.inviteCode,name:person.personaKey});
 if(!person.pinHash)ctx.db.person.id.update({...person,pinHash:digest});
 const member=ctx.db.member.identity.find(ctx.sender)!;
 ctx.db.member.identity.update({...member,stepUpAt:ctx.timestamp,pinFailCount:0,pinLockedUntilMicros:0n});
});

export const {inviteFamily:inviteFamilyMember,acceptFamily:acceptFamilyInvitation,declineFamily:declineFamilyInvitation,revokeFamily:revokeFamilyInvitation,resendFamily:resendFamilyInvitation,invitationSettings:myInvitationSettings,outgoing:householdInvitations,inbox:myFamilyInvitations,sendEmail:sendFamilyInvitationEmail}=registerInvitations(spacetimedb);
export const registerAuthenticatedEmail=spacetimedb.reducer(ctx=>recordAuthenticatedEmail(ctx));
