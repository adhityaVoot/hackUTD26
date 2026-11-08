import { describe, expect, it } from 'vitest';
import { fitSpendProfiles, profileFromMonthly, projectFuture } from '../fit';

describe('fit', () => {
  it('turns a monthly estimate into a daily profile', () => {
    const profile = profileFromMonthly(1, 'groceries', 30_000);
    expect(profile.dailyProb).toBe(1);
    expect(profile.logMean).toBeCloseTo(Math.log(10), 5);
  });

  it('fits a probability from the last 90 days and projects a future', () => {
    const txns = Array.from({ length: 9 }, (_, index) => ({
      accountId: 1,
      day: index * 10,
      amountCents: -2_500,
      category: 'groceries',
      merchantCode: 'GROCERIES_001',
      rawDescription: 'Store',
    }));
    const profiles = fitSpendProfiles(txns, 90);
    expect(profiles[0]?.dailyProb).toBeCloseTo(0.1, 5);
    const future = projectFuture(
      [
        {
          id: 1,
          accountId: 1,
          kind: 'income',
          label: 'Pay',
          amountCents: 100,
          cadence: 'once',
          anchorDay: 1,
          flexible: false,
        },
      ],
      profiles,
      [{ id: 1, kind: 'checking' }],
      7,
      0,
      5,
    );
    expect(future.some(row => row.category === 'income' && row.day === 1)).toBe(true);
    expect(projectFuture([], profiles, [{ id: 1, kind: 'checking' }], 7, 0, 5)).toEqual(
      projectFuture([], profiles, [{ id: 1, kind: 'checking' }], 7, 0, 5),
    );
  });
});
