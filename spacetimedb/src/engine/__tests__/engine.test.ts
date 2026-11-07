import { describe, expect, it } from 'vitest';
import { DEMO_START_DATE, expandCadence, isoToSimDay, simDayToIso } from '../calendar';
import {
  DEMO_PATELS,
  DEMO_TRIP_CENTS,
  balanceOnDay,
  crunchesWithin,
  generateBacktestPopulation,
  generateHousehold,
} from '../generator';
import { mulberry32, seedFor } from '../rng';

describe('calendar', () => {
  it('maps sim day 0 to 2026-11-01 and day 27 to the 28th', () => {
    expect(DEMO_START_DATE).toBe('2026-11-01');
    expect(simDayToIso(0)).toBe('2026-11-01');
    expect(simDayToIso(27)).toBe('2026-11-28');
    expect(isoToSimDay('2026-11-28')).toBe(27);
  });

  it('round-trips dates and expands each cadence', () => {
    for (let day = -400; day <= 400; day += 1) {
      expect(isoToSimDay(simDayToIso(day))).toBe(day);
    }
    expect(expandCadence('once', 12, 0, 59)).toEqual([12]);
    expect(expandCadence('biweekly', 0, 0, 30)).toEqual([0, 14, 28]);
    expect(expandCadence('monthly', 27, 0, 59)).toEqual([27, 57]);
    expect(expandCadence('semimonthly', 0, 0, 40)).toEqual([0, 15, 30]);
    expect(expandCadence('biweekly', 27, -15, -1)).toContain(-1);
  });
});

describe('generator', () => {
  it('returns identical output for the same seed', () => {
    const first = generateHousehold(DEMO_PATELS, 42);
    const second = generateHousehold(DEMO_PATELS, 42);
    expect(first).toEqual(second);
    expect(generateHousehold(DEMO_PATELS, 43)).not.toEqual(first);

    const population = generateBacktestPopulation(4, 7);
    expect(generateBacktestPopulation(4, 7)).toEqual(population);
    expect(mulberry32(seedFor(1, 2))()).toBe(mulberry32(seedFor(1, 2))());
  });

  it('collides mortgage, auto loan, and joint card inside days 25–29', () => {
    const household = generateHousehold(DEMO_PATELS, 1);
    const joint = household.accounts.find(account => account.nickname === 'Joint checking');
    expect(joint).toBeDefined();
    const kinds = ['mortgage', 'auto_loan', 'card_payment'] as const;
    const dueDays = kinds.map(kind => {
      const obligation = household.obligations.find(
        row => row.kind === kind && row.accountId === joint?.id,
      );
      expect(obligation).toBeDefined();
      expect(obligation?.anchorDay).toBeGreaterThanOrEqual(25);
      expect(obligation?.anchorDay).toBeLessThanOrEqual(29);
      const posted = household.future.filter(
        txn =>
          txn.accountId === joint?.id &&
          txn.category === kind &&
          txn.day >= 25 &&
          txn.day <= 29,
      );
      expect(posted.length).toBeGreaterThan(0);
      return obligation?.anchorDay ?? 0;
    });
    expect(Math.max(...dueDays) - Math.min(...dueDays)).toBeLessThanOrEqual(4);
    expect(simDayToIso(dueDays[0] ?? 0)).toBe('2026-11-28');
  });

  it("dips Maya's student checking around day 12", () => {
    const household = generateHousehold(DEMO_PATELS, 1);
    const maya = household.persons.find(person => person.personaKey === 'maya');
    const checking = household.accounts.find(
      account => account.ownerPersonId === maya?.id && account.kind === 'checking',
    );
    expect(checking).toBeDefined();
    const before = balanceOnDay(household, checking?.id ?? 0, 11);
    const onDay = balanceOnDay(household, checking?.id ?? 0, 12);
    expect(before - onDay).toBeGreaterThan(50_000);
    expect(onDay).toBeLessThan(balanceOnDay(household, checking?.id ?? 0, 0));
    const descriptions = household.future
      .filter(txn => txn.accountId === checking?.id && txn.day === 12)
      .map(txn => txn.rawDescription)
      .join(' ');
    expect(descriptions).toMatch(/textbook/i);
    expect(descriptions).toMatch(/rent/i);
  });

  it('keeps the down payment on track until a $3,200 March trip', () => {
    const household = generateHousehold(DEMO_PATELS, 1);
    const sam = household.persons.find(person => person.personaKey === 'sam');
    expect(
      household.accounts.some(
        account => account.ownerPersonId === sam?.id && account.shareLevel === 'signal',
      ),
    ).toBe(true);

    const goal = household.goals.find(row => row.name === 'House down payment');
    const savings = household.accounts.find(account => account.id === goal?.accountId);
    const transfer = household.obligations.find(row => row.accountId === savings?.id);
    expect(goal && savings && transfer).toBeTruthy();
    const deposits = expandCadence(
      transfer?.cadence ?? 'monthly',
      transfer?.anchorDay ?? 0,
      0,
      goal?.targetDay ?? 0,
    );
    const monthsNeeded =
      ((goal?.targetCents ?? 0) - (savings?.balanceCents ?? 0)) / (transfer?.amountCents ?? 1);
    expect(monthsNeeded).toBeLessThanOrEqual(deposits.length);
    const lateMonths = monthsNeeded + DEMO_TRIP_CENTS / (transfer?.amountCents ?? 1) - deposits.length;
    expect(lateMonths).toBeGreaterThanOrEqual(4);
  });

  it('crunches 15–25% of the backtest population within 60 days', () => {
    const population = generateBacktestPopulation(200, 20261107);
    const rate = population.filter(household => crunchesWithin(household)).length / population.length;
    expect(rate).toBeGreaterThanOrEqual(0.15);
    expect(rate).toBeLessThanOrEqual(0.25);
    const sample = population[0];
    expect(sample?.accounts.filter(account => account.kind === 'credit_card').length).toBeGreaterThanOrEqual(1);
    expect(sample?.accounts.filter(account => account.kind === 'credit_card').length).toBeLessThanOrEqual(3);
  });
});
