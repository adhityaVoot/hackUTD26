import { t } from 'spacetimedb/server';
import { TimeDuration } from 'spacetimedb';
import { envValue, requireMember } from '../auth';
import { fitSpendProfiles } from '../engine/fit';
import { recomputeScenario } from '../recompute';
import { nessieClient } from './client';
import { accountKind, bankTransaction, cents } from './mapping';
import type database from '../index';

export function registerNessie(db: typeof database) {
  return db.procedure({}, t.string(), ctx => {
    const config = ctx.withTx(tx => {
      const me = requireMember(tx);
      const key = envValue(tx, 'NESSIE_API_KEY');
      const customers = JSON.parse(envValue(tx, 'NESSIE_DEMO_CUSTOMERS') ?? '{}');
      const customerId = customers[`${me.household.inviteCode}:${me.person.personaKey}`];
      if (!key || !customerId) throw Error('Demo banking is not configured for your household member. Ask the demo administrator.');
      return { key, customerId: String(customerId), personId: me.person.id, householdId: me.household.id,
        base: envValue(tx, 'NESSIE_BASE_URL') ?? 'https://api.nessieisreal.com' };
    });
    const get = nessieClient({ fetch: (url, init) => ctx.http.fetch(url, { ...init, timeout: TimeDuration.fromMillis(15000) }) }, config.base, config.key);
    // Fetch completely before one atomic import. A failed request never partially replaces balances.
    const accounts = get(`/customers/${encodeURIComponent(config.customerId)}/accounts`);
    if (!Array.isArray(accounts) || accounts.length > 20) throw Error('Unexpected Nessie account response');
    const imported = accounts.map((a: any) => {
      if (a.customer_id !== config.customerId || typeof a._id !== 'string') throw Error('Nessie account ownership mismatch');
      const transactions: NonNullable<ReturnType<typeof bankTransaction>>[] = [];
      for (const [endpoint, kind] of [['deposits','deposit'], ['withdrawals','withdrawal'], ['purchases','purchase'], ['transfers','transfer']]) {
        const rows = get(`/accounts/${encodeURIComponent(a._id)}/${endpoint}`);
        if (!Array.isArray(rows) || rows.length > 5000) throw Error('Unexpected Nessie transaction response');
        for (const row of rows) { const mapped = bankTransaction(row, kind, a._id); if (mapped) transactions.push(mapped); }
      }
      return { source: a, kind: accountKind(a.type), balance: cents(a.balance), transactions };
    });
    return ctx.withTx(tx => {
      const me = requireMember(tx);
      if (me.person.id !== config.personId || me.household.id !== config.householdId) throw Error('Household membership changed. Retry sync.');
      let count = 0;
      for (const bank of imported) {
        let local = [...tx.db.account.iter()].find(a => a.nessieId === bank.source._id);
        if (local && (local.ownerPersonId !== me.person.id || local.householdId !== me.household.id || local.isJoint)) throw Error('Bank account already belongs to another member');
        if (local) { const updated = { ...local, balanceCents: bank.balance }; tx.db.account.id.update(updated); local = updated; }
        else local = tx.db.account.insert({ id: 0n, householdId: me.household.id, ownerPersonId: me.person.id, isJoint: false,
          kind: bank.kind, nickname: String(bank.source.nickname ?? 'Demo account').slice(0,80), balanceCents: bank.balance,
          limitCents: 0n, aprBps: 0, bufferCents: 0n, maturityDay: -1, nessieId: bank.source._id });
        for (const row of bank.transactions) {
          if ([...tx.db.txn.nessieId.filter(row.nessieId)].length) continue;
          tx.db.txn.insert({ id: 0n, householdId: me.household.id, accountId: local.id, ...row }); count++;
        }
      }
      // Fit spending only for imported accounts; transfers must not become spending.
      const bankIds = new Set(imported.map(a => a.source._id));
      const localAccounts = [...tx.db.account.householdId.filter(me.household.id)].filter(a => bankIds.has(a.nessieId));
      const ids = new Set(localAccounts.map(a => a.id));
      const history = [...tx.db.txn.householdId.filter(me.household.id)]
        .filter(r => ids.has(r.accountId) && r.category !== 'transfer')
        .map(r => ({ ...r, accountId: Number(r.accountId), amountCents: Number(r.amountCents) }));
      for (const row of [...tx.db.spendProfile.householdId.filter(me.household.id)]) {
        if (ids.has(row.accountId)) tx.db.spendProfile.id.delete(row.id);
      }
      for (const profile of fitSpendProfiles(history, me.household.simDay)) {
        tx.db.spendProfile.insert({ ...profile, id: 0n, accountId: BigInt(profile.accountId), householdId: me.household.id });
      }
      const status = { householdId: me.household.id, lastSyncAt: tx.timestamp, lastError: '', seeded: true };
      if (tx.db.nessieStatus.householdId.find(me.household.id)) tx.db.nessieStatus.householdId.update(status);
      else tx.db.nessieStatus.insert(status);
      if (me.household.baselineScenarioId !== 0n) recomputeScenario(tx, me.household.baselineScenarioId);
      return JSON.stringify({ accounts: imported.length, newTransactions: count, source: 'Nessie sandbox' });
    });
  });
}
