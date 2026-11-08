// Builds the requester's privacy-filtered, pseudonymized view of the household.
//
// Rules (spec: "Privacy by construction", "Pseudonyms per job"):
//  - The requester's own accounts and joint accounts are fully visible.
//  - Another member's account is visible at the level of an *active* grant to the requester
//    (or to the whole household). 'signal' grants feed totals only; no grant = Private = excluded.
//  - Members become A/B/C, accounts acct_xx, obligations obl_xx, goals goal_x. The token map
//    stays in the module and is discarded after the job.
//  - Free text (raw descriptions, merchant names, nicknames) never enters the twin. Labels are
//    rebuilt from kinds and normalized merchant codes.

import { perMonth } from './dates';
import { sanitizeUserText } from './gateway';
import { cleanLabel } from './twin';
import type { TwinAccount, TwinData, TwinGoal, TwinObligation, TwinSpending, AccountSpending, Visibility } from './types';

// Structural copies of the table rows we read. Kept minimal so tests can build fixtures.
export interface PersonRow {
  id: bigint;
  displayName: string;
  role: string;
  personaKey?: string;
}
export interface AccountRow {
  id: bigint;
  ownerPersonId: bigint;
  isJoint: boolean;
  kind: string;
  nickname: string;
  balanceCents: bigint;
  limitCents: bigint;
  aprBps: number;
  bufferCents: bigint;
  maturityDay: number;
  nessieId?: string;
}
export interface GrantRow {
  accountId: bigint;
  granteePersonId: bigint;
  level: string;
  status: string;
  expiresAtMicros: bigint;
}
export interface ObligationRow {
  id: bigint;
  accountId: bigint;
  kind: string;
  label: string;
  amountCents: bigint;
  cadence: string;
  anchorDay: number;
  flexible: boolean;
  active: boolean;
}
export interface TxnRow {
  accountId: bigint;
  day: number;
  amountCents: bigint;
  category: string;
  merchantCode: string;
  rawDescription: string;
}
export interface SpendProfileRow {
  accountId: bigint;
  category: string;
  dailyProb: number;
  logMean: number;
  logSd: number;
}
export interface GoalRow {
  id: bigint;
  ownerPersonId: bigint;
  name: string;
  targetCents: bigint;
  targetDay: number;
  accountId: bigint;
}

export interface SnapshotInput {
  today: number;
  nowMicros: bigint;
  requesterPersonId: bigint;
  persons: PersonRow[];
  accounts: AccountRow[];
  grants: GrantRow[];
  obligations: ObligationRow[];
  txns: TxnRow[]; // trailing history; only the last 90 days are used
  spendProfiles: SpendProfileRow[];
  goals: GoalRow[];
}

export interface PseudoMap {
  members: Map<string, bigint>; // token -> person id
  accounts: Map<string, bigint>;
  obligations: Map<string, bigint>;
  goals: Map<string, bigint>;
  names: string[]; // real display names, for the outbound PII scan (case-insensitive)
  nicknameWords: string[]; // distinctive words from account nicknames (matched case-sensitively)
  nameToToken: Map<string, string>; // lowercase display name -> member token, for sanitizing user text
}

export interface SubscriptionSeries {
  merchant: string; // normalized merchant code, never raw text
  accountToken: string;
  owner: string;
  charges: { day: number; amount: number }[];
}

export interface Snapshot {
  twin: TwinData;
  map: PseudoMap;
  subscriptions: SubscriptionSeries[]; // visible accounts only, for Opportunity Radar
  categoryTrend: { category: string; last30: number; prior60avg: number }[];
  injectionSuspects: number; // raw descriptions that looked like prompt injections (never sent)
  /** Accounts the requester sees only because the owner granted *them* (not the household) access. */
  personallyGranted: number;
}

const LIQUID = new Set(['checking', 'savings']);
const LEVEL_RANK: Record<string, number> = { signal: 1, summary: 2, full: 3 };

function shortToken(prefix: string, n: number, salt: number): string {
  // Non-sequential but deterministic per job: tokens don't reveal table order.
  const h = ((n + 1) * 2654435761 + salt * 40503) >>> 0;
  return `${prefix}_${(h % 4096).toString(16).padStart(3, '0')}`;
}

