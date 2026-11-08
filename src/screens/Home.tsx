import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings/index.ts';

export function HomeScreen() {
  const [people] = useTable(tables.householdPeople);
  const [accounts] = useTable(tables.myAccounts);

  return (
    <section className="screen">
      <h1>Household</h1>
      <div className="seats">
        {people.map(person => (
          <article className="seat" key={person.id.toString()}>
            <div>
              <strong>{person.displayName}</strong>
              <p>{person.role === 'coowner' ? 'Co-owner' : 'Member'}</p>
            </div>
            <span
              className={person.online ? 'dot on' : 'dot'}
              aria-label={person.online ? 'Online' : 'Offline'}
            />
          </article>
        ))}
      </div>
      <article className="card placeholder">
        <h2>Household Score</h2>
        <p className="empty">The score arrives with the forecast.</p>
      </article>
      <article className="card placeholder">
        <h2>Next crunch</h2>
        <p className="empty">The next tight day arrives with the forecast.</p>
      </article>
      {accounts.length === 0 ? <p className="empty">No accounts are visible yet.</p> : null}
    </section>
  );
}
