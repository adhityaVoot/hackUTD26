import { useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings/index.ts';
import { fmtPct } from '../lib/money.ts';

export function VitalsScreen() {
  const [vitals] = useTable(tables.myVitals);
  const [open, setOpen] = useState<string | null>(null);
  const rows = vitals.filter(row => row.scopePersonId === 0n);
  return (
    <section className="screen">
      <h1>Vitals</h1>
      {rows.length === 0 ? <p className="empty">Add your first account to see your vitals.</p> : null}
      {rows.map(row => (
        <article className="card" key={row.id.toString()}>
          <div className="row-title">
            <strong>{row.key.split('_').join(' ')}</strong>
            <span className={`band ${row.band}`}>{row.band}</span>
          </div>
          <p>{row.key.includes('risk') || row.key === 'dti' || row.key === 'utilization' || row.key === 'savings_rate' ? fmtPct(row.value) : row.value.toFixed(1)}</p>
          <p>{row.why}</p>
          <button className="secondary" type="button" onClick={() => setOpen(open === row.key ? null : row.key)}>
            Show the math
          </button>
          {open === row.key ? <p className="muted">{row.mathJson}</p> : null}
        </article>
      ))}
    </section>
  );
}
