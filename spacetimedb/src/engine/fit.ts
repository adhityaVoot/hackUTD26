import { expandCadence, isWeekend } from './calendar';
import { lognormal, mulberry32, seedFor } from './rng';
import type { Obligation, SpendProfile, Txn } from './types';

export function profileFromMonthly(accountId: number, category: string, monthlyCents: number): SpendProfile {
  const daily = Math.max(1, monthlyCents / 30);
  return {
    id: 0,
    accountId,
    category,
    dailyProb: 1,
    logMean: Math.log(daily / 100),
    logSd: 0.15,
    weekendMult: 1,
  };
}

export function fitSpendProfiles(txns: Txn[], asOfDay: number): SpendProfile[] {
  const window = txns.filter(row => row.day >= asOfDay - 90 && row.day < asOfDay && row.amountCents < 0);
  const groups = new Map<string, Txn[]>();
  for (const txn of window) {
    const key = `${txn.accountId}|${txn.category}`;
    const list = groups.get(key) ?? [];
    list.push(txn);
    groups.set(key, list);
  }
  const profiles: SpendProfile[] = [];
  for (const [key, rows] of groups) {
    const [accountIdRaw, category] = key.split('|');
    const amounts = rows.map(row => -row.amountCents / 100);
    const mean = amounts.reduce((sum, value) => sum + Math.log(Math.max(0.01, value)), 0) / amounts.length;
    const variance =
      amounts.reduce((sum, value) => sum + (Math.log(Math.max(0.01, value)) - mean) ** 2, 0) /
      Math.max(1, amounts.length - 1);
    profiles.push({
      id: profiles.length + 1,
      accountId: Number(accountIdRaw),
      category: category ?? 'other',
      dailyProb: Math.min(1, rows.length / 90),
      logMean: mean,
      logSd: Math.sqrt(variance) || 0.2,
      weekendMult: 1.1,
    });
  }
  return profiles;
}

export function projectFuture(
  obligations: Obligation[],
  spend: SpendProfile[],
  accounts: { id: number; kind: string }[],
  seed: number,
  fromDay: number,
  toDay: number,
): Txn[] {
  const random = mulberry32(seedFor(seed, 9));
  const kinds = new Map(accounts.map(account => [account.id, account.kind]));
  const txns: Txn[] = [];
  for (const obligation of [...obligations].sort((a, b) => a.id - b.id)) {
    const debt = ['credit_card', 'auto_loan', 'personal_loan', 'mortgage'].includes(
      kinds.get(obligation.accountId) ?? '',
    );
    for (const day of expandCadence(obligation.cadence, obligation.anchorDay, fromDay, toDay)) {
      const intoSavings = obligation.kind === 'transfer' && ['savings', 'cd', 'ira'].includes(kinds.get(obligation.accountId) ?? '');
      const sign = obligation.kind === 'income' || intoSavings ? 1 : debt ? 1 : -1;
      txns.push({
        accountId: obligation.accountId,
        day,
        amountCents: sign * obligation.amountCents,
        category: obligation.kind,
        merchantCode: `${obligation.kind.toUpperCase()}_${obligation.id}`,
        rawDescription: obligation.label,
      });
    }
  }
  for (let day = fromDay; day <= toDay; day += 1) {
    const weekend = isWeekend(day);
    for (const row of [...spend].sort((a, b) => a.accountId - b.accountId || a.category.localeCompare(b.category))) {
      const probability = Math.min(1, row.dailyProb * (weekend ? row.weekendMult : 1));
      const roll = random();
      const cents = Math.max(1, Math.round(lognormal(random, row.logMean, row.logSd) * 100));
      if (roll >= probability) continue;
      const kind = kinds.get(row.accountId) ?? 'checking';
      const sign = ['credit_card', 'auto_loan', 'personal_loan', 'mortgage'].includes(kind) ? 1 : -1;
      txns.push({
        accountId: row.accountId,
        day,
        amountCents: sign * cents,
        category: row.category,
        merchantCode: `${row.category.toUpperCase()}_000`,
        rawDescription: row.category,
      });
    }
  }
  return txns;
}