export function looksLikeInjection(text: string): boolean {
  return /ignore (all|any|previous|prior)|disregard|system prompt|you are now|transfer \$?\d|instructions?\b.*\b(ai|assistant|model)|<\/?(script|system)|\bjailbreak\b/i.test(
    text,
  );
}

export function buildSnapshot(input: SnapshotInput, salt = 7): Snapshot {
  const me = input.requesterPersonId;
  const map: PseudoMap = {
    members: new Map(),
    accounts: new Map(),
    obligations: new Map(),
    goals: new Map(),
    names: [],
    nicknameWords: [],
    nameToToken: new Map(),
  };

  // Members: requester is always A so prompts read naturally ("A asked...").
  const persons = [...input.persons].sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : Number(a.id - b.id)));
  const memberToken = new Map<bigint, string>();
  // Every way a person can be written: full display name, each part of it, and the persona key.
  // A part shared by several members (the family surname) identifies no one and is removed.
  const owners = new Map<string, Set<string>>();
  persons.forEach((p, i) => {
    const tok = String.fromCharCode(65 + i);
    memberToken.set(p.id, tok);
    map.members.set(tok, p.id);
    const full = p.displayName.trim().replace(/\s+/g, ' ');
    const aliases = [full, ...full.split(' '), p.personaKey ?? '']
      .map(a => a.replace(/[^\p{L}\p{N} '\u2019-]/gu, '').replace(/['\u2019]s$/i, '').trim())
      .filter(a => a.length >= 2);
    for (const a of aliases) {
      const key = a.toLowerCase();
      owners.set(key, (owners.get(key) ?? new Set()).add(tok));
      map.names.push(a);
    }
  });
  for (const [alias, toks] of owners) map.nameToToken.set(alias, toks.size === 1 ? [...toks][0] : '');

  // Visibility per account.
  const visibility = new Map<bigint, Visibility>();
  let personallyGranted = 0;
  for (const a of input.accounts) {
    if (a.isJoint || a.ownerPersonId === me) {
      visibility.set(a.id, 'full');
      continue;
    }
    let best = 0;
    let household = 0;
    for (const g of input.grants) {
      if (g.accountId !== a.id || g.status !== 'active' || g.expiresAtMicros <= input.nowMicros) continue;
      if (g.granteePersonId !== me && g.granteePersonId !== 0n) continue;
      const rank = LEVEL_RANK[g.level] ?? 0;
      best = Math.max(best, rank);
      if (g.granteePersonId === 0n) household = Math.max(household, rank);
    }
    if (best > 0) visibility.set(a.id, best === 3 ? 'full' : best === 2 ? 'summary' : 'signal');
    if (best > household && best > 1) personallyGranted++;
  }

  const accounts: TwinAccount[] = [];
  input.accounts
    .filter(a => visibility.has(a.id))
    .forEach((a, i) => {
      const tok = shortToken('acct', i, salt);
      map.accounts.set(tok, a.id);
      map.nicknameWords.push(...distinctiveWords(a.nickname));
      accounts.push({
        token: tok,
        kind: a.kind,
        owner: a.isJoint ? 'joint' : memberToken.get(a.ownerPersonId) ?? 'joint',
        visibility: visibility.get(a.id)!,
        balance: Number(a.balanceCents) / 100,
        limit: Number(a.limitCents) / 100,
        aprPct: a.aprBps / 100,
        buffer: Number(a.bufferCents) / 100,
        maturityDay: a.maturityDay,
      });
    });
  const accountTok = new Map<bigint, string>([...map.accounts].map(([t, id]) => [id, t]));
  const accountById = new Map(input.accounts.map(a => [a.id, a]));

  const obligations: TwinObligation[] = [];
  input.obligations
    .filter(o => o.active && accountTok.has(o.accountId))
    .forEach((o, i) => {
      const tok = shortToken('obl', i, salt);
      map.obligations.set(tok, o.id);
      const acct = accountById.get(o.accountId)!;
      const vis = visibility.get(o.accountId)!;
      obligations.push({
        token: tok,
        kind: o.kind,
        label: obligationLabel(o, i, map.nameToToken, map.nicknameWords),
        amount: Number(o.amountCents) / 100,
        cadence: o.cadence,
        anchorDay: o.anchorDay,
        accountToken: accountTok.get(o.accountId)!,
        owner: acct.isJoint ? 'joint' : memberToken.get(acct.ownerPersonId) ?? 'joint',
        flexible: o.flexible,
        visible: vis !== 'signal',
      });
    });

  // Spending model: prefer fitted spend profiles; otherwise derive from the last 90 days.
  const spending = buildSpending(input, accountTok);

  const goals: TwinGoal[] = input.goals
    .filter(g => g.ownerPersonId === 0n || g.ownerPersonId === me)
    .map((g, i) => {
      const tok = `goal_${i + 1}`;
      map.goals.set(tok, g.id);
      const acct = accountById.get(g.accountId);
      const saved = acct && accountTok.has(acct.id) ? Number(acct.balanceCents) / 100 : 0;
      const name = looksLikeInjection(g.name) ? tok : cleanLabel(sanitizeUserText(g.name, map.nameToToken, 60), tok);
      return {
        token: tok,
        name,
        target: Number(g.targetCents) / 100,
        saved: Math.min(saved, Number(g.targetCents) / 100),
        targetDay: g.targetDay,
        shared: g.ownerPersonId === 0n,
      };
    });

  // Subscription history and category trends: visible (non-signal) accounts only.
  const fullyVisible = new Set(
    [...visibility].filter(([, v]) => v !== 'signal').map(([id]) => id),
  );
  const recent = input.txns.filter(t => t.day > input.today - 90 && t.day <= input.today);
  const subsByKey = new Map<string, SubscriptionSeries>();
  let injectionSuspects = 0;
  for (const t of input.txns) {
    if (looksLikeInjection(t.rawDescription)) injectionSuspects++;
    if (!fullyVisible.has(t.accountId) || t.category !== 'subscriptions' || t.amountCents >= 0n) continue;
    if (t.day <= input.today - 180) continue;
    const key = `${t.accountId}:${t.merchantCode}`;
    let s = subsByKey.get(key);
    if (!s) {
      const acct = accountById.get(t.accountId)!;
      s = {
        merchant: safeMerchant(t.merchantCode),
        accountToken: accountTok.get(t.accountId)!,
        owner: acct.isJoint ? 'joint' : memberToken.get(acct.ownerPersonId) ?? 'joint',
        charges: [],
      };
      subsByKey.set(key, s);
    }
    s.charges.push({ day: t.day, amount: -Number(t.amountCents) / 100 });
  }
  for (const s of subsByKey.values()) s.charges.sort((a, b) => a.day - b.day);

  const cat = new Map<string, { last30: number; prior60: number }>();
  for (const t of recent) {
    if (!fullyVisible.has(t.accountId) || t.amountCents >= 0n || t.category === 'transfer' || t.category === 'income') continue;
    const c = cat.get(t.category) ?? { last30: 0, prior60: 0 };
    if (t.day > input.today - 30) c.last30 += -Number(t.amountCents) / 100;
    else c.prior60 += -Number(t.amountCents) / 100;
    cat.set(t.category, c);
  }

  return {
    twin: { today: input.today, members: persons.map(p => ({ token: memberToken.get(p.id)!, role: p.role, isRequester: p.id === me })), accounts, obligations, spending, goals, accountSpending: buildAccountSpending(input, accountTok) },
    map,
    subscriptions: [...subsByKey.values()],
    categoryTrend: [...cat].map(([category, v]) => ({
      category,
      last30: Math.round(v.last30),
      prior60avg: Math.round(v.prior60 / 2),
    })),
    injectionSuspects,
    personallyGranted,
  };
}

