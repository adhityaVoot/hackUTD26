import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from './module_bindings/index.ts';
import KitchenTable from './kitchen/KitchenTable.jsx';
import './styles/live.css';

const HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'tandem-hackutd';

function shortHex(hex: string): string {
  if (hex.length <= 14) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

export default function App() {
  const { isActive, identity, connectionId, connectionError } = useSpacetimeDB();
  const [members, membersReady] = useTable(tables.myMember);
  const me = members[0];
  const status = connectionError ? 'error' : isActive ? 'connected' : 'connecting';
  const label = connectionError
    ? 'Connection error'
    : isActive
      ? 'Connected'
      : 'Connecting';
  const membership = !membersReady
    ? 'my_member subscribing'
    : me
      ? `my_member live · ${me.displayName} · ${me.role}`
      : 'my_member live · no household row yet';

  return (
    <>
      <KitchenTable />
      <aside className={`live-link ${status}`} aria-live="polite">
        <i className="live-dot" aria-hidden="true" />
        <strong>SpacetimeDB · {label}</strong>
        <span>{DB_NAME}</span>
        <span>{HOST}</span>
        <span>
          identity {identity ? shortHex(identity.toHexString()) : 'pending'}
        </span>
        <span>connection {shortHex(connectionId.toHexString())}</span>
        <span>{membership}</span>
        {connectionError ? <span>{connectionError.message}</span> : null}
      </aside>
    </>
  );
}
