// Opportunity Radar: deterministic detectors over accounts, bills and transactions.
// Code finds and prices every opportunity; Nemotron ranks them and explains them.
// Spec rules applied here: free fixes first during a crunch, product offers never inside a
// crunch, every item carries its scope (individual vs household).

import { dayToIso, dayToLabel, nextOccurrence, occursOn } from './dates';
import type { Snapshot } from './snapshot';
import { diff, resolveLever, simulate } from './twin';
import type { Lever, TwinResult } from './types';

export interface Opportunity {
  opportunity: string; // opp_<n>
  type: 'subscription_increase' | 'duplicate_subscription' | 'high_apr_payoff' | 'idle_cash' | 'bill_timing' | 'spending_spike';
  scope: 'individual' | 'household';
  owner: string; // member token or 'joint'
  title: string;
  evidence: Record<string, string | number>;
  est_monthly_savings: number;
  effort: 'low' | 'medium';
  free: boolean; // costs nothing to act on
  lever?: Lever;
  rank: number;
}

const round = (n: number) => Math.round(n);

/** "STREAMING_003" -> "Streaming subscription". The code itself stays in evidence. */
function merchantName(code: string): string {
  const p = code.split('_')[0].toLowerCase();
  return p ? `${p[0].toUpperCase()}${p.slice(1)} subscription` : 'A subscription';
}

/**
 * Cash a checking account can spare over the next 30 days without touching its buffer:
 * balance - buffer - scheduled bills - expected spending + paychecks landing in it.
 */
function checkingFreeCash(snap: Snapshot, token: string): number {
  const t = snap.twin;
  const acct = t.accounts.find(a => a.token === token);
  if (!acct) return 0;
  let net = acct.balance - acct.buffer;
  for (const o of t.obligations.filter(x => x.accountToken === token)) {
    for (let d = t.today + 1; d <= t.today + 30; d++) {
      if (!occursOn(o.cadence, o.anchorDay, d)) continue;
      net += o.kind === 'income' ? o.amount : -o.amount;
    }
  }
  // Spending is modeled across liquid accounts; charge it to joint checking when that's the account.
  if (acct.owner === 'joint') net -= t.spending.reduce((s, c) => s + c.dailyMean, 0) * 30;
  return net;
}

