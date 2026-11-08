# Tandem

React frontend prototype on the `frontend` branch.

## Run

```sh
npm install
npm run dev
```

Open the URL printed by Vite. Click the floating card (or focus it and press Enter) to reveal the dashboard. The entry screen includes a procedural animated galaxy, a metallic card with pointer tilt and light reflections, and reduced-motion support.

Dashboard tabs, proposal approvals, and the coach form are local demonstrations using synthetic data. They do not connect to Spacetime, Nessie, or a model API. Refreshing resets demo state. No real money moves. The card is an original CSS illustration inspired by the supplied reference, not a functional payment card.

## Build

```sh
npm run build
npm run preview
```

## Live household access

The session bar connects to `tandem-hackutd` on Maincloud by default. Copy `.env.example` to `.env.local` to target another deployment, then restart Vite.

- Join with invite code `PATELS`, the name exactly as listed by the household, and a 4–6 digit demo PIN.
- Membership is subscribed from the caller-scoped `my_member` view using the generated bindings imported from `origin/test`.
- The session bar shows the server-provided display name, role, household ID, and five-minute step-up expiration countdown.
- PIN setup and verification call the authenticated HTTP reducers `set_pin` and `verify_pin`; reducer values are read through the live view, not assumed from request success.
- The current deployment exposes `verify_pin` as a procedure, called through the authenticated call endpoint.
- Use distinct browser profiles or a private window for distinct identities. Tabs in one profile share the persisted SDK token. Rejoining a persona can rebind its demo identity.
- PINs are never stored in localStorage. Only the SDK identity token is persisted for reconnection.

Financial accounts, forecasts, tickets, role preview, and local approval workflows remain synthetic frontend prototypes; the live session does not make those backend-authorized or shared across devices. Account names and request tickets are stored locally.

Validation: production build passes; a read-only live WebSocket connection and `my_member` subscription succeeded. No real persona was rebound and no PIN was changed during verification.


## Household components

The live client adapter in `src/liveBindings.ts` subscribes only to caller-scoped public views recorded in `src/backendContract.json`. Seats, presence, simulation day, sharing labels, active grant countdowns, and the consent log use these server views. The read-only privacy panel includes a no-shared-accounts empty state. Server call failures produce dismissible toasts.

The create-household form now calls the deployed `create_household` reducer. Account and planning demo fixtures remain separate from live sharing data.

Validation: production build and read-only subscriptions to all six live views passed. Join/PIN mutations were not executed against existing family personas during validation.


## Banking workspaces

Secondary navigation adds Crunch Radar, Futures, Inbox, Sharing, Manage, Coach, App access, and Sign in. Admin is excluded from phone navigation and its operational forms are desktop-only. The entry card and galaxy design are retained.

Connected workflows:
- Real p10/p50/p90 forecast rows, per-account selections, and a 60-day below-buffer risk calendar. Missing rows remain unknown; no synthetic confidence bands are drawn.
- Scenario list, fork creation, lever addition/removal, live vital comparisons, proposal submission, and approve/decline/counter. Approval requires server-provided unexpired PIN step-up. Live requests replace the local decision board in the Family requests route.
- Caller-routed private alerts and shared proposal feed with commitments.
- Grant create/revoke/renew forms and PIN verification; only the backend can authorize changes.
- Account create/update, obligation create/remove, goal creation, and transaction entry. Existing bill/goal editing awaits update endpoints; listing goals awaits a safe goals view.

Pending deployment/configuration, visibly disabled:
- Start/stop/speed clock reducers; Coach/Mediator request endpoints; Nessie admin actions, red-team seeding, and backtest execution.
- SpacetimeAuth client ID and provider/redirect configuration.
- Single-use app-token mint/redeem endpoint; no bearer identity token is substituted into a curl command.
- Editing heartbeat and exclusive server lease. Recent visible presence makes the editor read-only, but the frontend does not claim exclusive locking without backend enforcement.

The deployed action signatures and safe view names are captured in `src/backendContract.json`. `act` maps named inputs to verified positional arguments and serializes BigInt IDs as JSON integer literals without rounding. Backend rejection surfaces through the error toast. After a backend deployment, refresh this contract and regenerate the live view adapter before enabling new operations.

Validation: production build; read-only live subscriptions to all 17 views; disconnected/auth-required and joined co-owner render checks; exact 64-bit argument serialization checks. No household data was reset and no production/demo member was rebound during verification.

## Simplified application layout

The everyday banking interface now has exactly four primary destinations:

- **Overview:** a compact live cash snapshot, three server-computed health indicators, upcoming bills, and one next action. Missing server values remain unknown.
- **Plan:** one situation selector, then the appropriate scenario workflow. Coach, detailed risk forecasts, and saved-future editing are contextual disclosures rather than separate navigation destinations.
- **Requests:** open/completed household proposals, impact review with PIN-gated approval, contextual mediation, and approved commitments. Earlier browser-only examples are separated as illustrative drafts.
- **Accounts:** live balances, account drilldown, live transaction history, and a collapsed management area for accounts, bills, goals, and ledger entry.

The header contains only the Tandem brand, household selector, notification bell, and profile menu. Household seats and simulation date appear inside the household selector. Privacy, grants, connected apps, and PIN access live under Settings/profile controls. Admin and Time Machine remain in a separate desktop console. Existing hashes resolve to their new parent destination.

The original card/galaxy entry is retained. Clicking the card opens sign-in for guests or Overview for a joined member. Successful demo joining continues to Overview after PIN setup succeeds.

Checks: production build, DOM interaction checks for four primary tabs, legacy links, account drilldown, transactions, purchase workflow and guest entry; computed responsive styles at 1440px and 375px. These are not native-browser screenshot tests.
