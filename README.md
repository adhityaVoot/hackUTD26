# Tandem

Tandem is a shared financial planner for households. Everyone in the household sees the same accounts, balances, and plans in real time, and nobody can commit a change that affects the household until the co-owners approve it. The app is built on SpacetimeDB, with the entire backend running as one Spacetime module. An NVIDIA Nemotron agent reads live household data to explain plans, draft proposals, and flag trade-offs before a decision is made.

**Live site:** [https://tandem-app.us](https://tandem-app.us)

## Try the demo

The demo household (the Patels) is preloaded with synthetic bank data from the Plaid sandbox.

1. Go to [https://tandem-app.us](https://tandem-app.us) and click the card on the landing page.
2. Choose **Sign in**, then **Sign in with household details**.
3. Enter the following and leave "First visit? Set up my PIN" unchecked:

   | Field           | Value    |
   | --------------- | -------- |
   | Invitation code | `PATELS` |
   | Name            | `Priya`  |
   | PIN             | `1234`   |

4. Open **Accounts**. Sandbox accounts and transactions from First Platypus Bank load automatically. If transactions are still preparing, click **Refresh sandbox accounts** once.

Other members of the demo household are `Sam` and `Maya` (same invitation code). Signing in as two members in separate browser profiles shows the real-time proposal and approval flow.

## Use it with your own banks

1. Choose **Create a household** on the sign-in screen, or sign in with Google.
2. Set a name and PIN. Share the generated invitation code with household members.
3. Open **Accounts** and click **Connect a bank**. Plaid Link opens, and connected accounts and transactions sync into the household.

Households other than the demo household always use live Plaid Link. Only the `PATELS` household receives sandbox data.

## What the app does

- **Shared household view.** Accounts, balances, recent transactions, and plans are stored once and streamed to every signed-in member through SpacetimeDB subscriptions.
- **Plans and scenarios.** Members fork the household baseline into "what if" scenarios (a purchase, a trip, a new recurring cost) and see the effect on cash flow before committing.
- **Proposals and approvals.** A scenario becomes a proposal. Each co-owner reviews it and confirms with their PIN. Only approved proposals merge into the baseline.
- **Nemotron assistant.** The assistant answers questions about the household's actual numbers, drafts proposals from plain language, and explains what a change means for each member.
- **Family invitations.** Members can invite others by email. Invitations record the invitee and a code, and are sent when email delivery is configured.

## Architecture

```
React + Vite (src/)           SpacetimeDB module (spacetimedb/)
  renders state     <------>    tables, reducers, procedures
  calls reducers                  - household, person, PIN auth
  subscribes to tables            - accounts, transactions, scenarios
                                  - proposals and approvals
                                  - Plaid procedures (bank sync)
                                  - Nemotron procedures (assistant)
```

Design rules the codebase follows:

- One Spacetime module. The frontend only renders state and calls reducers; it never computes financial results.
- Reducers are deterministic. All network calls (Plaid, Nemotron) happen in procedures.
- All tables are private. Clients see only rows that belong to their household.
- Money is stored as `i64` cents.
- Secrets live in the module environment (`ctx.env`) or gitignored files. Nothing sensitive is in the repository.
- User-facing failures are raised as `SenderError` so the module never panics on bad input.

Authentication is handled by SpacetimeAuth. Members sign in with Google or with household details (invitation code, name, PIN).

## Run locally

Requirements: Node 20+, npm, and the SpacetimeDB CLI (`spacetime`).

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173. Sign-in redirects are registered for `localhost` and `127.0.0.1` on ports 5173 and 5174, plus `tandem-app.us`, so use one of those origins.

By default the frontend connects to the hosted `tandem-hackutd` database on Spacetime Maincloud. Copy `.env.example` to `.env.local` to override connection settings or enable the Google sign-in button:

```
VITE_GOOGLE_SIGN_IN_ENABLED=true
```

### Build the frontend

```bash
npm run build
npm run preview
```

### Work on the module

```bash
cd spacetimedb
npm install
npm test            # unit tests
npm run build       # spacetime build
```

Copy `spacetimedb/.env.example` to `spacetimedb/.env` for local module tests. When publishing, set module secrets through the Spacetime environment rather than committing them. Publish with data preserved:

```bash
spacetime publish tandem-hackutd --server maincloud --module-path spacetimedb --delete-data=never
```

Regenerate client bindings after changing tables or reducers:

```bash
npm run spacetime:generate
```

## Configuration

| Variable                                        | Where            | Purpose                                      |
| ----------------------------------------------- | ---------------- | -------------------------------------------- |
| `PLAID_CLIENT_ID`, `PLAID_SANDBOX_SECRET`       | module env       | Sandbox data for the demo household          |
| `PLAID_SECRET`                                  | module env       | Live Plaid Link for all other households     |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`         | module env       | NVIDIA Nemotron assistant                    |
| `RESEND_API_KEY`, `INVITE_FROM_EMAIL`, `APP_PUBLIC_URL` | module env | Invitation email delivery (optional)       |
| `VITE_GOOGLE_SIGN_IN_ENABLED`                   | frontend `.env.local` / Vercel | Shows the Google sign-in button  |

## Project layout

```
src/                 React frontend
  components/        Accounts, plans, proposals, invitations, sign-in
  HouseholdSession.jsx  Household sign-in and PIN flow
  backendContract.json  Reducer and procedure names used by the UI
spacetimedb/
  src/index.ts       Module entry: schema, reducers, procedures
  src/tables.ts      Table definitions
  src/plaid/         Plaid client, mapping, procedures
  src/ai/            Nemotron assistant
  src/nessie/        Legacy demo data loader
docs/                Setup notes for sign-in, invitations, and demos
```

## Further reading

- [docs/GOOGLE_SIGN_IN.md](docs/GOOGLE_SIGN_IN.md): SpacetimeAuth and Google OAuth setup
- [docs/FAMILY_INVITATIONS.md](docs/FAMILY_INVITATIONS.md): invitation flow and email delivery
- [docs/LOCAL_DEMO.md](docs/LOCAL_DEMO.md): running against a local SpacetimeDB instance

## Built with

SpacetimeDB, SpacetimeAuth, TypeScript, React, Vite, NVIDIA Nemotron, Plaid.
