# Tandem × Capital One Nessie demo

This integration uses real Nessie HTTP calls with synthetic bank records. It does not connect to real customer banking or move real money. API keys never pass through React.

## What is implemented

- Accounts → Connect demo banking calls the `sync_nessie_demo` Spacetime procedure.
- The server chooses the customer from `inviteCode:personaKey`, based on the authenticated caller. The browser cannot select someone else's customer ID.
- Imports checking, savings, and credit-card balances; completed deposits, withdrawals, purchases, and both sides of transfers. Pending and cancelled transactions are excluded.
- Repeated refreshes preserve local account names and skip previously imported transactions. Provider balances are authoritative; the import does not apply transactions to balances again.
- Imported accounts are personal, not automatically shared. Existing permission-filtered views and explicit grants apply.
- Refresh fits variable spending from imported history (excluding transfers) and recomputes the baseline. It does not infer reliable future paychecks/bills from three sample transactions.
- No new web server: external reads happen in a Spacetime procedure, then an atomic transaction updates the application.

## Setup

Get a developer key at https://nessieisreal.com/getting-started. Use the API base URL provided by your sponsor environment; the default is `https://api.nessieisreal.com`. Override `NESSIE_BASE_URL` if your key belongs to another host.

1. Store the key in a gitignored `spacetimedb/.env` (copy `.env.example`). Do not put it in `VITE_*` variables.
2. From the repository root, provision each synthetic customer:

```sh
node --env-file=spacetimedb/.env scripts/seed-nessie.mjs priya
node --env-file=spacetimedb/.env scripts/seed-nessie.mjs sam
node --env-file=spacetimedb/.env scripts/seed-nessie.mjs maya
```

The script prints customer mappings and saves resource IDs in gitignored `.nessie-seed.json`. Combine the printed entries into the server's `NESSIE_DEMO_CUSTOMERS` JSON. Use the household's actual invite code and persona keys. The script creates two accounts per member and three historical checking transactions. Nessie may process newly created transactions asynchronously; sync again once they are completed.

The state file makes completed provisioning steps reusable. A timeout after a provider write is ambiguous: inspect the Nessie dashboard before retrying to avoid creating duplicate remote resources. Use a separate state file with `NESSIE_SEED_STATE` if switching API keys/hosts.

3. Export the three Nessie variables into the terminal used to publish. A `.env` file alone does not configure a deployed Spacetime module. For trusted, developer-authored dotenv contents:

```sh
set -a
source spacetimedb/.env
set +a
spacetime publish tandem-nessie-demo --module-path spacetimedb --server maincloud
```

Use a separate demo database; do not delete an existing database's data. Follow migration prompts. The CLI must be installed and authenticated. Backend environment declarations include all three variables; publishing reads declared shell values.

4. Point the frontend's gitignored `.env.local` at that database:

```dotenv
VITE_SPACETIMEDB_DB_NAME=tandem-nessie-demo
VITE_SPACETIMEDB_HOST=wss://maincloud.spacetimedb.com
```

Initialize a demo household using your existing seed flow (or create a household), then match `NESSIE_DEMO_CUSTOMERS` to its actual invite code and persona keys. The import intentionally does not replace existing synthetic local accounts; imported accounts are additional, separately owned records. For a clean banking demo, use a fresh household with only the intended accounts.

5. Run `npm run dev`, sign in or use the demo path, join the household, and open Accounts → Connect demo banking.

## Verify the judge flow

- Priya connects: only her mapped customer is requested, and her imported accounts appear through the existing live subscriptions.
- Open Sam in another browser profile: he must not receive Priya's private account details without a grant.
- Refresh twice: account/transaction counts remain stable.
- Update a synthetic account or add a completed transaction in Nessie; refresh and verify balances/history update.
- Check forecast assumptions. Configure future bills, income, APRs, card limits, and cash buffers using the existing management tools. Missing values are not invented by the integration.

## Checks and limits

Run `npm run test:nessie`, `npm run build`, and `npx tsc --noEmit -p spacetimedb/tsconfig.json`.

Sync is manual. No webhooks, bank-password collection, payment execution, bill/loan import, deletion reconciliation, or real-bank access is included. Historic imported transactions are append-only; later provider corrections to an already imported transaction need reconciliation support. Provider current balances are independent of the Time Machine's simulated date: stop simulated time before syncing and use a known demo date. Existing scenario forks may need recomputation after refreshing the baseline.

A missing key/mapping produces a configuration error rather than silently substituting local data. Live API verification requires your key and deployment. Source docs: https://nessieisreal.com/docs and https://spacetimedb.com/docs/functions/procedures/.
