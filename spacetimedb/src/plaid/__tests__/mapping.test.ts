import { describe, expect, it } from 'vitest';
import { bankMode, plaidAccountKind, plaidAmountCents, plaidBalanceCents, plaidCategory } from '../mapping';

describe('Plaid mapping', () => {
  it('keeps the Patel demo on sandbox and every other household on production', () => {
    expect(bankMode('PATELS')).toBe('sandbox');
    expect(bankMode('NORTH')).toBe('production');
  });

  it('stores Plaid outflows as negative cents and inflows as positive cents', () => {
    expect(plaidAmountCents(12.5)).toBe(-1250n);
    expect(plaidAmountCents(-4.5)).toBe(450n);
    expect(plaidBalanceCents(110.1)).toBe(11010n);
  });

  it('maps account types and leaves investments out', () => {
    expect(plaidAccountKind('depository', 'checking')).toBe('checking');
    expect(plaidAccountKind('depository', 'savings')).toBe('savings');
    expect(plaidAccountKind('credit', 'credit card')).toBe('credit_card');
    expect(plaidAccountKind('investment', 'brokerage')).toBeNull();
    expect(plaidCategory('INCOME')).toBe('income');
    expect(plaidCategory('TRANSFER_OUT')).toBe('transfer');
    expect(plaidCategory(undefined)).toBe('other');
  });
});
