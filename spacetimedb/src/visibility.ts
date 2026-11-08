import { t, type InferSchema, type ViewCtx } from 'spacetimedb/server';
import type spacetimedb from './index';

type Ctx = ViewCtx<InferSchema<typeof spacetimedb>>;
type Db = Ctx['db'];
type MemberRow = NonNullable<ReturnType<Db['member']['identity']['find']>>;
type AccountRow = NonNullable<ReturnType<Db['account']['id']['find']>>;
type GrantRow = NonNullable<ReturnType<Db['grant']['id']['find']>>;

export type Visibility = 'full' | 'summary' | 'none';

export const householdSessionRow = t.row('HouseholdSession', {
  id: t.u64().primaryKey(),
  name: t.string(),
  simDay: t.i32(),
  aiEnabled: t.bool(),
  clockRunning: t.bool(),
  cosignThresholdCents: t.i64(),
  baselineScenarioId: t.u64(),
});

export const inviteCodeRow = t.row('InviteCode', {
  inviteCode: t.string().primaryKey(),
});

export const householdPersonRow = t.row('HouseholdPerson', {
  id: t.u64().primaryKey(),
  displayName: t.string(),
  role: t.string(),
  personaKey: t.string(),
  online: t.bool(),
});

export const accountViewRow = t.row('AccountView', {
  id: t.u64().primaryKey(),
  nickname: t.string(),
  kind: t.string(),
  isJoint: t.bool(),
  ownerPersonId: t.u64(),
  visibility: t.string(),
  balanceCents: t.i64(),
  limitCents: t.i64(),
  aprBps: t.i32(),
});

export const txnViewRow = t.row('TxnView', {
  id: t.u64().primaryKey(),
  accountId: t.u64(),
  day: t.i32(),
  amountCents: t.i64(),
  category: t.string(),
  merchantCode: t.string(),
  rawDescription: t.string(),
});

export const obligationViewRow = t.row('ObligationView', {
  id: t.u64().primaryKey(),
  accountId: t.u64(),
  kind: t.string(),
  label: t.string(),
  amountCents: t.i64(),
  cadence: t.string(),
  anchorDay: t.i32(),
  flexible: t.bool(),
  active: t.bool(),
});

export const grantViewRow = t.row('GrantView', {
  id: t.u64().primaryKey(),
  accountId: t.u64(),
  grantorPersonId: t.u64(),
  granteePersonId: t.u64(),
  level: t.string(),
  historyWindowDays: t.i32(),
  expiresAt: t.timestamp(),
  status: t.string(),
});

export const consentEntryRow = t.row('ConsentEntry', {
  id: t.u64().primaryKey(),
  actorPersonId: t.u64(),
  accountId: t.u64(),
  action: t.string(),
  detail: t.string(),
  at: t.timestamp(),
});

function listed<T>(rows: Iterable<T>): T[] {
  const out: T[] = [];
  for (const row of rows) out.push(row);
  return out;
}

function activeGrants(ctx: Ctx, accountId: bigint): GrantRow[] {
  return listed(ctx.db.grant.accountId.filter(accountId)).filter(
    grant => grant.status === 'active',
  );
}

function identityHex(ctx: Ctx): string {
  return ctx.sender.toHexString();
}

/** Whole-household signal grants use granteePersonId 0 and an empty banker hex. */
function grantApplies(ctx: Ctx, me: MemberRow, grant: GrantRow): boolean {
  if (grant.granteeIdentityHex !== '' && grant.granteeIdentityHex === identityHex(ctx)) {
    return true;
  }
  if (me.personId === 0n) return false;
  if (grant.grantorPersonId === me.personId) return true;
  if (grant.granteePersonId === me.personId) return true;
  return grant.granteePersonId === 0n && grant.granteeIdentityHex === '';
}

function levelOf(grant: GrantRow): Visibility {
  if (grant.level === 'full') return 'full';
  if (grant.level === 'summary') return 'summary';
  return 'none';
}

