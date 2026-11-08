import { SenderError } from 'spacetimedb/server';
import { requireCoOwner, requireMember, requireStepUp, type Ctx } from './auth';
import { classify } from './engine/scope';
import { validateChange } from './engine/levers';
import type { Change } from './engine/types';
import { recomputeScenario } from './recompute';

function listed<T>(rows: Iterable<T>): T[] {
  const out: T[] = [];
  for (const row of rows) out.push(row);
  return out;
}

function fullAccountIds(ctx: Ctx, householdId: bigint, personId: bigint, kind: string): number[] {
  const ids: number[] = [];
  for (const account of listed(ctx.db.account.householdId.filter(householdId))) {
    if (account.isJoint && kind !== 'banker') ids.push(Number(account.id));
    else if (personId !== 0n && account.ownerPersonId === personId) ids.push(Number(account.id));
  }
  for (const grant of listed(ctx.db.grant.householdId.filter(householdId))) {
    if (grant.status === 'active' && grant.level === 'full' && grant.granteePersonId === personId) {
      ids.push(Number(grant.accountId));
    }
  }
  return [...new Set(ids)];
}

function parseChange(kind: string, paramsJson: string): Change {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(paramsJson) as Record<string, unknown>;
  } catch {
    throw new SenderError('Change details must be JSON');
  }
  return { kind, params };
}

export function forkScenario(ctx: Ctx, parentId: bigint, title: string): void {
  const me = requireMember(ctx);
  const parent = ctx.db.scenario.id.find(parentId);
  if (!parent || parent.householdId !== me.household.id) throw new SenderError('Scenario not found');
  const draft = ctx.db.scenario.insert({
    id: 0n,
    householdId: me.household.id,
    parentId,
    authorPersonId: me.person.id,
    agentKind: '',
    title: title.trim() || 'Fork',
    explanation: '',
    status: 'draft',
    scope: parent.scope,
    audiencePersonId: me.person.id,
    createdAt: ctx.timestamp,
    computedAtDay: me.household.simDay,
  });
  for (const change of listed(ctx.db.scenarioChange.scenarioId.filter(parentId))) {
    ctx.db.scenarioChange.insert({
      id: 0n,
      scenarioId: draft.id,
      householdId: me.household.id,
      kind: change.kind,
      paramsJson: change.paramsJson,
      label: change.label,
    });
  }
  recomputeScenario(ctx, draft.id);
}

export function addScenarioChange(
  ctx: Ctx,
  scenarioId: bigint,
  kind: string,
  paramsJson: string,
  label: string,
): void {
  const me = requireMember(ctx);
  const scenario = ctx.db.scenario.id.find(scenarioId);
  if (!scenario || scenario.householdId !== me.household.id) throw new SenderError('Scenario not found');
  if (scenario.status !== 'draft' || scenario.authorPersonId !== me.person.id) {
    throw new SenderError('Only the author can edit a draft');
  }
  const change = parseChange(kind, paramsJson);
  const visible = fullAccountIds(ctx, me.household.id, me.person.id, me.member.kind);
  const check = validateChange(change, visible);
  if (!check.ok) throw new SenderError(check.error ?? 'Change is not allowed');
  if (kind === 'move_obligation') {
    const obligationId = change.params.obligationId;
    const obligation = listed(ctx.db.obligation.householdId.filter(me.household.id)).find(
      row => Number(row.id) === obligationId,
    );
    if (!obligation?.flexible) throw new SenderError('That bill cannot be moved');
  }
  ctx.db.scenarioChange.insert({
    id: 0n,
    scenarioId,
    householdId: me.household.id,
    kind,
    paramsJson,
    label,
  });
  recomputeScenario(ctx, scenarioId);
}

