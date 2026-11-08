/** The seeded household. Everyone else connects a real bank. */
export const DEMO_INVITE_CODE = 'PATELS';

export function bankMode(inviteCode: string): 'sandbox' | 'production' {
  return inviteCode === DEMO_INVITE_CODE ? 'sandbox' : 'production';
}

/** Plaid's positive amount is money leaving the account. Tandem stores that as negative cents. */
export function plaidAmountCents(amount: number): bigint {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.abs(amount) > 1e9) {
    throw Error('Invalid Plaid amount');
  }
  return BigInt(Math.round(amount * 100)) * -1n;
}

export function plaidBalanceCents(amount: number): bigint {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.abs(amount) > 1e9) {
    throw Error('Invalid Plaid balance');
  }
  return BigInt(Math.round(amount * 100));
}

export function plaidAccountKind(type: string, subtype: string | null): string | null {
  if (type === 'depository') return subtype === 'savings' ? 'savings' : 'checking';
  if (type === 'credit') return 'credit_card';
  if (type === 'loan' && subtype === 'mortgage') return 'mortgage';
  if (type === 'loan' && (subtype === 'auto' || subtype === 'auto_loan')) return 'auto_loan';
  if (type === 'loan') return 'personal_loan';
  return null;
}

export function plaidCategory(primary: string | undefined): string {
  switch (primary) {
    case 'INCOME': return 'income';
    case 'FOOD_AND_DRINK': return 'dining';
    case 'TRANSPORTATION': return 'gas';
    case 'RENT_AND_UTILITIES': return 'utilities';
    case 'LOAN_PAYMENTS': return 'housing';
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT': return 'transfer';
    case 'GENERAL_MERCHANDISE': return 'shopping';
    case 'ENTERTAINMENT': return 'entertainment';
    case 'HOME_IMPROVEMENT': return 'housing';
    default: return 'other';
  }
}
