import { SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import type spacetimedb from './index';

/**
 * SDK type: `ReducerCtx` exported from `spacetimedb/server`
 * (re-exported from `spacetimedb/dist/lib/reducers.d.ts`).
 * Schema parameter: `InferSchema<typeof spacetimedb>`.
 */
export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

type EnvKey =
  | 'AI_API_KEY'
  | 'AI_BASE_URL'
  | 'AI_MODEL'
  | 'AI_NO_THINK'
  | 'AI_FALLBACK_API_KEY'
  | 'AI_FALLBACK_BASE_URL'
  | 'AI_FALLBACK_MODEL'
  | 'NESSIE_API_KEY'
  | 'NESSIE_BASE_URL'
  | 'ADMIN_CODE';

const STEP_UP_WINDOW_MICROS = 5n * 60n * 1_000_000n;

export function stepUpValidUntilMicros(stepUpAtMicros: bigint): bigint {
  return stepUpAtMicros + STEP_UP_WINDOW_MICROS;
}

/** Missing and empty env strings are both unset. spacetime.local.json uses "". */
export function envValue(ctx: Ctx, key: EnvKey): string | undefined {
  const value = ctx.env[key];
  if (value == null || value === '') return undefined;
  return value;
}

export function requireMember(ctx: Ctx) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member) throw new SenderError('You are not in a household');
  const person = ctx.db.person.id.find(member.personId);
  if (!person) throw new SenderError('Person not found');
  const household = ctx.db.household.id.find(member.householdId);
  if (!household) throw new SenderError('Household not found');
  return { member, person, household };
}

export function requireCoOwner(ctx: Ctx) {
  const me = requireMember(ctx);
  if (me.person.role !== 'coowner') {
    throw new SenderError('Co-owner access required');
  }
  return me;
}

export function requireStepUp(ctx: Ctx, me: ReturnType<typeof requireMember>) {
  const elapsed =
    ctx.timestamp.microsSinceUnixEpoch - me.member.stepUpAt.microsSinceUnixEpoch;
  if (elapsed < 0n || elapsed > STEP_UP_WINDOW_MICROS) {
    throw new SenderError('PIN required');
  }
  return me;
}

export function requireAdmin(ctx: Ctx, code: string): void {
  const expected = envValue(ctx, 'ADMIN_CODE');
  if (expected === undefined) {
    throw new SenderError('Admin access is not configured');
  }
  if (code !== expected) {
    throw new SenderError('Admin code is incorrect');
  }
}
