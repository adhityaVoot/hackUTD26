# Kitchen Table

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

The live client adapter in `src/liveBindings.ts` subscribes only to caller-scoped public views: `my_member`, `my_household`, `household_people`, `my_accounts`, `my_grants`, and `household_consent_log`. Seats, presence, simulation day, sharing labels, active grant countdowns, and the consent log use these server views. The read-only privacy panel includes a no-shared-accounts empty state. Server call failures produce dismissible toasts.

The create-household form is present, but creation is unavailable until the backend deploys a creation endpoint. It does not pretend to create a local household. Account and planning demo fixtures remain separate from live sharing data.

Validation: production build and read-only subscriptions to all six live views passed. Join/PIN mutations were not executed against existing family personas during validation.
