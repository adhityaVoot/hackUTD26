import { expandCadence, isWeekend } from './calendar';
import { lognormal, mulberry32, seedFor } from './rng';
import type {
  Account,
  GeneratedHousehold,
  Obligation,
  PersonaConfig,
  SpendProfile,
  Txn,
} from './types';

/** $3,200 Japan trip, in cents. March is outside the 60-day ledger; the goal math uses this amount. */
export const DEMO_TRIP_CENTS = 320_000;

const DESCRIPTIONS: Record<string, string[]> = {
  groceries: ['H-E-B Mueller', 'Kroger #4412', 'Whole Foods Market'],
  dining: ['Torchys Tacos', 'Starbucks Reserve', 'Chipotle Mexican Grill'],
  gas: ['Shell Oil 4421', 'Exxon on Greenville'],
  shopping: ['Target Richardson', 'Amazon Marketplace'],
  entertainment: ['Alamo Drafthouse', 'Netflix.com'],
  utilities: ['Atmos Energy', 'TXU Energy'],
  housing: ['Oak Creek Apartments'],
  tuition: ['UT Dallas Bookstore'],
  transfer: ['Internal transfer'],
  income: ['Payroll deposit'],
  shock: ['Auto repair — brake service', 'Urgent care visit'],
  other: ['Miscellaneous purchase'],
};

function merchantCode(category: string, n: number): string {
  const name = category.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'OTHER';
  return `${name}_${String(Math.abs(n) % 1000).padStart(3, '0')}`;
}

function describe(category: string, r: () => number): string {
  const options = DESCRIPTIONS[category] ?? DESCRIPTIONS.other;
  return options[Math.floor(r() * options.length)] ?? options[0];
}

function signedAmount(obligation: Obligation, account: Account): number {
  if (obligation.kind === 'income') return obligation.amountCents;
  if (
    obligation.kind === 'transfer' &&
    (account.kind === 'savings' || account.kind === 'cd' || account.kind === 'ira')
  ) {
    return obligation.amountCents;
  }
  return -obligation.amountCents;
}

function debtKind(kind: string): boolean {
  return kind === 'credit_card' || kind === 'auto_loan' || kind === 'personal_loan' || kind === 'mortgage';
}

function compareTxn(a: Txn, b: Txn): number {
  return (
    a.day - b.day ||
    a.accountId - b.accountId ||
    a.category.localeCompare(b.category) ||
    a.merchantCode.localeCompare(b.merchantCode) ||
    a.amountCents - b.amountCents
  );
}

function buildLedger(config: PersonaConfig, seed: number, fromDay: number, toDay: number): Txn[] {
  const r = mulberry32(seed);
  const accounts = new Map(config.accounts.map(account => [account.id, account]));
  const txns: Txn[] = [];

  for (const obligation of [...config.obligations].sort((a, b) => a.id - b.id)) {
    const account = accounts.get(obligation.accountId);
    if (!account) continue;
    for (const day of expandCadence(obligation.cadence, obligation.anchorDay, fromDay, toDay)) {
      txns.push({
        accountId: obligation.accountId,
        day,
        amountCents: signedAmount(obligation, account),
        category: obligation.kind,
        merchantCode: merchantCode(obligation.kind, obligation.id),
        rawDescription: obligation.label,
      });
    }
  }

  for (const txn of config.scripted) {
    if (txn.day >= fromDay && txn.day <= toDay) txns.push({ ...txn });
  }

  const profiles = [...config.spendProfiles].sort(
    (a, b) => a.id - b.id || a.category.localeCompare(b.category),
  );
  for (let day = fromDay; day <= toDay; day += 1) {
    const weekend = isWeekend(day);
    for (const profile of profiles) {
      const probability = Math.min(1, profile.dailyProb * (weekend ? profile.weekendMult : 1));
      if (r() >= probability) continue;
      const cents = Math.max(1, Math.round(lognormal(r, profile.logMean, profile.logSd) * 100));
      const account = accounts.get(profile.accountId);
      const increasesDebt = account ? debtKind(account.kind) : false;
      txns.push({
        accountId: profile.accountId,
        day,
        amountCents: increasesDebt ? cents : -cents,
        category: profile.category,
        merchantCode: merchantCode(profile.category, Math.floor(r() * 1000)),
        rawDescription: describe(profile.category, r),
      });
    }
  }

  txns.sort(compareTxn);
  return txns;
}

