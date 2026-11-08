import type { Change, ForecastInput, ForecastObligation } from './types';

const MAX_ONE_TIME_CENTS = 5_000_000;

export interface Validation {
  ok: boolean;
  error?: string;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function accountIds(change: Change): number[] {
  const params = change.params;
  const ids: number[] = [];
  for (const key of ['accountId', 'fromAccountId', 'toAccountId', 'loanAccountId']) {
    const value = num(params[key]);
    if (value !== undefined) ids.push(value);
  }
  return ids;
}

export function validateChange(change: Change, visibleAccountIds: number[]): Validation {
  const visible = new Set(visibleAccountIds);
  for (const id of accountIds(change)) {
    if (!visible.has(id)) return { ok: false, error: 'That account is not visible' };
  }
  const params = change.params;
  if (change.kind === 'one_time') {
    const amount = num(params.amount);
    const day = num(params.day);
    if (amount === undefined || amount === 0 || Math.abs(amount) > MAX_ONE_TIME_CENTS) {
      return { ok: false, error: 'Amount must be between -$50,000 and $50,000, and not zero' };
    }
    if (day === undefined) return { ok: false, error: 'A day is required' };
    return { ok: true };
  }
  if (change.kind === 'recurring_change') {
    if (typeof params.category !== 'string' || params.category === '') {
      return { ok: false, error: 'Category is required' };
    }
    if (num(params.newMonthly) === undefined || num(params.startDay) === undefined) {
      return { ok: false, error: 'Monthly amount and start day are required' };
    }
    return { ok: true };
  }
  if (change.kind === 'move_obligation') {
    if (num(params.obligationId) === undefined || num(params.newDay) === undefined) {
      return { ok: false, error: 'Obligation and new day are required' };
    }
    return { ok: true };
  }
  if (change.kind === 'transfer') {
    const amount = num(params.amount);
    if (params.fromAccountId === params.toAccountId) return { ok: false, error: 'Pick two different accounts' };
    if (amount === undefined || amount <= 0) return { ok: false, error: 'Transfer amount must be positive' };
    if (num(params.day) === undefined) return { ok: false, error: 'A day is required' };
    return { ok: true };
  }
  if (change.kind === 'extra_payment') {
    const amount = num(params.amount);
    if (amount === undefined || amount <= 0 || num(params.day) === undefined) {
      return { ok: false, error: 'Payment amount and day are required' };
    }
    return { ok: true };
  }
  if (change.kind === 'delay_change') {
    if (num(params.changeId) === undefined || num(params.newDay) === undefined) {
      return { ok: false, error: 'Change and new day are required' };
    }
    return { ok: true };
  }
  return { ok: false, error: 'Unknown change' };
}

function cloneInput(input: ForecastInput): ForecastInput {
  return {
    ...input,
    accounts: input.accounts.map(account => ({ ...account })),
    obligations: input.obligations.map(obligation => ({ ...obligation })),
    spend: input.spend.map(row => ({ ...row })),
    goals: input.goals.map(goal => ({ ...goal })),
  };
}

function oneTime(id: number, accountId: number, amount: number, day: number, label: string): ForecastObligation {
  return {
    id,
    accountId,
    kind: amount >= 0 ? 'income' : 'one_time',
    amount: Math.abs(amount),
    cadence: 'once',
    anchorDay: day,
    flexible: false,
    label,
  } as ForecastObligation & { label?: string };
}

export function applyChanges(input: ForecastInput, changes: Change[]): ForecastInput {
  const next = cloneInput(input);
  let nextId = next.obligations.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  for (const change of changes) {
    const params = change.params;
    if (change.kind === 'one_time') {
      const amount = num(params.amount) ?? 0;
      next.obligations.push({
        id: nextId,
        accountId: num(params.accountId) ?? 0,
        kind: 'one_time',
        amount,
        cadence: 'once',
        anchorDay: num(params.day) ?? 0,
        flexible: false,
      });
      nextId += 1;
    } else if (change.kind === 'move_obligation') {
      const obligation = next.obligations.find(row => row.id === num(params.obligationId));
      if (obligation?.flexible) obligation.anchorDay = num(params.newDay) ?? obligation.anchorDay;
    } else if (change.kind === 'recurring_change') {
      const row = next.spend.find(
        spend =>
          spend.accountId === num(params.accountId) && spend.category === params.category,
      );
      const monthly = num(params.newMonthly) ?? 0;
      if (row) {
        row.dailyProb = 1;
        row.logMean = Math.log(Math.max(1, monthly / 100 / 30));
        row.logSd = 0.01;
      }
    } else if (change.kind === 'transfer' || change.kind === 'extra_payment') {
      const amount = num(params.amount) ?? 0;
      const day = num(params.day) ?? 0;
      const from = num(change.kind === 'transfer' ? params.fromAccountId : params.fromAccountId) ?? 0;
      const to = num(change.kind === 'transfer' ? params.toAccountId : params.loanAccountId) ?? 0;
      next.obligations.push({
        id: nextId,
        accountId: from,
        kind: 'one_time',
        amount: -amount,
        cadence: 'once',
        anchorDay: day,
        flexible: false,
      });
      nextId += 1;
      next.obligations.push({
        id: nextId,
        accountId: to,
        kind: 'one_time',
        amount: change.kind === 'extra_payment' ? -amount : amount,
        cadence: 'once',
        anchorDay: day,
        flexible: false,
      });
      nextId += 1;
    }
  }
  return next;
}
