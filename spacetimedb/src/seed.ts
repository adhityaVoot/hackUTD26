import { ScheduleAt, SenderError } from 'spacetimedb/server';
import type { Ctx } from './auth';
import { DEMO_PATELS, DEMO_SEED, generateHousehold } from './engine/generator';
import type { Txn } from './engine/types';
import { recomputeScenario } from './recompute';
import { timestampAt } from './time';

const NINETY_DAYS_MICROS = 90n * 24n * 60n * 60n * 1_000_000n;

function list<T>(rows: Iterable<T>): T[] {
  const out: T[] = [];
  for (const row of rows) out.push(row);
  return out;
}

function cents(amount: number): bigint {
  return BigInt(Math.round(amount));
}

function must(map: Map<number, bigint>, id: number, label: string): bigint {
  const found = map.get(id);
  if (found === undefined) throw new SenderError(`Seed is missing ${label} ${id}`);
  return found;
}

function wipeHousehold(ctx: Ctx, householdId: bigint): void {
  for(const row of list(ctx.db.ageProfile.householdId.filter(householdId)))ctx.db.ageProfile.personId.delete(row.personId);
  for(const row of list(ctx.db.accountPrivacy.householdId.filter(householdId)))ctx.db.accountPrivacy.accountId.delete(row.accountId);
  for(const row of list(ctx.db.moneyRequest.householdId.filter(householdId)))ctx.db.moneyRequest.id.delete(row.id);
  const inviteIds=new Set(list(ctx.db.familyInvitation.householdId.filter(householdId)).map(row=>row.id));
  for(const job of list(ctx.db.invitationEmailJob.iter()))if(inviteIds.has(job.invitationId))ctx.db.invitationEmailJob.scheduledId.delete(job.scheduledId);
  for(const id of inviteIds)ctx.db.familyInvitation.id.delete(id);
  for(const row of list(ctx.db.personIdentity.householdId.filter(householdId)))ctx.db.personIdentity.personId.delete(row.personId);
  ctx.db.householdAccess.householdId.delete(householdId);
  const grantIds = new Set<bigint>();
  for (const row of ctx.db.grant.householdId.filter(householdId)) grantIds.add(row.id);
  for (const row of list(ctx.db.grantExpiry.iter())) {
    if (grantIds.has(row.grantId)) ctx.db.grantExpiry.scheduledId.delete(row.scheduledId);
  }

  for (const row of list(ctx.db.member.householdId.filter(householdId))) {
    ctx.db.member.identity.delete(row.identity);
  }
  for (const row of list(ctx.db.presence.householdId.filter(householdId))) {
    ctx.db.presence.identity.delete(row.identity);
  }
  for (const row of list(ctx.db.txn.householdId.filter(householdId))) {
    ctx.db.txn.id.delete(row.id);
  }
  for (const row of list(ctx.db.futureTxn.householdId.filter(householdId))) {
    ctx.db.futureTxn.id.delete(row.id);
  }
  for (const row of list(ctx.db.obligation.householdId.filter(householdId))) {
    ctx.db.obligation.id.delete(row.id);
  }
  for (const row of list(ctx.db.spendProfile.householdId.filter(householdId))) {
    ctx.db.spendProfile.id.delete(row.id);
  }
  for (const row of list(ctx.db.goal.householdId.filter(householdId))) {
    ctx.db.goal.id.delete(row.id);
  }
  for (const row of list(ctx.db.scenarioChange.householdId.filter(householdId))) {
    ctx.db.scenarioChange.id.delete(row.id);
  }
  for (const row of list(ctx.db.forecastDay.householdId.filter(householdId))) {
    ctx.db.forecastDay.id.delete(row.id);
  }
  for (const row of list(ctx.db.vital.householdId.filter(householdId))) {
    ctx.db.vital.id.delete(row.id);
  }
  for (const row of list(ctx.db.approval.householdId.filter(householdId))) {
    ctx.db.approval.id.delete(row.id);
  }
  for (const row of list(ctx.db.commitment.householdId.filter(householdId))) {
    ctx.db.commitment.id.delete(row.id);
  }
  for (const row of list(ctx.db.alert.householdId.filter(householdId))) {
    ctx.db.alert.id.delete(row.id);
  }
  for (const row of list(ctx.db.grant.householdId.filter(householdId))) {
    ctx.db.grant.id.delete(row.id);
  }
  for (const row of list(ctx.db.scenario.householdId.filter(householdId))) {
    ctx.db.scenario.id.delete(row.id);
  }
  for (const row of list(ctx.db.account.householdId.filter(householdId))) {
    ctx.db.account.id.delete(row.id);
  }
  for (const row of list(ctx.db.person.householdId.filter(householdId))) {
    ctx.db.person.id.delete(row.id);
  }
  for (const row of list(ctx.db.aiRun.householdId.filter(householdId))) {
    ctx.db.aiRun.id.delete(row.id);
  }
  for (const row of list(ctx.db.nessieMap.householdId.filter(householdId))) {
    ctx.db.nessieMap.id.delete(row.id);
  }
  const usage = ctx.db.aiUsage.householdId.find(householdId);
  if (usage) ctx.db.aiUsage.householdId.delete(householdId);
  const nessie = ctx.db.nessieStatus.householdId.find(householdId);
  if (nessie) ctx.db.nessieStatus.householdId.delete(householdId);
  for (const row of list(ctx.db.clockTick.iter())) {
    if (row.householdId === householdId) ctx.db.clockTick.scheduledId.delete(row.scheduledId);
  }
  for (const row of list(ctx.db.nessieJob.iter())) {
    if (row.householdId === householdId) ctx.db.nessieJob.scheduledId.delete(row.scheduledId);
  }
  ctx.db.household.id.delete(householdId);
}