/**
 * Joint accounts are fully visible to people in the household.
 * Bankers get summary only when an active banker grant names their identity.
 * Signal grants do not reveal rows.
 */
export function canSee(ctx: Ctx, me: MemberRow, account: AccountRow): Visibility {
  if (account.isJoint) {
    if (me.kind !== 'banker') return 'full';
    const allowed = activeGrants(ctx, account.id).some(
      grant => grant.granteeIdentityHex !== '' && grant.granteeIdentityHex === identityHex(ctx),
    );
    return allowed ? 'summary' : 'none';
  }
  if (me.personId !== 0n && account.ownerPersonId === me.personId) return 'full';
  const grant = activeGrants(ctx, account.id).find(row => grantApplies(ctx, me, row));
  if (!grant) return 'none';
  return levelOf(grant);
}

function memberOf(ctx: Ctx): MemberRow | undefined {
  return ctx.db.member.identity.find(ctx.sender) ?? undefined;
}

export function readMyHousehold(ctx: Ctx) {
  const me = memberOf(ctx);
  if (!me) return undefined;
  const household = ctx.db.household.id.find(me.householdId);
  if (!household) return undefined;
  return {
    id: household.id,
    name: household.name,
    simDay: household.simDay,
    aiEnabled: household.aiEnabled,
    clockRunning: household.clockScheduleId !== 0n,
    cosignThresholdCents: household.cosignThresholdCents,
    baselineScenarioId: household.baselineScenarioId,
  };
}

export function readMyInviteCode(ctx: Ctx) {
  const me = memberOf(ctx);
  if (!me || me.personId === 0n) return undefined;
  const person = ctx.db.person.id.find(me.personId);
  if (!person || person.role !== 'coowner') return undefined;
  const household = ctx.db.household.id.find(me.householdId);
  if (!household) return undefined;
  return { inviteCode: household.inviteCode };
}

export function readHouseholdPeople(ctx: Ctx) {
  const me = memberOf(ctx);
  if (!me) return [];
  return listed(ctx.db.person.householdId.filter(me.householdId)).map(person => {
    const devices = listed(ctx.db.member.personId.filter(person.id));
    return {
      id: person.id,
      displayName: person.displayName,
      role: person.role,
      personaKey: person.personaKey,
      online: devices.some(device => device.online),
    };
  });
}

export function readMyAccounts(ctx: Ctx) {
  const me = memberOf(ctx);
  if (!me) return [];
  const views = [];
  for (const account of listed(ctx.db.account.householdId.filter(me.householdId))) {
    const visibility = canSee(ctx, me, account);
    if (visibility === 'none') continue;
    const summary = visibility === 'summary';
    views.push({
      id: account.id,
      nickname: account.nickname,
      kind: account.kind,
      isJoint: summary ? false : account.isJoint,
      ownerPersonId: summary ? 0n : account.ownerPersonId,
      visibility,
      balanceCents: account.balanceCents,
      limitCents: summary ? 0n : account.limitCents,
      aprBps: summary ? 0 : account.aprBps,
    });
  }
  return views;
}

export function readMyTxns(ctx: Ctx) {
  const me = memberOf(ctx);
  if (!me) return [];
  const household = ctx.db.household.id.find(me.householdId);
  if (!household) return [];
  const txns = [];
  for (const account of listed(ctx.db.account.householdId.filter(me.householdId))) {
    if (canSee(ctx, me, account) !== 'full') continue;
    const owner = me.personId !== 0n && account.ownerPersonId === me.personId;
    const windowGrant =
      owner || (account.isJoint && me.kind !== 'banker')
        ? undefined
        : activeGrants(ctx, account.id).find(
            grant => grant.level === 'full' && grantApplies(ctx, me, grant),
          );
    const floor =
      windowGrant === undefined
        ? undefined
        : household.simDay - windowGrant.historyWindowDays;
    for (const txn of listed(ctx.db.txn.accountId.filter(account.id))) {
      if (floor !== undefined && txn.day < floor) continue;
      txns.push({
        id: txn.id,
        accountId: txn.accountId,
        day: txn.day,
        amountCents: txn.amountCents,
        category: txn.category,
        merchantCode: txn.merchantCode,
        rawDescription: owner ? txn.rawDescription : '',
      });
    }
  }
  return txns;
}

