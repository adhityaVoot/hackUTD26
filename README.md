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

- Join with invite code `PATELS` and persona `priya`, `sam`, or `maya`.
- Membership is subscribed from the caller-scoped `my_member` view using the generated bindings imported from `origin/test`.
- The session bar shows the server-provided display name, role, household ID, and five-minute step-up expiration countdown.
- PIN setup and verification call the authenticated HTTP reducers `set_pin` and `verify_pin`; reducer values are read through the live view, not assumed from request success.
- At implementation time the live schema exposed `join_household` and `set_pin` but not `verify_pin`. Verification shows a deployment error until that reducer is published.
- Use distinct browser profiles or a private window for distinct identities. Tabs in one profile share the persisted SDK token. Rejoining a persona can rebind its demo identity.
- PINs are never stored in localStorage. Only the SDK identity token is persisted for reconnection.

Financial accounts, forecasts, tickets, role preview, and local approval workflows remain synthetic frontend prototypes; the live session does not make those backend-authorized or shared across devices. Account names and request tickets are stored locally.

Validation: production build passes; a read-only live WebSocket connection and `my_member` subscription succeeded. No real persona was rebound and no PIN was changed during verification.
