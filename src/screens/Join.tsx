import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useProcedure, useReducer } from 'spacetimedb/react';
import { procedures, reducers } from '../module_bindings/index.ts';
import { errorMessage, runReducer, useToast } from '../lib/toast.tsx';

export function JoinScreen() {
  const navigate = useNavigate();
  const { showError } = useToast();
  const joinHousehold = useReducer(reducers.joinHousehold);
  const setPin = useReducer(reducers.setPin);
  const verifyPin = useProcedure(procedures.verifyPin);
  const [inviteCode, setInviteCode] = useState('');
  const [name, setName] = useState('');
  const [pin, setPinValue] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!/^[0-9]{4,6}$/.test(pin)) {
      showError('PIN must be 4 to 6 digits');
      return;
    }
    setBusy(true);
    const joined = await runReducer(
      () => joinHousehold({ inviteCode: inviteCode.trim(), name: name.trim() }),
      showError,
    );
    if (!joined) {
      setBusy(false);
      return;
    }
    let pinned = false;
    try {
      await setPin({ pin });
      pinned = true;
    } catch (err) {
      if (errorMessage(err) === 'PIN required') {
        try {
          await verifyPin({ pin });
          pinned = true;
        } catch (verifyErr) {
          showError(verifyErr);
        }
      } else {
        showError(err);
      }
    }
    setBusy(false);
    if (pinned) navigate('/');
  }

  return (
    <section className="join">
      <h1>Join your household</h1>
      <p className="muted">Use the name your household lists, then choose a PIN.</p>
      <form onSubmit={onSubmit}>
        <label>
          Invite code
          <input
            value={inviteCode}
            onChange={event => setInviteCode(event.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <label>
          Your name
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            autoComplete="name"
            required
          />
        </label>
        <label>
          PIN
          <input
            value={pin}
            onChange={event => setPinValue(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            minLength={4}
            maxLength={6}
            required
          />
        </label>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Joining…' : 'Join household'}
          </button>
          <Link className="secondary" to="/setup">
            Create a new household
          </Link>
        </div>
      </form>
    </section>
  );
}