export function removeScenarioChange(ctx: Ctx, changeId: bigint): void {
  const me = requireMember(ctx);
  const change = ctx.db.scenarioChange.id.find(changeId);
  if (!change || change.householdId !== me.household.id) throw new SenderError('Change not found');
  const scenario = ctx.db.scenario.id.find(change.scenarioId);
  if (!scenario || scenario.status !== 'draft' || scenario.authorPersonId !== me.person.id) {
    throw new SenderError('Only the author can edit a draft');
  }
  ctx.db.scenarioChange.id.delete(changeId);
  recomputeScenario(ctx, scenario.id);
}

function accountsById(ctx: Ctx, householdId: bigint) {
  const map = new Map<number, { id: number; isJoint: boolean; ownerPersonId: number }>();
  for (const account of listed(ctx.db.account.householdId.filter(householdId))) {
    map.set(Number(account.id), {
      id: Number(account.id),
      isJoint: account.isJoint,
      ownerPersonId: Number(account.ownerPersonId),
    });
  }
  return map;
}

export function proposeScenario(ctx: Ctx, scenarioId: bigint): void {
  const me = requireMember(ctx);
  const scenario = ctx.db.scenario.id.find(scenarioId);
  if (!scenario || scenario.authorPersonId !== me.person.id || scenario.status !== 'draft') {
    throw new SenderError('Only the author can propose a draft');
  }
  const changes = listed(ctx.db.scenarioChange.scenarioId.filter(scenarioId)).map(row =>
    parseChange(row.kind, row.paramsJson),
  );
  const scope = classify(changes, accountsById(ctx, me.household.id));
  const touchesJoint = changes.some(change => {
    const ids = [change.params.accountId, change.params.fromAccountId, change.params.toAccountId];
    return ids.some(id => typeof id === 'number' && accountsById(ctx, me.household.id).get(id)?.isJoint);
  });
  const big = changes.some(change => {
    const amount = change.params.amount;
    return (
      (change.kind === 'transfer' || change.kind === 'one_time') &&
      typeof amount === 'number' &&
      Math.abs(amount) >= Number(me.household.cosignThresholdCents)
    );
  });
  if (scope === 'individual' && !touchesJoint && !big) {
    ctx.db.scenario.id.update({ ...scenario, status: 'merged', scope, computedAtDay: me.household.simDay });
    recomputeScenario(ctx, scenarioId);
    return;
  }
  ctx.db.scenario.id.update({
    ...scenario,
    status: 'proposed',
    scope: scope === 'individual' ? 'household' : scope,
    computedAtDay: me.household.simDay,
  });
  for (const person of listed(ctx.db.person.householdId.filter(me.household.id))) {
    if (person.role !== 'coowner' || person.id === me.person.id) continue;
    ctx.db.alert.insert({
      id: 0n,
      householdId: me.household.id,
      routedToPersonId: person.id,
      aboutPersonId: me.person.id,
      kind: 'proposal',
      day: me.household.simDay,
      riskPct: 0,
      scenarioId,
      message: `${me.person.displayName} proposed “${scenario.title}”`,
      read: false,
      createdAt: ctx.timestamp,
    });
  }
  recomputeScenario(ctx, scenarioId);
}

