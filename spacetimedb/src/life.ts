import { SenderError } from 'spacetimedb/server';
import { requireCoOwner, requireMember, requireStepUp, type Ctx } from './auth';
import { isoToSimDay } from './engine/calendar';
import { profileFromMonthly, projectFuture } from './engine/fit';
import type { Obligation, SpendProfile } from './engine/types';
import { recomputeScenario } from './recompute';
import { timestampAt } from './time';

const KINDS = ['checking', 'savings', 'credit_card', 'cd', 'ira', 'auto_loan', 'personal_loan', 'mortgage'];
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function listed<T>(rows: Iterable<T>): T[] {
  const out: T[] = [];
  for (const row of rows) out.push(row);
  return out;
}

function inviteCode(ctx: Ctx): string {
  let code = '';
  for (let i = 0; i < 6; i += 1) code += ALPHABET[ctx.random.integerInRange(0, ALPHABET.length - 1)];
  return code;
}

function baseline(ctx: Ctx, householdId: bigint) {
  const household = ctx.db.household.id.find(householdId);
  if (!household || household.baselineScenarioId === 0n) return;
  recomputeScenario(ctx, household.baselineScenarioId);
}

function canFull(ctx: Ctx, accountId: bigint, personId: bigint, householdId: bigint): boolean {
  const account = ctx.db.account.id.find(accountId);
  if (!account || account.householdId !== householdId) return false;
  if (account.isJoint || account.ownerPersonId === personId) return true;
  return listed(ctx.db.grant.accountId.filter(accountId)).some(
    grant => grant.status === 'active' && grant.level === 'full' && grant.granteePersonId === personId,
  );
}

export function createHousehold(ctx: Ctx, name: string, myDisplayName: string): void {
  if (ctx.db.member.identity.find(ctx.sender)) throw new SenderError('You are already in a household');
  const trimmed = name.trim();
  const mine = myDisplayName.trim();
  if (trimmed === '' || mine === '') throw new SenderError('Household name and your name are required');
  let code = inviteCode(ctx);
  for (let attempt = 0; attempt < 5 && ctx.db.household.inviteCode.find(code); attempt += 1) code = inviteCode(ctx);
  if (ctx.db.household.inviteCode.find(code)) throw new SenderError('Could not create an invite code');
  const household = ctx.db.household.insert({
    id: 0n,
    name: trimmed,
    inviteCode: code,
    cosignThresholdCents: 50_000n,
    baselineScenarioId: 0n,
    simDay: 0,
    clockScheduleId: 0n,
    secondsPerDay: 0,
    aiEnabled: true,
    seed: BigInt(ctx.random.uint32()),
    createdAt: ctx.timestamp,
    isBot: false,
  });
  const person = ctx.db.person.insert({
    id: 0n,
    householdId: household.id,
    displayName: mine,
    role: 'coowner',
    personaKey: mine.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'owner',
    pinHash: '',
  });
  ctx.db.member.insert({
    identity: ctx.sender,
    householdId: household.id,
    personId: person.id,
    kind: 'person',
    online: true,
    lastActiveAt: ctx.timestamp,
    stepUpAt: timestampAt(ctx.timestamp, 0n),
    pinFailCount: 0,
    pinFailWindowStartMicros: 0n,
    pinLockedUntilMicros: 0n,
  });
  const scenario = ctx.db.scenario.insert({
    id: 0n,
    householdId: household.id,
    parentId: 0n,
    authorPersonId: 0n,
    agentKind: '',
    title: 'Baseline',
    explanation: '',
    status: 'baseline',
    scope: 'household',
    audiencePersonId: 0n,
    createdAt: ctx.timestamp,
    computedAtDay: 0,
  });
  ctx.db.household.id.update({ ...household, baselineScenarioId: scenario.id });
  recomputeScenario(ctx, scenario.id);
}

export function addPerson(ctx: Ctx, displayName: string, role: string): void {
  const me = requireCoOwner(ctx);
  const name = displayName.trim();
  if (name === '' || (role !== 'coowner' && role !== 'member')) {
    throw new SenderError('Name and role (coowner or member) are required');
  }
  ctx.db.person.insert({
    id: 0n,
    householdId: me.household.id,
    displayName: name,
    role,
    personaKey: name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'person',
    pinHash: '',
  });
}

