import { useEffect, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings/index.ts';
import { fmtCents } from '../lib/money.ts';

function countdown(expiresAtMicros: bigint, now: number): string {
  const end = Number(expiresAtMicros / 1000n);
  const remaining = end - now;
  if (remaining <= 0) return 'Ended';
  const totalSeconds = Math.floor(remaining / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function label(value: string): string {
  if (value === 'coowner') return 'Co-owner';
  if (value === 'full') return 'Full';
  if (value === 'summary') return 'Summary';
  if (value === 'signal') return 'Signal';
  return value.replace('_', ' ');
}

export function PrivacyScreen() {
  const [accounts] = useTable(tables.myAccounts);
  const [grants] = useTable(tables.myGrants);
  const [consent] = useTable(tables.householdConsentLog);
  const [people] = useTable(tables.householdPeople);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const active = grants.filter(grant => grant.status === 'active');
  const nameFor = (personId: bigint) =>
    people.find(person => person.id === personId)?.displayName ?? 'Household';

  return (
    <section className="screen">
      <h1>Privacy</h1>
      <h2>Accounts</h2>
      {accounts.length === 0 ? <p className="empty">No accounts are visible yet.</p> : null}
      <ul className="list">
        {accounts.map(account => (
          <li className="account" key={account.id.toString()}>
            <div className="row-title">
              <strong>{account.nickname}</strong>
              <span className="band">{label(account.visibility)}</span>
            </div>
            <p>
              {label(account.kind)} · {fmtCents(account.balanceCents)}
            </p>
          </li>
        ))}
      </ul>
      <h2>Active grants</h2>
      {active.length === 0 ? <p className="empty">No active grants.</p> : null}
      <ul className="list">
        {active.map(grant => (
          <li className="grant" key={grant.id.toString()}>
            <div className="row-title">
              <strong>{label(grant.level)}</strong>
              <span>{countdown(grant.expiresAt.microsSinceUnixEpoch, now)}</span>
            </div>
            <p>
              From {nameFor(grant.grantorPersonId)}
              {grant.granteePersonId === 0n
                ? ' to the household'
                : ` to ${nameFor(grant.granteePersonId)}`}
            </p>
          </li>
        ))}
      </ul>
      <h2>Consent log</h2>
      {consent.length === 0 ? <p className="empty">No consent entries yet.</p> : null}
      <ul className="list">
        {consent.map(entry => (
          <li className="log" key={entry.id.toString()}>
            <strong>{entry.action.split('_').join(' ')}</strong>
            <p>
              {nameFor(entry.actorPersonId)}
              {entry.detail ? ` · ${entry.detail}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
