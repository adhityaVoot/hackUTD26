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
import { seedDemo } from './seed';
import { timestampAt } from './time';
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
  },
  {
    env: {
      AI_API_KEY: t.string().optional(),
      AI_BASE_URL: t.string().optional(),
      AI_MODEL: t.string().optional(),
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
  { inviteCode: t.string(), personaKey: t.string() },
  (ctx, { inviteCode, personaKey }) => {
    // The invite code is the secret. The caller is not a member yet.
    const code = inviteCode.trim();
    const key = personaKey.trim();
    if (code === '' || key === '') {
      throw new SenderError('Invite code and persona are required');
    }
    const household = ctx.db.household.inviteCode.find(code);
    if (!household) throw new SenderError('Invite code is not valid');
    let person = undefined;
    for (const row of ctx.db.person.householdId.filter(household.id)) {
      if (row.personaKey === key) person = row;
    }
    if (!person) throw new SenderError('That person is not in this household');

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
    const grant = ctx.db.grant.id.find(arg.grantId);
    if (!grant || grant.status === 'expired' || grant.status === 'revoked') return;
    ctx.db.grant.id.update({ ...grant, status: 'expired' });
    ctx.db.consentLog.insert({
      id: 0n,
      householdId: grant.householdId,
      actorPersonId: grant.grantorPersonId,
      accountId: grant.accountId,
      action: 'grant_expired',
      detail: 'signal access ended',
      at: ctx.timestamp,
    });
  },
);

