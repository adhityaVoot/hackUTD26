import { ScheduleAt, SenderError } from 'spacetimedb/server';
import { requireMember, requireStepUp, type Ctx } from './auth';
import { timestampAt } from './time';

const MAX_SECONDS = 90n * 24n * 60n * 60n;
const MIN_SECONDS = 60n;

function listed<T>(rows: Iterable<T>): T[] {
  const out: T[] = [];
  for (const row of rows) out.push(row);
  return out;
}

function schedule(ctx: Ctx, grantId: bigint, expiresAtMicros: bigint): void {
  ctx.db.grantExpiry.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(expiresAtMicros),
    grantId,
  });
}

function clearSchedules(ctx: Ctx, grantId: bigint): void {
  for (const row of listed(ctx.db.grantExpiry.iter())) {
    if (row.grantId === grantId) ctx.db.grantExpiry.scheduledId.delete(row.scheduledId);
  }
}

export function createGrant(
  ctx: Ctx,
  accountId: bigint,
  granteePersonId: bigint,
  level: string,
  durationSeconds: bigint,
  historyWindowDays: number,
): void {
  const me = requireStepUp(ctx, requireMember(ctx));
  const account = ctx.db.account.id.find(accountId);
  if (!account || account.ownerPersonId !== me.person.id) throw new SenderError('You can only share an account you own');
  if (level !== 'signal' && level !== 'summary' && level !== 'full') throw new SenderError('Unknown share level');
  if (durationSeconds < MIN_SECONDS || durationSeconds > MAX_SECONDS) {
    throw new SenderError('Duration must be between 60 seconds and 90 days');
  }
  const expiresAtMicros = ctx.timestamp.microsSinceUnixEpoch + durationSeconds * 1_000_000n;
  const grant = ctx.db.grant.insert({
    id: 0n,
    householdId: me.household.id,
    accountId,
    grantorPersonId: me.person.id,
    granteePersonId,
    granteeIdentityHex: '',
    level,
    historyWindowDays,
    expiresAt: timestampAt(ctx.timestamp, expiresAtMicros),
    status: 'active',
    createdAt: ctx.timestamp,
  });
  schedule(ctx, grant.id, expiresAtMicros);
  ctx.db.consentLog.insert({
    id: 0n,
    householdId: me.household.id,
    actorPersonId: me.person.id,
    accountId,
    action: 'grant_created',
    detail: `${level} for ${durationSeconds.toString()} seconds`,
    at: ctx.timestamp,
  });
}

export function revokeGrant(ctx: Ctx, grantId: bigint): void {
  const me = requireMember(ctx);
  const grant = ctx.db.grant.id.find(grantId);
  if (!grant || grant.grantorPersonId !== me.person.id) throw new SenderError('Grant not found');
  ctx.db.grant.id.update({ ...grant, status: 'revoked' });
  clearSchedules(ctx, grantId);
  ctx.db.consentLog.insert({
    id: 0n,
    householdId: me.household.id,
    actorPersonId: me.person.id,
    accountId: grant.accountId,
    action: 'grant_revoked',
    detail: 'revoked',
    at: ctx.timestamp,
  });
}

export function renewGrant(ctx: Ctx, grantId: bigint, durationSeconds: bigint): void {
  const me = requireStepUp(ctx, requireMember(ctx));
  const grant = ctx.db.grant.id.find(grantId);
  if (!grant || grant.grantorPersonId !== me.person.id) throw new SenderError('Grant not found');
  if (durationSeconds < MIN_SECONDS || durationSeconds > MAX_SECONDS) {
    throw new SenderError('Duration must be between 60 seconds and 90 days');
  }
  const expiresAtMicros = ctx.timestamp.microsSinceUnixEpoch + durationSeconds * 1_000_000n;
  ctx.db.grant.id.update({
    ...grant,
    status: 'active',
    expiresAt: timestampAt(ctx.timestamp, expiresAtMicros),
  });
  clearSchedules(ctx, grantId);
  schedule(ctx, grantId, expiresAtMicros);
  ctx.db.consentLog.insert({
    id: 0n,
    householdId: me.household.id,
    actorPersonId: me.person.id,
    accountId: grant.accountId,
    action: 'grant_renewed',
    detail: `${durationSeconds.toString()} seconds`,
    at: ctx.timestamp,
  });
}