// Words common enough in account nicknames that blocking them would block every prompt.
const GENERIC_WORDS = new Set(
  'joint checking savings saving house home fund funds mortgage car auto loan loans visa mastercard amex discover card credit debit account accounts business personal emergency travel college main primary bills bill the my our his her their student ira roth cd brokerage rainy day gift kids family vacation spending everyday high yield money market reserve cash wallet virtual rewards platinum gold signature month months monthly year years yearly week weeks weekly day days daily payment payments salary paycheck transfer split'.split(' '),
);

/** Words from a nickname that could identify someone (proper nouns, company names). */
function distinctiveWords(nickname: string): string[] {
  return nickname
    .split(/[^A-Za-z']+/)
    .map(w => w.replace(/'s$/i, ''))
    .filter(w => w.length >= 3 && !GENERIC_WORDS.has(w.toLowerCase()));
}

function safeMerchant(code: string): string {
  return /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'MERCHANT';
}

function obligationLabel(o: ObligationRow, i: number, names: Map<string, string>, nicknameWords: string[]): string {
  // Labels come from kinds, not user text. A short sanitized label is kept only when it
  // does not still contain a member name or an account-nickname word. Those words are
  // what the outbound privacy scan refuses to send, and a leaked one blocks the model.
  const kindLabel: Record<string, string> = {
    income: 'Paycheck',
    mortgage: 'Mortgage',
    rent: 'Rent',
    auto_loan: 'Car payment',
    card_payment: 'Card payment',
    utility: 'Utilities',
    insurance: 'Insurance',
    subscription: 'Subscription',
    tuition: 'Tuition',
    transfer: 'Scheduled transfer',
  };
  const base = kindLabel[o.kind] ?? 'Bill';
  const safe = !looksLikeInjection(o.label) && /^[A-Za-z0-9 &'-]{1,30}$/.test(o.label.trim());
  if (!safe) return `${base} ${i + 1}`;
  const cleaned = cleanLabel(sanitizeUserText(o.label, names, 40), base);
  const leaked = [...names.keys(), ...nicknameWords].some(w => w.length >= 3 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(cleaned));
  return leaked ? `${base} ${i + 1}` : cleaned;
}

function buildSpending(input: SnapshotInput, accountTok: Map<bigint, string>): TwinSpending[] {
  const liquidIds = new Set(input.accounts.filter(a => LIQUID.has(a.kind) && accountTok.has(a.id)).map(a => a.id));
  const byCat = new Map<string, TwinSpending>();
  const add = (category: string, mean: number, variance: number) => {
    const c = byCat.get(category) ?? { category, dailyMean: 0, dailyVar: 0 };
    c.dailyMean += mean;
    c.dailyVar += variance;
    byCat.set(category, c);
  };

  const profiled = new Set<string>();
  for (const p of input.spendProfiles) {
    if (!liquidIds.has(p.accountId)) continue;
    const ex = Math.exp(p.logMean + (p.logSd * p.logSd) / 2);
    const ex2 = Math.exp(2 * p.logMean + 2 * p.logSd * p.logSd);
    const mean = p.dailyProb * ex;
    add(p.category, mean, p.dailyProb * ex2 - mean * mean);
    profiled.add(`${p.accountId}:${p.category}`);
  }

  // Fallback: empirical daily totals over the trailing 90 days, excluding scheduled items
  // (obligations are modeled separately) and transfers.
  // Scheduled bills are modeled as obligations; their payment transactions carry the obligation kind as category.
  const scheduled = new Set(['income', 'transfer', 'housing', 'insurance', 'subscriptions', ...input.obligations.map(o => o.kind)]);
  const window = 90;
  const daily = new Map<string, number[]>();
  for (const t of input.txns) {
    if (!liquidIds.has(t.accountId) || t.amountCents >= 0n) continue;
    if (t.day <= input.today - window || t.day > input.today) continue;
    if (scheduled.has(t.category) || profiled.has(`${t.accountId}:${t.category}`)) continue;
    const arr = daily.get(t.category) ?? new Array(window).fill(0);
    arr[input.today - t.day] += -Number(t.amountCents) / 100;
    daily.set(t.category, arr);
  }
  for (const [category, arr] of daily) {
    const mean = arr.reduce((s, x) => s + x, 0) / window;
    const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / window;
    add(category, mean, variance);
  }
  return [...byCat.values()].map(c => ({
    category: c.category,
    dailyMean: Math.round(c.dailyMean * 100) / 100,
    dailyVar: Math.round(c.dailyVar * 100) / 100,
  }));
}

/** Expected daily spending per cash account (same model as buildSpending), so the twin can tell which account drains. */
function buildAccountSpending(input: SnapshotInput, accountTok: Map<bigint, string>): AccountSpending[] {
  const out = new Map<string, AccountSpending>();
  const add = (accountId: bigint, mean: number, variance: number) => {
    const token = accountTok.get(accountId);
    if (!token) return;
    const row = out.get(token) ?? { token, dailyMean: 0, dailyVar: 0 };
    row.dailyMean += mean;
    row.dailyVar += variance;
    out.set(token, row);
  };
  const liquidIds = new Set(input.accounts.filter(a => LIQUID.has(a.kind) && accountTok.has(a.id)).map(a => a.id));
  const profiled = new Set<string>();
  for (const p of input.spendProfiles) {
    if (!liquidIds.has(p.accountId)) continue;
    const ex = Math.exp(p.logMean + (p.logSd * p.logSd) / 2);
    const ex2 = Math.exp(2 * p.logMean + 2 * p.logSd * p.logSd);
    const mean = p.dailyProb * ex;
    add(p.accountId, mean, p.dailyProb * ex2 - mean * mean);
    profiled.add(`${p.accountId}:${p.category}`);
  }
  // Scheduled bills are modeled as obligations; their payment transactions carry the obligation kind as category.
  const scheduled = new Set(['income', 'transfer', 'housing', 'insurance', 'subscriptions', ...input.obligations.map(o => o.kind)]);
  const window = 90;
  const totals = new Map<bigint, number[]>();
  for (const t of input.txns) {
    if (!liquidIds.has(t.accountId) || t.amountCents >= 0n) continue;
    if (t.day <= input.today - window || t.day > input.today) continue;
    if (scheduled.has(t.category) || profiled.has(`${t.accountId}:${t.category}`)) continue;
    const arr = totals.get(t.accountId) ?? new Array(window).fill(0);
    arr[input.today - t.day] += -Number(t.amountCents) / 100;
    totals.set(t.accountId, arr);
  }
  for (const [accountId, arr] of totals) {
    const mean = arr.reduce((sum, x) => sum + x, 0) / window;
    add(accountId, mean, arr.reduce((sum, x) => sum + (x - mean) ** 2, 0) / window);
  }
  return [...out.values()];
}

/** The compact, model-facing overview. Signal accounts appear only inside totals. */
export function overviewForModel(snap: Snapshot) {
  const t = snap.twin;
  const shown = t.accounts.filter(a => a.visibility !== 'signal');
  const hidden = t.accounts.filter(a => a.visibility === 'signal');
  const monthlyIncomeAll = t.obligations
    .filter(o => o.kind === 'income')
    .reduce((s, o) => s + o.amount * perMonth(o.cadence), 0);
  return {
    members: t.members.map(m => ({ member: m.token, role: m.role, you: m.isRequester })),
    accounts: shown.map(a => ({
      account: a.token,
      kind: a.kind,
      owner: a.owner,
      balance: Math.round(a.balance),
      ...(a.kind === 'credit_card' ? { limit: Math.round(a.limit), apr_pct: a.aprPct } : {}),
      ...(a.kind.endsWith('loan') || a.kind === 'mortgage' ? { apr_pct: a.aprPct } : {}),
      ...(a.kind === 'checking' ? { buffer: Math.round(a.buffer) } : {}),
    })),
    other_household_cash: Math.round(hidden.filter(a => LIQUID.has(a.kind)).reduce((s, a) => s + a.balance, 0)),
    household_monthly_income: Math.round(monthlyIncomeAll),
    obligations: t.obligations
      .filter(o => o.visible)
      .map(o => ({
        obligation: o.token,
        kind: o.kind,
        label: o.label,
        amount: Math.round(o.amount),
        cadence: o.cadence,
        owner: o.owner,
        flexible: o.flexible,
      })),
    monthly_spending_by_category: Object.fromEntries(
      t.spending.map(s => [s.category, Math.round(s.dailyMean * 30.4375)]),
    ),
    goals: t.goals.map(g => ({ goal: g.token, name: g.name, target: Math.round(g.target), saved: Math.round(g.saved), shared: g.shared })),
  };
}