function insertTxn(ctx: Ctx, householdId: bigint, accountIds: Map<number, bigint>, txn: Txn): void {
  ctx.db.txn.insert({
    id: 0n,
    householdId,
    accountId: must(accountIds, txn.accountId, 'account'),
    day: txn.day,
    amountCents: cents(txn.amountCents),
    category: txn.category,
    merchantCode: txn.merchantCode,
    rawDescription: txn.rawDescription,
    nessieId: '',
  });
}

export function seedDemo(ctx: Ctx, inviteCode: string): void {
  const existing = ctx.db.household.inviteCode.find(inviteCode);
  if (existing) wipeHousehold(ctx, existing.id);

  const generated = generateHousehold(DEMO_PATELS, DEMO_SEED);
  const household = ctx.db.household.insert({
    id: 0n,
    name: DEMO_PATELS.householdName,
    inviteCode,
    cosignThresholdCents: 50_000n,
    baselineScenarioId: 0n,
    simDay: 0,
    clockScheduleId: 0n,
    secondsPerDay: 0,
    aiEnabled: true,
    isBot: false,
    seed: BigInt(DEMO_SEED),
    createdAt: ctx.timestamp,
  });

  const personIds = new Map<number, bigint>();
  for (const person of generated.persons) {
    const row = ctx.db.person.insert({
      id: 0n,
      householdId: household.id,
      displayName: person.displayName,
      role: person.role,
      personaKey: person.personaKey,
      pinHash: '',
    });
    // Demo fixture: the parents are adults; Maya is under 18 so owner supervision of her account is visible.
    const birthDate = person.role === 'coowner' ? (person.personaKey === 'sam' ? '1984-06-12' : '1986-03-03') : '2009-01-01';
    ctx.db.ageProfile.insert({personId:row.id,householdId:household.id,birthDate});
    personIds.set(person.id, row.id);
  }

  const accountIds = new Map<number, bigint>();
  for (const account of generated.accounts) {
    const row = ctx.db.account.insert({
      id: 0n,
      householdId: household.id,
      ownerPersonId:
        account.ownerPersonId === 0 ? 0n : must(personIds, account.ownerPersonId, 'person'),
      isJoint: account.isJoint,
      kind: account.kind,
      nickname: account.nickname,
      balanceCents: cents(account.balanceCents),
      limitCents: cents(account.limitCents),
      aprBps: account.aprBps,
      bufferCents: cents(account.bufferCents),
      maturityDay: account.maturityDay,
      nessieId: '',
    });
    accountIds.set(account.id, row.id);
  }

  for (const txn of generated.history) insertTxn(ctx, household.id, accountIds, txn);
  for (const txn of generated.future) {
    ctx.db.futureTxn.insert({
      id: 0n,
      householdId: household.id,
      accountId: must(accountIds, txn.accountId, 'account'),
      day: txn.day,
      amountCents: cents(txn.amountCents),
      category: txn.category,
      merchantCode: txn.merchantCode,
      rawDescription: txn.rawDescription,
    });
  }

  for (const obligation of generated.obligations) {
    ctx.db.obligation.insert({
      id: 0n,
      householdId: household.id,
      accountId: must(accountIds, obligation.accountId, 'account'),
      kind: obligation.kind,
      label: obligation.label,
      amountCents: cents(obligation.amountCents),
      cadence: obligation.cadence,
      anchorDay: obligation.anchorDay,
      flexible: obligation.flexible,
      active: true,
      nessieId: '',
    });
  }

  for (const profile of generated.spendProfiles) {
    ctx.db.spendProfile.insert({
      id: 0n,
      householdId: household.id,
      accountId: must(accountIds, profile.accountId, 'account'),
      category: profile.category,
      dailyProb: profile.dailyProb,
      logMean: profile.logMean,
      logSd: profile.logSd,
      weekendMult: profile.weekendMult,
    });
  }

  for (const goal of generated.goals) {
    ctx.db.goal.insert({
      id: 0n,
      householdId: household.id,
      ownerPersonId: goal.ownerPersonId === 0 ? 0n : must(personIds, goal.ownerPersonId, 'person'),
      name: goal.name,
      targetCents: cents(goal.targetCents),
      targetDay: goal.targetDay,
      accountId: must(accountIds, goal.accountId, 'account'),
    });
  }

  const scenario = ctx.db.scenario.insert({
    id: 0n,
    householdId: household.id,
    parentId: 0n,
    authorPersonId: 0n,
    agentKind: '',
    title: 'Baseline',
    explanation: 'Starting plan for the Patel household.',
    status: 'baseline',
    scope: 'household',
    audiencePersonId: 0n,
    createdAt: ctx.timestamp,
    computedAtDay: 0,
  });
  ctx.db.household.id.update({ ...household, baselineScenarioId: scenario.id });
  recomputeScenario(ctx, scenario.id);

  const signal = generated.accounts.find(account => account.shareLevel === 'signal');
  if (!signal) throw new SenderError('Demo seed is missing the signal account');
  const signalAccountId = must(accountIds, signal.id, 'account');
  const grantorPersonId = must(personIds, signal.ownerPersonId, 'person');
  const expiresAt = timestampAt(
    ctx.timestamp,
    ctx.timestamp.microsSinceUnixEpoch + NINETY_DAYS_MICROS,
  );
  const grant = ctx.db.grant.insert({
    id: 0n,
    householdId: household.id,
    accountId: signalAccountId,
    grantorPersonId,
    granteePersonId: 0n,
    granteeIdentityHex: '',
    level: 'signal',
    historyWindowDays: 90,
    expiresAt,
    status: 'active',
    createdAt: ctx.timestamp,
  });
  ctx.db.grantExpiry.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(expiresAt.microsSinceUnixEpoch),
    grantId: grant.id,
  });
  ctx.db.consentLog.insert({
    id: 0n,
    householdId: household.id,
    actorPersonId: grantorPersonId,
    accountId: signalAccountId,
    action: 'grant_created',
    detail: `signal on ${signal.nickname} for 90 days`,
    at: ctx.timestamp,
  });
}
