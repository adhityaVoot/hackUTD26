import { table, t, SenderError } from 'spacetimedb/server';
import { requireMember, requireStepUp, type Ctx } from './auth';

export const moneyRequest = table({ name: 'money_request' }, {
  id: t.u64().primaryKey().autoInc(), householdId: t.u64().index('btree'),
  requesterPersonId: t.u64(), recipientPersonId: t.u64(), amountCents: t.i64(),
  reason: t.string(), status: t.string(), createdAt: t.timestamp(), updatedAt: t.timestamp(),
});

export function createMoneyRequest(ctx: Ctx, recipientPersonId: bigint, amountCents: bigint, reason: string) {
  const me = requireMember(ctx);
  const recipient = ctx.db.person.id.find(recipientPersonId);
  if (!recipient || recipient.householdId !== me.household.id || recipientPersonId === me.person.id) {
    throw new SenderError('Choose another person in your household');
  }
  if (amountCents <= 0n || amountCents > 5_000_000n) throw new SenderError('Request between $0.01 and $50,000');
  const text = reason.trim();
  if (text.length < 3 || text.length > 240) throw new SenderError('Give a reason between 3 and 240 characters');
  ctx.db.moneyRequest.insert({id: 0n, householdId: me.household.id, requesterPersonId: me.person.id,
    recipientPersonId, amountCents, reason: text, status: 'pending', createdAt: ctx.timestamp, updatedAt: ctx.timestamp});
}

export function respondMoneyRequest(ctx: Ctx, requestId: bigint, decision: string) {
  const me = requireMember(ctx);
  const request = ctx.db.moneyRequest.id.find(requestId);
  if (!request || request.householdId !== me.household.id) throw new SenderError('Request not found');
  if (request.status !== 'pending') throw new SenderError('This request has already been resolved');
  if (decision === 'cancel') {
    if (request.requesterPersonId !== me.person.id) throw new SenderError('Only the requester can cancel');
  } else {
    if (!['approve','decline'].includes(decision)) throw new SenderError('Choose approve or decline');
    if (request.recipientPersonId !== me.person.id) throw new SenderError('Only the requested family member can respond');
    if (decision === 'approve') requireStepUp(ctx, me);
  }
  const status = {approve:'approved',decline:'declined',cancel:'cancelled'}[decision]!;
  ctx.db.moneyRequest.id.update({...request,status,updatedAt:ctx.timestamp});
  ctx.db.consentLog.insert({id:0n,householdId:me.household.id,actorPersonId:me.person.id,accountId:0n,
    action:'money_request_'+status,detail:`Money request ${request.id}: ${status}; no funds moved`,at:ctx.timestamp});
}