export function addAccount(
  ctx: Ctx,
  kind: string,
  nickname: string,
  isJoint: boolean,
  ownerPersonId: bigint,
  balanceCents: bigint,
  limitCents: bigint,
  aprBps: number,
  bufferCents: bigint,
  maturityDay: number,
): void {
  const me = requireMember(ctx);
  if (!KINDS.includes(kind)) throw new SenderError('Unknown account type');
  if (isJoint && me.person.role !== 'coowner') throw new SenderError('Only a co-owner can add a joint account');
  if (!isJoint && ownerPersonId !== me.person.id) throw new SenderError('You can only add your own account');
  const buffer = kind === 'checking' && bufferCents === 0n ? 20_000n : bufferCents;
  ctx.db.account.insert({
    id: 0n,
    householdId: me.household.id,
    ownerPersonId: isJoint ? 0n : ownerPersonId,
    isJoint,
    kind,
    nickname: nickname.trim() || kind,
    balanceCents,
    limitCents,
    aprBps,
    bufferCents: buffer,
    maturityDay,
    nessieId: '',
  });
  baseline(ctx, me.household.id);
}

export function updateAccount(
  ctx: Ctx,
  accountId: bigint,
  nickname: string,
  balanceCents: bigint,
  limitCents: bigint,
  aprBps: number,
  bufferCents: bigint,
): void {
  const me = requireMember(ctx);
  const account = ctx.db.account.id.find(accountId);
  if (!account || account.householdId !== me.household.id) throw new SenderError('Account not found');
  const allowed = account.isJoint ? me.person.role === 'coowner' : account.ownerPersonId === me.person.id;
  if (!allowed) throw new SenderError('You cannot edit this account');
  ctx.db.account.id.update({
    ...account,
    nickname: nickname.trim() || account.nickname,
    balanceCents,
    limitCents,
    aprBps,
    bufferCents,
  });
  baseline(ctx, me.household.id);
}

export function removeAccount(ctx: Ctx, accountId: bigint): void {
  const me = requireMember(ctx);
  const account = ctx.db.account.id.find(accountId);
  if (!account || account.householdId !== me.household.id) throw new SenderError('Account not found');
  const allowed = account.isJoint ? me.person.role === 'coowner' : account.ownerPersonId === me.person.id;
  if (!allowed) throw new SenderError('You cannot remove this account');
  ctx.db.account.id.delete(accountId);
  baseline(ctx, me.household.id);
}

export function addObligation(
  ctx: Ctx,
  accountId: bigint,
  kind: string,
  label: string,
  amountCents: bigint,
  cadence: string,
  anchorDate: string,
  flexible: boolean,
): void {
  const me = requireMember(ctx);
  if (!canFull(ctx, accountId, me.person.id, me.household.id)) throw new SenderError('That account is not fully visible');
  ctx.db.obligation.insert({
    id: 0n,
    householdId: me.household.id,
    accountId,
    kind,
    label: label.trim() || kind,
    amountCents,
    cadence,
    anchorDay: isoToSimDay(anchorDate),
    flexible,
    active: true,
    nessieId: '',
  });
  refreshFuture(ctx, me.household.id);
  baseline(ctx, me.household.id);
}

export function removeObligation(ctx: Ctx, obligationId: bigint): void {
  const me = requireMember(ctx);
  const row = ctx.db.obligation.id.find(obligationId);
  if (!row || !canFull(ctx, row.accountId, me.person.id, me.household.id)) {
    throw new SenderError('Bill not found');
  }
  ctx.db.obligation.id.delete(obligationId);
  baseline(ctx, me.household.id);
}

export function addGoal(
  ctx: Ctx,
  name: string,
  targetCents: bigint,
  targetDate: string,
  accountId: bigint,
  shared: boolean,
): void {
  const me = requireMember(ctx);
  if (!canFull(ctx, accountId, me.person.id, me.household.id)) throw new SenderError('That account is not fully visible');
  ctx.db.goal.insert({
    id: 0n,
    householdId: me.household.id,
    ownerPersonId: shared ? 0n : me.person.id,
    name: name.trim() || 'Goal',
    targetCents,
    targetDay: isoToSimDay(targetDate),
    accountId,
  });
  baseline(ctx, me.household.id);
}

