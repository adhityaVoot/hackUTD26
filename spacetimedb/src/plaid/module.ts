import { t } from 'spacetimedb/server';
import { envValue, requireMember } from '../auth';
import { isoToSimDay } from '../engine/calendar';
import { recomputeScenario } from '../recompute';
import { plaidRequest, type PlaidCredentials, type PlaidHttp } from './client';
import { DEMO_INVITE_CODE, bankMode, plaidAccountKind, plaidAmountCents, plaidBalanceCents, plaidCategory } from './mapping';
import type database from '../index';

const PLATYPUS = 'ins_109508';

function credentials(tx: { env: any }, mode: 'sandbox' | 'production'): PlaidCredentials {
  const clientId = envValue(tx as any, 'PLAID_CLIENT_ID');
  const secret = envValue(tx as any, mode === 'sandbox' ? 'PLAID_SANDBOX_SECRET' : 'PLAID_SECRET');
  if (!clientId || !secret) throw Error(mode === 'sandbox' ? 'Sandbox banking is not configured.' : 'Bank connection is not configured.');
  return { clientId, secret, host: mode };
}

function postedTransactions(http: PlaidHttp, credentials: PlaidCredentials, accessToken: string) {
  const rows: any[] = [];
  let cursor = '';
  try {
    for (let page = 0; page < 5 && rows.length < 300; page += 1) {
      const synced = plaidRequest(http, credentials, '/transactions/sync', { access_token: accessToken, cursor, count: 100 });
      const batch = Array.isArray(synced.added) ? synced.added : [];
      rows.push(...batch.filter((row: any) => row && row.pending !== true));
      cursor = String(synced.next_cursor ?? cursor);
      if (!synced.has_more) break;
    }
  } catch (err) {
    // A brand-new Item can answer accounts before its transaction history is ready.
    if (!String(err).includes('PRODUCT_NOT_READY')) throw err;
  }
  return rows.slice(0, 300);
}

function rememberItem(tx: any, me: ReturnType<typeof requireMember>, itemId: string, accessToken: string, environment: string, institutionName: string) {
  const existing = [...tx.db.plaidItem.ownerPersonId.filter(me.person.id)].find((row: any) => row.householdId === me.household.id && row.itemId === itemId);
  if (existing) {
    tx.db.plaidItem.id.update({ ...existing, accessToken, institutionName });
    return;
  }
  tx.db.plaidItem.insert({
    id: 0n, householdId: me.household.id, ownerPersonId: me.person.id, itemId, accessToken, environment, institutionName,
  });
}

function writeAccounts(tx: any, me: ReturnType<typeof requireMember>, institutionName: string, accounts: any[], transactions: any[]) {
  if (!Array.isArray(accounts) || accounts.length > 20) throw Error('Unexpected Plaid account response');
  let count = 0;
  const localIds = new Map<string, bigint>();
  for (const account of accounts) {
    const kind = plaidAccountKind(String(account.type ?? ''), account.subtype ?? null);
    const current = account.balances?.current;
    if (!kind || account.balances?.iso_currency_code && account.balances.iso_currency_code !== 'USD' || typeof account.account_id !== 'string' || typeof current !== 'number') continue;
    const nessieId = `plaid:${account.account_id}`;
    let local = [...tx.db.account.iter()].find((row: any) => row.nessieId === nessieId);
    if (local && (local.ownerPersonId !== me.person.id || local.householdId !== me.household.id || local.isJoint)) throw Error('Bank account already belongs to another member');
    const balanceCents = plaidBalanceCents(current);
    const nickname = `${institutionName} · ${String(account.name ?? kind)}`.slice(0, 80);
    if (local) {
      local = tx.db.account.id.update({ ...local, balanceCents, nickname, kind });
    } else {
      local = tx.db.account.insert({
        id: 0n, householdId: me.household.id, ownerPersonId: me.person.id, isJoint: false, kind, nickname,
        balanceCents, limitCents: 0n, aprBps: 0, bufferCents: 0n, maturityDay: -1, nessieId,
      });
    }
    localIds.set(account.account_id, local.id);
  }
  for (const row of transactions) {
    const accountId = localIds.get(row.account_id);
    if (accountId === undefined || typeof row.transaction_id !== 'string' || typeof row.amount !== 'number') continue;
    if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
    const nessieId = `plaid:${row.transaction_id}`;
    if ([...tx.db.txn.nessieId.filter(nessieId)].length) continue;
    tx.db.txn.insert({
      id: 0n, householdId: me.household.id, accountId, day: isoToSimDay(row.date), amountCents: plaidAmountCents(row.amount),
      category: plaidCategory(row.personal_finance_category?.primary), merchantCode: 'PLAID',
      rawDescription: String(row.name ?? row.merchant_name ?? 'Bank transaction').slice(0, 200), nessieId,
    });
    count += 1;
  }
  if (me.household.baselineScenarioId !== 0n) recomputeScenario(tx, me.household.baselineScenarioId);
  return JSON.stringify({ accounts: localIds.size, newTransactions: count, institution: institutionName });
}