export function findOpportunities(snap: Snapshot, baseline: TwinResult): Opportunity[] {
  const t = snap.twin;
  const out: Omit<Opportunity, 'opportunity' | 'rank'>[] = [];
  const me = t.members.find(m => m.isRequester)?.token ?? 'A';
  const scopeOf = (owner: string): 'individual' | 'household' => (owner === 'joint' ? 'household' : 'individual');
  const inCrunch = baseline.peakCrunchRisk > 0.25;

  // 1. Subscription price increases.
  for (const s of snap.subscriptions) {
    if (s.charges.length < 2) continue;
    const last = s.charges[s.charges.length - 1];
    const prev = s.charges[s.charges.length - 2];
    const inc = last.amount - prev.amount;
    if (inc >= 1 && inc / prev.amount >= 0.05 && last.day > t.today - 45) {
      out.push({
        type: 'subscription_increase',
        scope: scopeOf(s.owner),
        owner: s.owner,
        title: `${merchantName(s.merchant)} went up`,
        evidence: { merchant: s.merchant, before: round(prev.amount * 100) / 100, after: round(last.amount * 100) / 100, increase_per_month: Math.round(inc * 100) / 100, increase_per_year: round(inc * 12), since: dayToLabel(last.day) },
        est_monthly_savings: Math.round(last.amount * 100) / 100,
        effort: 'low',
        free: true,
      });
    }
  }

  // 2. The same subscription paid from two accounts (often both partners).
  const byMerchant = new Map<string, typeof snap.subscriptions>();
  for (const s of snap.subscriptions) {
    if (!s.charges.some(c => c.day > t.today - 45)) continue;
    byMerchant.set(s.merchant, [...(byMerchant.get(s.merchant) ?? []), s]);
  }
  for (const [merchant, list] of byMerchant) {
    if (list.length < 2) continue;
    const amounts = list.map(s => s.charges[s.charges.length - 1].amount).sort((a, b) => a - b);
    out.push({
      type: 'duplicate_subscription',
      scope: 'household',
      owner: 'joint',
      title: `${merchantName(merchant)} is billed twice`,
      evidence: { merchant, accounts: list.length, cheaper_plan: Math.round(amounts[0] * 100) / 100 },
      est_monthly_savings: Math.round(amounts[0] * 100) / 100,
      effort: 'low',
      free: true,
    });
  }

  // 3. High-APR card balance while checking has cash to spare after this month's bills.
  for (const c of t.accounts.filter(a => a.kind === 'credit_card' && a.visibility !== 'signal')) {
    const source = t.accounts.find(a => a.kind === 'checking' && a.visibility !== 'signal' && (a.owner === c.owner || a.owner === 'joint'));
    if (!source || c.balance < 200 || c.aprPct < 15) continue;
    const free = checkingFreeCash(snap, source.token);
    const pay = Math.min(c.balance, Math.floor((free * 0.5) / 50) * 50);
    if (pay < 100) continue;
    const liquidCushion = free;
    out.push({
      type: 'high_apr_payoff',
      scope: scopeOf(c.owner),
      owner: c.owner,
      title: `Pay down the ${c.aprPct}% card`,
      evidence: { card: c.token, balance: round(c.balance), apr_pct: c.aprPct, suggested_payment: pay, interest_saved_per_month: round((pay * c.aprPct) / 100 / 12), checking_free_cash_30_days: round(liquidCushion) },
      est_monthly_savings: round((pay * c.aprPct) / 100 / 12),
      effort: 'low',
      free: false,
      lever: { kind: 'transfer', from: source.token, to: c.token, amount: pay, date: dayToIso(t.today + 3), label: 'Card paydown' },
    });
  }

  // 4. Idle cash: checking can spare money after 30 days of bills and spending, and there is a savings account.
  const savings = t.accounts.find(a => a.kind === 'savings' && a.visibility !== 'signal');
  const checking = t.accounts.find(a => a.kind === 'checking' && a.visibility !== 'signal' && a.owner === 'joint') ??
    t.accounts.find(a => a.kind === 'checking' && a.visibility !== 'signal');
  if (!inCrunch && savings && checking) {
    const p10Floor = checkingFreeCash(snap, checking.token);
    const idle = Math.floor((p10Floor * 0.5) / 100) * 100;
    if (idle >= 500) {
      out.push({
        type: 'idle_cash',
        scope: scopeOf(checking.owner),
        owner: checking.owner,
        title: 'Cash sitting idle in checking',
        evidence: { amount: idle, checking_free_cash_30_days: round(p10Floor) },
        est_monthly_savings: round((idle * Math.max(savings.aprPct, 0)) / 100 / 12),
        effort: 'low',
        free: true,
        lever: { kind: 'transfer', from: checking.token, to: savings.token, amount: idle, date: dayToIso(t.today + 2), label: 'Move idle cash to savings' },
      });
    }
  }

  // 5. Bill timing: a flexible bill lands in the riskiest week; moving it after the next paycheck is free.
  if (baseline.peakCrunchRisk > 0.1) {
    const peak = baseline.peakCrunchDay;
    const incomes = t.obligations.filter(o => o.kind === 'income');
    const nextPay = Math.min(...incomes.map(o => nextOccurrence(o.cadence, o.anchorDay, peak)).filter(d => d > 0));
    for (const o of t.obligations.filter(x => x.flexible && x.visible && x.kind !== 'income')) {
      const due = nextOccurrence(o.cadence, o.anchorDay, t.today + 1);
      if (due < 0 || due > peak || peak - due > 7 || !Number.isFinite(nextPay)) continue;
      const lever: Lever = { kind: 'move_obligation', obligation: o.token, new_date: dayToIso(nextPay + 1), label: `Move ${o.label} after payday` };
      let after = baseline;
      try {
        after = simulate(t, [resolveLever(t, lever)]);
      } catch {
        continue;
      }
      const d = diff(baseline, after);
      if (d.crunchAfter >= d.crunchBefore) continue;
      out.push({
        type: 'bill_timing',
        scope: scopeOf(o.owner),
        owner: o.owner,
        title: `Move ${o.label} to after payday`,
        evidence: { obligation: o.token, amount: round(o.amount), due: dayToLabel(due), new_date: dayToLabel(nextPay + 1), crunch_risk_before_pct: d.crunchBefore, crunch_risk_after_pct: d.crunchAfter },
        est_monthly_savings: 0,
        effort: 'low',
        free: true,
        lever,
      });
    }
  }

  // 6. Category spikes vs the prior two months.
  for (const c of snap.categoryTrend) {
    if (c.prior60avg < 50 || c.last30 < c.prior60avg * 1.3 || c.last30 - c.prior60avg < 50) continue;
    if (['housing', 'income', 'transfer', 'shock'].includes(c.category)) continue;
    out.push({
      type: 'spending_spike',
      scope: 'individual',
      owner: me,
      title: `${c.category} is up this month`,
      evidence: { category: c.category, last_30_days: c.last30, usual_month: c.prior60avg, difference: c.last30 - c.prior60avg },
      est_monthly_savings: c.last30 - c.prior60avg,
      effort: 'medium',
      free: true,
    });
  }

  // Rank: savings x urgency / effort; free fixes first while a crunch is forecast.
  const ranked = out
    .map(o => {
      const urgency = o.type === 'bill_timing' ? 3 : o.type === 'subscription_increase' ? 1.5 : 1;
      let rank = ((o.est_monthly_savings + 10) * urgency) / (o.effort === 'low' ? 1 : 2);
      if (inCrunch && o.free) rank *= 10;
      if (inCrunch && !o.free) rank *= 0.1;
      return { ...o, rank: Math.round(rank * 10) / 10 };
    })
    .sort((a, b) => b.rank - a.rank)
    .map((o, i) => ({ ...o, opportunity: `opp_${i + 1}` }));
  return ranked;
}
