import { isoToSimDay } from '../engine/calendar';
export function cents(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e9) throw Error('Invalid Nessie monetary amount');
  return BigInt(Math.round(value * 100));
}
export function accountKind(type: string): string {
  const kind = { Checking: 'checking', Savings: 'savings', 'Credit Card': 'credit_card' }[type];
  if (!kind) throw Error('Unsupported Nessie account type');
  return kind;
}
export function bankTransaction(row: any, kind: string, accountId: string) {
  if (row.status !== 'completed') return null; // pending/cancelled entries do not enter the posted ledger
  if (typeof row._id !== 'string' || !row._id) throw Error('Missing Nessie transaction ID');
  if (typeof row.amount !== 'number' || row.amount < 0) throw Error('Invalid Nessie transaction amount');
  if (kind === 'transfer' && row.payer_id !== accountId && row.payee_id !== accountId) throw Error('Transfer account mismatch');
  const date = row.transaction_date ?? row.purchase_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw Error('Invalid Nessie transaction date');
  const parsed = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date) throw Error('Invalid Nessie transaction date');
  const day = isoToSimDay(date);
  const inbound = kind === 'deposit' || (kind === 'transfer' && row.payee_id === accountId);
  return { nessieId: `${kind}:${row._id}:${accountId}`, day, amountCents: cents(row.amount) * (inbound ? 1n : -1n),
    category: kind === 'deposit' ? 'income' : kind === 'transfer' ? 'transfer' : 'other',
    rawDescription: String(row.description ?? `Nessie ${kind}`).slice(0, 200), merchantCode: 'NESSIE_DEMO' };
}
