import { schema, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import {
  envValue,
  requireAdmin,
  requireCoOwner,
  requireMember,
  requireStepUp,
  stepUpValidUntilMicros,
} from './auth';
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