function mergeScenario(ctx: Ctx, scenarioId: bigint): void {
  const scenario = ctx.db.scenario.id.find(scenarioId);
  if (!scenario) return;
  const household = ctx.db.household.id.find(scenario.householdId);
  if (!household) return;
  const previousId = household.baselineScenarioId;
  const previous = ctx.db.scenario.id.find(previousId);
  const kept = previous ? listed(ctx.db.scenarioChange.scenarioId.filter(previous.id)) : [];
  const added = listed(ctx.db.scenarioChange.scenarioId.filter(scenarioId));
  const baseline = ctx.db.scenario.insert({
    id: 0n,
    householdId: household.id,
    parentId: previousId,
    authorPersonId: 0n,
    agentKind: '',
    title: 'Baseline',
    explanation: scenario.explanation,
    status: 'baseline',
    scope: 'household',
    audiencePersonId: 0n,
    createdAt: ctx.timestamp,
    computedAtDay: household.simDay,
  });
  for (const change of [...kept, ...added]) {
    ctx.db.scenarioChange.insert({
      id: 0n,
      scenarioId: baseline.id,
      householdId: household.id,
      kind: change.kind,
      paramsJson: change.paramsJson,
      label: change.label,
    });
  }
  if (previous) ctx.db.scenario.id.update({ ...previous, status: 'superseded' });
  ctx.db.scenario.id.update({ ...scenario, status: 'merged' });
  ctx.db.household.id.update({ ...household, baselineScenarioId: baseline.id });
  for (const other of listed(ctx.db.scenario.householdId.filter(household.id))) {
    if (other.id === baseline.id || other.id === scenario.id) continue;
    if (other.parentId === previousId && (other.status === 'proposed' || other.status === 'draft')) {
      ctx.db.scenario.id.update({ ...other, status: 'stale' });
    }
  }
  for (const change of added) {
    const params = parseChange(change.kind, change.paramsJson).params;
    const amount = typeof params.amount === 'number' ? BigInt(Math.round(params.amount)) : 0n;
    const day = typeof params.day === 'number' ? params.day : household.simDay;
    const from = typeof params.fromAccountId === 'number' ? BigInt(params.fromAccountId) : 0n;
    const to = typeof params.toAccountId === 'number' ? BigInt(params.toAccountId) : 0n;
    ctx.db.commitment.insert({
      id: 0n,
      householdId: household.id,
      scenarioId: baseline.id,
      label: change.label,
      dueDay: day,
      done: false,
      transferFromAccountId: from,
      transferToAccountId: to,
      amountCents: amount < 0n ? -amount : amount,
      bankStatus: change.kind === 'transfer' ? 'queued' : 'n/a',
      nessieTransferId: '',
    });
  }
  recomputeScenario(ctx, baseline.id);
}

export function voteScenario(ctx: Ctx, scenarioId: bigint, decision: string): void {
  const scenario = ctx.db.scenario.id.find(scenarioId);
  if (!scenario || scenario.status !== 'proposed') throw new SenderError('That proposal is not open');
  const me =
    scenario.scope === 'routed' && scenario.audiencePersonId !== 0n
      ? requireMember(ctx)
      : requireCoOwner(ctx);
  if (me.household.id !== scenario.householdId) throw new SenderError('Scenario not found');
  if (scenario.scope === 'routed' && scenario.audiencePersonId !== me.person.id && me.person.role !== 'coowner') {
    throw new SenderError('This proposal is for someone else');
  }
  if (decision === 'approve') requireStepUp(ctx, me);
  if (decision !== 'approve' && decision !== 'decline' && decision !== 'counter') {
    throw new SenderError('Vote must be approve, decline, or counter');
  }
  // One vote per person: a second Approve click must not count twice.
  if (listed(ctx.db.approval.scenarioId.filter(scenarioId)).some(row => row.personId === me.person.id && row.decision === decision)) {
    throw new SenderError(decision === 'approve' ? 'You already approved this plan; it merges when every co-owner approves' : 'You already responded to this plan');
  }
  ctx.db.approval.insert({
    id: 0n,
    scenarioId,
    householdId: me.household.id,
    personId: me.person.id,
    decision,
    at: ctx.timestamp,
  });
  if (decision === 'decline') {
    ctx.db.scenario.id.update({ ...scenario, status: 'declined' });
    return;
  }
  if (decision === 'counter') {
    forkScenario(ctx, scenarioId, `Counter: ${scenario.title}`);
    return;
  }
  const coowners = listed(ctx.db.person.householdId.filter(me.household.id)).filter(row => row.role === 'coowner');
  const approvals = listed(ctx.db.approval.scenarioId.filter(scenarioId)).filter(row => row.decision === 'approve');
  const required = scenario.scope === 'routed' ? [scenario.audiencePersonId] : coowners.map(row => row.id);
  const approved = new Set(approvals.map(row => row.personId));
  if (required.every(id => approved.has(id))) mergeScenario(ctx, scenarioId);
}