export function readMyObligations(ctx: Ctx) {
  const me = memberOf(ctx);
  if (!me) return [];
  const obligations = [];
  for (const account of listed(ctx.db.account.householdId.filter(me.householdId))) {
    if (canSee(ctx, me, account) !== 'full') continue;
    for (const obligation of listed(ctx.db.obligation.accountId.filter(account.id))) {
      obligations.push({
        id: obligation.id,
        accountId: obligation.accountId,
        kind: obligation.kind,
        label: obligation.label,
        amountCents: obligation.amountCents,
        cadence: obligation.cadence,
        anchorDay: obligation.anchorDay,
        flexible: obligation.flexible,
        active: obligation.active,
      });
    }
  }
  return obligations;
}

export function readMyGrants(ctx: Ctx) {
  const me = memberOf(ctx);
  if (!me) return [];
  return listed(ctx.db.grant.householdId.filter(me.householdId))
    .filter(grant => grantApplies(ctx, me, grant))
    .map(grant => ({
      id: grant.id,
      accountId: grant.accountId,
      grantorPersonId: grant.grantorPersonId,
      granteePersonId: grant.granteePersonId,
      level: grant.level,
      historyWindowDays: grant.historyWindowDays,
      expiresAt: grant.expiresAt,
      status: grant.status,
    }));
}

function allowedScenarioIds(ctx: Ctx, householdId: bigint, personId: bigint): Set<bigint> {
  const ids = new Set<bigint>();
  for (const row of listed(ctx.db.scenario.householdId.filter(householdId))) {
    if (row.scope === 'household' || row.audiencePersonId === personId || row.authorPersonId === personId) {
      ids.add(row.id);
    }
  }
  return ids;
}

export function readHouseholdScenarios(ctx: Ctx) {
  const me = memberOf(ctx);
  if (!me) return [];
  return listed(ctx.db.scenario.householdId.filter(me.householdId)).filter(
    row =>
      row.scope === 'household' ||
      row.audiencePersonId === me.personId ||
      row.authorPersonId === me.personId,
  );
}

export function readScenarioChanges(ctx: Ctx) {
  const me = memberOf(ctx);
  if (!me) return [];
  const allowed = allowedScenarioIds(ctx, me.householdId, me.personId);
  return listed(ctx.db.scenarioChange.householdId.filter(me.householdId)).filter(row =>
    allowed.has(row.scenarioId),
  );
}

export function readMyForecast(ctx: Ctx) {
  const me = memberOf(ctx);
  if (!me) return [];
  const allowed = allowedScenarioIds(ctx, me.householdId, me.personId);
  const full = new Set<bigint>();
  for (const account of listed(ctx.db.account.householdId.filter(me.householdId))) {
    if (canSee(ctx, me, account) === 'full') full.add(account.id);
  }
  return listed(ctx.db.forecastDay.householdId.filter(me.householdId)).filter(
    row => allowed.has(row.scenarioId) && (row.accountId === 0n || full.has(row.accountId)),
  );
}

export function readMyVitals(ctx: Ctx) {
  const me = memberOf(ctx);
  if (!me) return [];
  const allowed = allowedScenarioIds(ctx, me.householdId, me.personId);
  return listed(ctx.db.vital.householdId.filter(me.householdId)).filter(
    row =>
      allowed.has(row.scenarioId) &&
      (row.scopePersonId === 0n || row.scopePersonId === me.personId),
  );
}

export function readHouseholdConsentLog(ctx: Ctx) {
  const me = memberOf(ctx);
  if (!me) return [];
  return listed(ctx.db.consentLog.householdId.filter(me.householdId)).map(entry => ({
    id: entry.id,
    actorPersonId: entry.actorPersonId,
    accountId: entry.accountId,
    action: entry.action,
    detail: entry.detail,
    at: entry.at,
  }));
}
