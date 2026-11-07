import { schema, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
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

type EnvKey =
  | 'AI_API_KEY'
  | 'AI_BASE_URL'
  | 'AI_MODEL'
  | 'NESSIE_API_KEY'
  | 'NESSIE_BASE_URL'
  | 'ADMIN_CODE';

/** Missing and empty env strings are both unset. spacetime.local.json uses "". */
function envValue(ctx: Ctx, key: EnvKey): string | undefined {
  const value = ctx.env[key];
  if (value == null || value === '') return undefined;
  return value;
}

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
