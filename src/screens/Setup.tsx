import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings/index.ts';
import { runReducer, useToast } from '../lib/toast.tsx';

const STEPS = ['Household', 'People', 'Account', 'Bill', 'Spending', 'Goal'];

export function SetupScreen() {
  const navigate = useNavigate();
  const { showError } = useToast();
  const [invite] = useTable(tables.myInviteCode);
  const [accounts] = useTable(tables.myAccounts);
  const [members] = useTable(tables.myMember);
  const createHousehold = useReducer(reducers.createHousehold);
  const addPerson = useReducer(reducers.addPerson);
  const addAccount = useReducer(reducers.addAccount);
  const addObligation = useReducer(reducers.addObligation);
  const setMonthlySpending = useReducer(reducers.setMonthlySpending);
  const addGoal = useReducer(reducers.addGoal);
  const [step, setStep] = useState(0);
  const [householdName, setHouseholdName] = useState('');
  const [myName, setMyName] = useState('');
  const [personName, setPersonName] = useState('');
  const [nickname, setNickname] = useState('Checking');
  const [balance, setBalance] = useState('1000');
  const [bill, setBill] = useState('Rent');
  const [billAmount, setBillAmount] = useState('1200');
  const [spend, setSpend] = useState('400');
  const [goal, setGoal] = useState('Emergency fund');
  const [busy, setBusy] = useState(false);

  async function next(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    let ok = true;
    if (step === 0) {
      ok = await runReducer(
        () => createHousehold({ name: householdName.trim(), myDisplayName: myName.trim() }),
        showError,
      );
    } else if (step === 1 && personName.trim()) {
      ok = await runReducer(() => addPerson({ displayName: personName.trim(), role: 'member' }), showError);
    } else if (step === 2) {
      ok = await runReducer(
        () =>
          addAccount({
            kind: 'checking',
            nickname: nickname.trim() || 'Checking',
            isJoint: false,
            ownerPersonId: members[0]?.personId ?? 0n,
            balanceCents: BigInt(Math.round(Number(balance) * 100)),
            limitCents: 0n,
            aprBps: 0,
            bufferCents: 20_000n,
            maturityDay: -1,
          }),
        showError,
      );
    } else if (step === 3 && accounts[0]) {
      ok = await runReducer(
        () =>
          addObligation({
            accountId: accounts[0].id,
            kind: 'utility',
            label: bill.trim() || 'Bill',
            amountCents: BigInt(Math.round(Number(billAmount) * 100)),
            cadence: 'monthly',
            anchorDate: '2026-11-15',
            flexible: false,
          }),
        showError,
      );
    } else if (step === 4 && accounts[0]) {
      ok = await runReducer(
        () =>
          setMonthlySpending({
            accountId: accounts[0].id,
            category: 'groceries',
            monthlyCents: BigInt(Math.round(Number(spend) * 100)),
          }),
        showError,
      );
    } else if (step === 5 && accounts[0]) {
      ok = await runReducer(
        () =>
          addGoal({
            name: goal.trim() || 'Goal',
            targetCents: 100_000n,
            targetDate: '2027-06-01',
            accountId: accounts[0].id,
            shared: true,
          }),
        showError,
      );
    }
    setBusy(false);
    if (!ok) return;
    if (step === STEPS.length - 1) navigate('/');
    else setStep(step + 1);
  }

  return (
    <section className="join">
      <h1>Create a household</h1>
      <p className="muted">
        Step {step + 1} of {STEPS.length}: {STEPS[step]}
      </p>
      {invite[0] ? <p>Invite code to share: {invite[0].inviteCode}</p> : null}
      <form onSubmit={next}>
        {step === 0 ? (
          <>
            <label>
              Household name
              <input value={householdName} onChange={event => setHouseholdName(event.target.value)} required />
            </label>
            <label>
              Your name
              <input value={myName} onChange={event => setMyName(event.target.value)} required />
            </label>
          </>
        ) : null}
        {step === 1 ? (
          <label>
            Another person, or leave blank
            <input value={personName} onChange={event => setPersonName(event.target.value)} />
          </label>
        ) : null}
        {step === 2 ? (
          <>
            <label>
              Account nickname
              <input value={nickname} onChange={event => setNickname(event.target.value)} />
            </label>
            <label>
              Starting balance ($)
              <input value={balance} onChange={event => setBalance(event.target.value)} inputMode="decimal" />
            </label>
          </>
        ) : null}
        {step === 3 ? (
          <>
            <label>
              Monthly bill
              <input value={bill} onChange={event => setBill(event.target.value)} />
            </label>
            <label>
              Amount ($)
              <input value={billAmount} onChange={event => setBillAmount(event.target.value)} inputMode="decimal" />
            </label>
          </>
        ) : null}
        {step === 4 ? (
          <label>
            Groceries per month ($)
            <input value={spend} onChange={event => setSpend(event.target.value)} inputMode="decimal" />
          </label>
        ) : null}
        {step === 5 ? (
          <label>
            Goal name
            <input value={goal} onChange={event => setGoal(event.target.value)} />
          </label>
        ) : null}
        <button className="primary" type="submit" disabled={busy}>
          {step === STEPS.length - 1 ? 'Finish' : 'Continue'}
        </button>
      </form>
    </section>
  );
}
