import { createContext, useContext, type ReactNode } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';

type Book = {
  id: string;
  rawId: bigint;
  name: string;
  type: string;
  bank: string;
  owner: string;
  balance: number;
  last4: string;
  detail: string;
  liquid: boolean;
  payment?: number;
  apr?: string;
  limit?: number;
};

type LiveValue = {
  me: { personId: bigint; displayName: string } | undefined;
  household: { name: string; baselineScenarioId: bigint; simDay: number } | undefined;
  books: Book[];
  vital: (key: string) => { value: number; band: string; why: string } | undefined;
  scenarios: readonly { id: bigint; title: string; status: string }[];
  fork: (args: { parentId: bigint; title: string }) => Promise<void>;
  addChange: (args: { scenarioId: bigint; kind: string; paramsJson: string; label: string }) => Promise<void>;
  propose: (args: { scenarioId: bigint }) => Promise<void>;
  vote: (args: { scenarioId: bigint; decision: string }) => Promise<void>;
  seriesFor: (accountId: bigint) => number[];
};

const LiveBooks = createContext<LiveValue | null>(null);

const DEBT = new Set(['credit_card', 'auto_loan', 'personal_loan', 'mortgage']);
const LIQUID = new Set(['checking', 'savings']);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [members] = useTable(tables.myMember);
  const [households] = useTable(tables.myHousehold);
  const [accounts] = useTable(tables.myAccounts);
  const [vitals] = useTable(tables.myVitals);
  const [scenarios] = useTable(tables.householdScenarios);
  const [forecast] = useTable(tables.myForecast);
  const fork = useReducer(reducers.fork);
  const addChange = useReducer(reducers.addChange);
  const propose = useReducer(reducers.propose);
  const vote = useReducer(reducers.vote);
  const me = members[0];
  const household = households[0];
  const books: Book[] = accounts.map(account => ({
    id: account.id.toString(),
    rawId: account.id,
    name: account.nickname,
    type: account.kind.split('_').join(' '),
    bank: 'Household',
    owner: account.isJoint ? 'Joint' : me && account.ownerPersonId === me.personId ? 'You' : 'Other',
    balance: Number(account.balanceCents) / 100,
    last4: account.id.toString().padStart(4, '0').slice(-4),
    detail: account.visibility === 'full' ? 'Full access' : 'Summary only',
    liquid: LIQUID.has(account.kind),
    payment: DEBT.has(account.kind) ? Number(account.balanceCents) / 100 : undefined,
    apr: account.aprBps ? `${(account.aprBps / 100).toFixed(2)}%` : undefined,
    limit: account.limitCents > 0n ? Number(account.limitCents) / 100 : undefined,
  }));
  const vital = (key: string) => vitals.find(row => row.key === key && row.scopePersonId === 0n);
  function seriesFor(accountId: bigint) {
    if (!household) return [];
    return forecast
      .filter(row => row.accountId === accountId && row.scenarioId === household.baselineScenarioId)
      .sort((a, b) => a.day - b.day)
      .map(row => Number(row.p50Cents) / 100);
  }
  return (
    <LiveBooks.Provider value={{ me, household, books, vital, scenarios, fork, addChange, propose, vote, seriesFor }}>
      {children}
    </LiveBooks.Provider>
  );
}

export function useLiveBooks() {
  return useContext(LiveBooks);
}