export function generateHousehold(config: PersonaConfig, seed: number): GeneratedHousehold {
  return {
    persons: config.persons.map(person => ({ ...person })),
    accounts: config.accounts.map(account => ({ ...account })),
    obligations: config.obligations.map(obligation => ({ ...obligation })),
    spendProfiles: config.spendProfiles.map(profile => ({ ...profile })),
    goals: config.goals.map(goal => ({ ...goal })),
    history: buildLedger(config, seedFor(seed, 1), config.historyStartDay, config.historyEndDay),
    future: buildLedger(config, seedFor(seed, 2), config.futureStartDay, config.futureEndDay),
  };
}

function spend(
  id: number,
  accountId: number,
  category: string,
  dailyProb: number,
  logMean: number,
  logSd = 0.45,
  weekendMult = 1.25,
): SpendProfile {
  return { id, accountId, category, dailyProb, logMean, logSd, weekendMult };
}

/** Demo household. Numbers are chosen so the §9.7 beats fall out of the ledger. */
export function patelConfig(): PersonaConfig {
  const monthlySave = 80_000;
  const deposits = expandCadence('monthly', 5, 0, 800);
  const eighthDeposit = deposits[7] ?? 5;
  const savingsBalance = 1_800_000;

  return {
    householdName: 'The Patels',
    persons: [
      { id: 1, displayName: 'Priya', role: 'coowner', personaKey: 'priya' },
      { id: 2, displayName: 'Sam', role: 'coowner', personaKey: 'sam' },
      { id: 3, displayName: 'Maya', role: 'member', personaKey: 'maya' },
    ],
    accounts: [
      { id: 1, ownerPersonId: 1, isJoint: false, kind: 'checking', nickname: 'Priya checking', balanceCents: 420_000, limitCents: 0, aprBps: 0, bufferCents: 20_000, maturityDay: -1, shareLevel: 'none' },
      { id: 2, ownerPersonId: 1, isJoint: false, kind: 'credit_card', nickname: 'Priya card', balanceCents: 86_000, limitCents: 500_000, aprBps: 2299, bufferCents: 0, maturityDay: -1, shareLevel: 'none' },
      { id: 3, ownerPersonId: 1, isJoint: false, kind: 'ira', nickname: 'Priya IRA', balanceCents: 2_400_000, limitCents: 0, aprBps: 0, bufferCents: 0, maturityDay: -1, shareLevel: 'none' },
      { id: 4, ownerPersonId: 2, isJoint: false, kind: 'checking', nickname: 'Sam checking', balanceCents: 310_000, limitCents: 0, aprBps: 0, bufferCents: 20_000, maturityDay: -1, shareLevel: 'none' },
      { id: 5, ownerPersonId: 2, isJoint: false, kind: 'checking', nickname: 'Side business', balanceCents: 640_000, limitCents: 0, aprBps: 0, bufferCents: 10_000, maturityDay: -1, shareLevel: 'signal' },
      { id: 6, ownerPersonId: 2, isJoint: false, kind: 'ira', nickname: 'Sam IRA', balanceCents: 1_100_000, limitCents: 0, aprBps: 0, bufferCents: 0, maturityDay: -1, shareLevel: 'none' },
      { id: 7, ownerPersonId: 0, isJoint: true, kind: 'checking', nickname: 'Joint checking', balanceCents: 310_000, limitCents: 0, aprBps: 0, bufferCents: 20_000, maturityDay: -1, shareLevel: 'full' },
      { id: 8, ownerPersonId: 0, isJoint: true, kind: 'savings', nickname: 'Joint savings', balanceCents: savingsBalance, limitCents: 0, aprBps: 0, bufferCents: 0, maturityDay: -1, shareLevel: 'full' },
      { id: 9, ownerPersonId: 0, isJoint: true, kind: 'cd', nickname: '12-month CD', balanceCents: 500_000, limitCents: 0, aprBps: 450, bufferCents: 0, maturityDay: 200, shareLevel: 'full' },
      { id: 10, ownerPersonId: 0, isJoint: true, kind: 'mortgage', nickname: 'Home mortgage', balanceCents: 28_000_000, limitCents: 0, aprBps: 625, bufferCents: 0, maturityDay: -1, shareLevel: 'full' },
      { id: 11, ownerPersonId: 0, isJoint: true, kind: 'auto_loan', nickname: 'Toyota auto loan', balanceCents: 1_450_000, limitCents: 0, aprBps: 499, bufferCents: 0, maturityDay: -1, shareLevel: 'full' },
      { id: 12, ownerPersonId: 0, isJoint: true, kind: 'credit_card', nickname: 'Joint card', balanceCents: 120_000, limitCents: 800_000, aprBps: 1999, bufferCents: 0, maturityDay: -1, shareLevel: 'full' },
      { id: 13, ownerPersonId: 3, isJoint: false, kind: 'checking', nickname: 'Student checking', balanceCents: 120_000, limitCents: 0, aprBps: 0, bufferCents: 10_000, maturityDay: -1, shareLevel: 'none' },
    ],
    obligations: [
      { id: 1, accountId: 1, kind: 'income', label: 'Priya salary', amountCents: 280_000, cadence: 'semimonthly', anchorDay: 13, flexible: false },
      { id: 2, accountId: 4, kind: 'income', label: 'Sam salary', amountCents: 240_000, cadence: 'biweekly', anchorDay: 12, flexible: false },
      { id: 3, accountId: 7, kind: 'mortgage', label: 'PNC mortgage payment', amountCents: 185_000, cadence: 'monthly', anchorDay: 27, flexible: false },
      { id: 4, accountId: 7, kind: 'auto_loan', label: 'Toyota auto loan payment', amountCents: 48_500, cadence: 'monthly', anchorDay: 27, flexible: false },
      { id: 5, accountId: 7, kind: 'card_payment', label: 'Joint card payment', amountCents: 62_000, cadence: 'monthly', anchorDay: 27, flexible: true },
      { id: 6, accountId: 13, kind: 'transfer', label: 'Rent split to Priya', amountCents: 70_000, cadence: 'once', anchorDay: 12, flexible: false },
      { id: 7, accountId: 13, kind: 'tuition', label: 'UT Dallas textbooks', amountCents: 35_000, cadence: 'once', anchorDay: 12, flexible: false },
      { id: 8, accountId: 8, kind: 'transfer', label: 'Monthly house-fund transfer', amountCents: monthlySave, cadence: 'monthly', anchorDay: 5, flexible: false },
    ],
    spendProfiles: [
      spend(1, 7, 'groceries', 0.55, Math.log(42), 0.35, 1.1),
      spend(2, 7, 'dining', 0.35, Math.log(28), 0.4, 1.6),
      spend(3, 7, 'gas', 0.2, Math.log(38), 0.2, 1.05),
      spend(4, 12, 'shopping', 0.15, Math.log(46), 0.5, 1.4),
      spend(5, 1, 'dining', 0.2, Math.log(18), 0.4, 1.3),
      spend(6, 4, 'dining', 0.18, Math.log(16), 0.4, 1.3),
      spend(7, 5, 'other', 0.12, Math.log(35), 0.55, 1.1),
      spend(8, 13, 'dining', 0.08, Math.log(12), 0.3, 1.4),
    ],
    goals: [
      {
        id: 1,
        ownerPersonId: 0,
        name: 'House down payment',
        targetCents: savingsBalance + monthlySave * 8,
        targetDay: eighthDeposit,
        accountId: 8,
      },
    ],
    scripted: [],
    historyStartDay: -365,
    historyEndDay: -1,
    futureStartDay: 0,
    futureEndDay: 59,
  };
}