export function removeGoal(ctx: Ctx, goalId: bigint): void {
  const me = requireMember(ctx);
  const goal = ctx.db.goal.id.find(goalId);
  if (!goal || goal.householdId !== me.household.id) throw new SenderError('Goal not found');
  if (goal.ownerPersonId !== 0n && goal.ownerPersonId !== me.person.id && me.person.role !== 'coowner') {
    throw new SenderError('You cannot remove this goal');
  }
  ctx.db.goal.id.delete(goalId);
  baseline(ctx, me.household.id);
}

export function addTransaction(
  ctx: Ctx,
  accountId: bigint,
  dateISO: string,
  amountCents: bigint,
  category: string,
  description: string,
): void {
  const me = requireMember(ctx);
  if (!canFull(ctx, accountId, me.person.id, me.household.id)) throw new SenderError('That account is not fully visible');
  ctx.db.txn.insert({
    id: 0n,
    householdId: me.household.id,
    accountId,
    day: isoToSimDay(dateISO),
    amountCents,
    category,
    merchantCode: `${category.toUpperCase()}_000`,
    rawDescription: description,
    nessieId: '',
  });
  const account = ctx.db.account.id.find(accountId);
  if (account) ctx.db.account.id.update({ ...account, balanceCents: account.balanceCents + amountCents });
  baseline(ctx, me.household.id);
}

export function setMonthlySpending(ctx: Ctx, accountId: bigint, category: string, monthlyCents: bigint): void {
  const me = requireMember(ctx);
  if (!canFull(ctx, accountId, me.person.id, me.household.id)) throw new SenderError('That account is not fully visible');
  const profile = profileFromMonthly(Number(accountId), category, Number(monthlyCents));
  const existing = listed(ctx.db.spendProfile.householdId.filter(me.household.id)).find(
    row => row.accountId === accountId && row.category === category,
  );
  if (existing) {
    ctx.db.spendProfile.id.update({
      ...existing,
      dailyProb: profile.dailyProb,
      logMean: profile.logMean,
      logSd: profile.logSd,
      weekendMult: profile.weekendMult,
    });
  } else {
    ctx.db.spendProfile.insert({
      id: 0n,
      householdId: me.household.id,
      accountId,
      category,
      dailyProb: profile.dailyProb,
      logMean: profile.logMean,
      logSd: profile.logSd,
      weekendMult: profile.weekendMult,
    });
  }
  refreshFuture(ctx, me.household.id);
  baseline(ctx, me.household.id);
}

function refreshFuture(ctx: Ctx, householdId: bigint): void {
  const existing = listed(ctx.db.futureTxn.householdId.filter(householdId));
  if (existing.length > 0) return;
  const household = ctx.db.household.id.find(householdId);
  if (!household) return;
  const obligations: Obligation[] = listed(ctx.db.obligation.householdId.filter(householdId)).map(row => ({
    id: Number(row.id),
    accountId: Number(row.accountId),
    kind: row.kind,
    label: row.label,
    amountCents: Number(row.amountCents),
    cadence: row.cadence as Obligation['cadence'],
    anchorDay: row.anchorDay,
    flexible: row.flexible,
  }));
  const spend: SpendProfile[] = listed(ctx.db.spendProfile.householdId.filter(householdId)).map(row => ({
    id: Number(row.id),
    accountId: Number(row.accountId),
    category: row.category,
    dailyProb: row.dailyProb,
    logMean: row.logMean,
    logSd: row.logSd,
    weekendMult: row.weekendMult,
  }));
  const accounts = listed(ctx.db.account.householdId.filter(householdId)).map(row => ({
    id: Number(row.id),
    kind: row.kind,
  }));
  for (const txn of projectFuture(obligations, spend, accounts, Number(household.seed), household.simDay, household.simDay + 59)) {
    ctx.db.futureTxn.insert({
      id: 0n,
      householdId,
      accountId: BigInt(txn.accountId),
      day: txn.day,
      amountCents: BigInt(txn.amountCents),
      category: txn.category,
      merchantCode: txn.merchantCode,
      rawDescription: txn.rawDescription,
    });
  }
}

export function setAiEnabled(ctx: Ctx, enabled: boolean): void {
  const me = requireStepUp(ctx, requireCoOwner(ctx));
  ctx.db.household.id.update({ ...me.household, aiEnabled: enabled });
  ctx.db.agentLog.insert({
    id: 0n,
    householdId: me.household.id,
    runId: 0n,
    step: 'kill_switch',
    detail: enabled ? 'AI enabled' : 'AI disabled',
    flagged: false,
    at: ctx.timestamp,
  });
}