export function registerPlaid(db: typeof database) {
  const bankConnectionMode = db.procedure({}, t.string(), ctx => ctx.withTx(tx => bankMode(requireMember(tx).household.inviteCode)));

  const importSandboxBank = db.procedure({}, t.string(), ctx => {
    const http: PlaidHttp = { fetch: (url, init) => ctx.http.fetch(url, init) };
    const setup = ctx.withTx(tx => {
      const me = requireMember(tx);
      if (me.household.inviteCode !== DEMO_INVITE_CODE) throw Error('Sandbox bank data is only for the demo household.');
      const existing = [...tx.db.plaidItem.ownerPersonId.filter(me.person.id)].find(row => row.householdId === me.household.id && row.environment === 'sandbox');
      return { credentials: credentials(tx, 'sandbox'), personId: me.person.id, householdId: me.household.id, accessToken: existing?.accessToken ?? '', itemId: existing?.itemId ?? '' };
    });
    let accessToken = setup.accessToken;
    let itemId = setup.itemId;
    if (!accessToken) {
      const created = plaidRequest(http, setup.credentials, '/sandbox/public_token/create', { institution_id: PLATYPUS, initial_products: ['transactions'] });
      const exchanged = plaidRequest(http, setup.credentials, '/item/public_token/exchange', { public_token: created.public_token });
      accessToken = String(exchanged.access_token ?? '');
      itemId = String(exchanged.item_id ?? '');
      if (!accessToken || !itemId) throw Error('Plaid did not return a sandbox connection.');
    }
    const listed = plaidRequest(http, setup.credentials, '/accounts/get', { access_token: accessToken });
    const transactions = postedTransactions(http, setup.credentials, accessToken);
    return ctx.withTx(tx => {
      const me = requireMember(tx);
      if (me.person.id !== setup.personId || me.household.id !== setup.householdId) throw Error('Household membership changed. Retry.');
      rememberItem(tx, me, itemId, accessToken, 'sandbox', 'First Platypus Bank');
      return writeAccounts(tx, me, 'First Platypus Bank', listed.accounts, transactions);
    });
  });

  const createPlaidLinkToken = db.procedure({}, t.string(), ctx => {
    const http: PlaidHttp = { fetch: (url, init) => ctx.http.fetch(url, init) };
    const setup = ctx.withTx(tx => {
      const me = requireMember(tx);
      if (me.household.inviteCode === DEMO_INVITE_CODE) throw Error('This demo household loads sandbox bank data directly.');
      return { credentials: credentials(tx, 'production'), personId: me.person.id };
    });
    const created = plaidRequest(http, setup.credentials, '/link/token/create', {
      client_name: 'Tandem', language: 'en', country_codes: ['US'],
      user: { client_user_id: String(setup.personId) }, products: ['transactions'],
    });
    if (typeof created.link_token !== 'string' || !created.link_token) throw Error('Plaid did not return a link token.');
    return created.link_token;
  });

  const connectPlaidBank = db.procedure({ publicToken: t.string(), institutionName: t.string() }, t.string(), (ctx, { publicToken, institutionName }) => {
    const http: PlaidHttp = { fetch: (url, init) => ctx.http.fetch(url, init) };
    const name = institutionName.trim().slice(0, 60) || 'Bank';
    const setup = ctx.withTx(tx => {
      const me = requireMember(tx);
      if (me.household.inviteCode === DEMO_INVITE_CODE) throw Error('This demo household loads sandbox bank data directly.');
      if (!publicToken.startsWith('public-production-')) throw Error('That bank login cannot be used for this household.');
      return { credentials: credentials(tx, 'production'), personId: me.person.id, householdId: me.household.id };
    });
    const exchanged = plaidRequest(http, setup.credentials, '/item/public_token/exchange', { public_token: publicToken });
    const accessToken = String(exchanged.access_token ?? '');
    const itemId = String(exchanged.item_id ?? '');
    if (!accessToken || !itemId) throw Error('Plaid did not return a bank connection.');
    const listed = plaidRequest(http, setup.credentials, '/accounts/get', { access_token: accessToken });
    const transactions = postedTransactions(http, setup.credentials, accessToken);
    return ctx.withTx(tx => {
      const me = requireMember(tx);
      if (me.person.id !== setup.personId || me.household.id !== setup.householdId) throw Error('Household membership changed. Retry.');
      rememberItem(tx, me, itemId, accessToken, 'production', name);
      return writeAccounts(tx, me, name, listed.accounts, transactions);
    });
  });

  return { bankConnectionMode, importSandboxBank, createPlaidLinkToken, connectPlaidBank };
}