export const DEMO_PATELS: PersonaConfig = patelConfig();

function backtestConfig(index: number, r: () => number): PersonaConfig {
  const income = Math.round((300_000 + r() * 900_000) / 100) * 100;
  const fixedFrac = 0.35 + r() * 0.3;
  const cardCount = 1 + Math.floor(r() * 3);
  const shockRate = 0.3 + r() * 1.2;
  const startFrac = 0.14 + r() * 0.22;
  const checking: Account = {
    id: 1,
    ownerPersonId: 1,
    isJoint: false,
    kind: 'checking',
    nickname: 'Checking',
    balanceCents: Math.round(income * startFrac),
    limitCents: 0,
    aprBps: 0,
    bufferCents: Math.round(income * 0.05),
    maturityDay: -1,
    shareLevel: 'full',
  };
  const accounts: Account[] = [checking];
  const obligations: Obligation[] = [
    {
      id: 1,
      accountId: 1,
      kind: 'income',
      label: 'Payroll deposit',
      amountCents: Math.round(income / 2),
      cadence: 'semimonthly',
      anchorDay: 14,
      flexible: false,
    },
    {
      id: 2,
      accountId: 1,
      kind: 'utility',
      label: 'Rent and fixed bills',
      amountCents: Math.round(income * fixedFrac),
      cadence: 'monthly',
      anchorDay: 27,
      flexible: false,
    },
  ];
  for (let c = 0; c < cardCount; c += 1) {
    const limit = Math.round((200_000 + r() * 600_000) / 100) * 100;
    const balance = Math.round(limit * (0.15 + r() * 0.55));
    accounts.push({
      id: 2 + c,
      ownerPersonId: 1,
      isJoint: false,
      kind: 'credit_card',
      nickname: `Card ${c + 1}`,
      balanceCents: balance,
      limitCents: limit,
      aprBps: 1999 + c * 100,
      bufferCents: 0,
      maturityDay: -1,
      shareLevel: 'none',
    });
    obligations.push({
      id: 10 + c,
      accountId: 1,
      kind: 'card_payment',
      label: `Card ${c + 1} minimum`,
      amountCents: Math.max(2_500, Math.round(balance * 0.03)),
      cadence: 'monthly',
      anchorDay: 26,
      flexible: true,
    });
  }
  return {
    householdName: `Backtest ${index}`,
    persons: [{ id: 1, displayName: 'Alex', role: 'coowner', personaKey: 'backtest' }],
    accounts,
    obligations,
    spendProfiles: [
      spend(1, 1, 'groceries', 0.35, Math.log(22), 0.35, 1.15),
      spend(2, 1, 'shock', shockRate / 30, Math.log(220), 0.3, 1),
    ],
    goals: [],
    scripted: [],
    historyStartDay: -365,
    historyEndDay: -1,
    futureStartDay: 0,
    futureEndDay: 59,
  };
}

export function generateBacktestPopulation(count: number, seed: number): GeneratedHousehold[] {
  const households: GeneratedHousehold[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = mulberry32(seedFor(seed, i));
    households.push(generateHousehold(backtestConfig(i, r), seedFor(seed, i, 1)));
  }
  return households;
}

/** End-of-day balance. Opening `balanceCents` is the balance before day 0. */
export function balanceOnDay(household: GeneratedHousehold, accountId: number, day: number): number {
  const account = household.accounts.find(row => row.id === accountId);
  if (!account) return 0;
  let balance = account.balanceCents;
  for (const txn of household.future) {
    if (txn.accountId === accountId && txn.day <= day && txn.day >= 0) balance += txn.amountCents;
  }
  return balance;
}

/** A checking account ends a day inside the horizon below its buffer. */
export function crunchesWithin(household: GeneratedHousehold, lastDay = 59): boolean {
  return household.accounts.some(account => {
    if (account.kind !== 'checking') return false;
    for (let day = 0; day <= lastDay; day += 1) {
      if (balanceOnDay(household, account.id, day) < account.bufferCents) return true;
    }
    return false;
  });
}
