# Run Tandem locally

Local database: `tandem-nessie-local`, at `http://127.0.0.1:3000`.
Frontend: `http://127.0.0.1:5174/`.

The existing server at port 5173 was left untouched. Port 5174 supports the demo-login path. Email/OIDC login still requires the registered callback origins on port 5173; do not expect it to work on 5174 until that origin is registered.

## Current machine setup

- SpacetimeDB 2.14.1 downloaded into the workspace's `work/spacetime-tools` directory.
- Local database published and household PATELS seeded.
- Local database/config state is in workspace `work/`, outside the Git repo.
- `spacetime.local.json` contains server-only AI, fallback, Nessie, and admin configuration. It is gitignored.
- `.env.local` targets this local database and enables the engine's confirmed negative-expense convention. It is gitignored.
- `spacetimedb/.env` and `.nessie-seed.json` hold Nessie configuration/provisioning state and are gitignored.
- The backend uses `AI_API_KEY`, not `NVIDIA_API_KEY`. The second supplied NVIDIA credential is configured as `AI_FALLBACK_API_KEY`.

## Start

From the repository root, in one terminal:

```sh
npm run local:server
```

Then in a second terminal if the web server is not already running:

```sh
npm run local:web
```

After a backend code/config change, while the database server is running:

```sh
npm run local:publish
```

On another machine, install the Spacetime CLI first. The runner uses `SPACETIME_CLI` when provided, the workspace download when available, or `spacetime` from PATH. This machine's credentials and database are deliberately not committed. Recreate the gitignored configuration from the documented examples when moving the demo.

## Demo

1. Open `http://127.0.0.1:5174/` and choose the demo-login option.
2. Join with invite code `PATELS` and listed name `priya` or `sam`; use `maya` for the restricted member view.
3. Priya and Sam currently have demo PIN `1234` from the local verification. Change it through the PIN screen if desired.
4. Accounts → Connect demo banking imports the signed-in member's Nessie records.
5. Plan → purchase planner: select a full-access checking account, enter a price/purpose, and choose a date covered by the forecast (local day zero is November 1, 2026).
6. Use separate browser profiles for Priya and Sam. Propose a shared change, review its impact, verify each PIN, and approve.
7. Ask Coach a financial question. Results explicitly identify the fallback if the model is unavailable.

## Verified and unresolved

Verified against the local database: household seed/join; PIN setup/verification; scenario fork; purchase change and recomputation; proposal; both co-owner votes; merging the approved plan into a new baseline. The local test proposal is retained in the database.

Verified directly with providers: Nessie customer/account/transaction endpoints; both NVIDIA keys and the configured Nemotron model returned HTTP 200.

Runtime issue in the Codex execution session: Spacetime's native macOS HTTPS client returns `bad certificate format` for provider requests. Node HTTPS calls succeed. Neither network permission nor system certificate-store read access resolved it. TLS verification was not disabled. The Codex-started database process is stopped for handoff; run `npm run local:server` in your own terminal and retry Accounts → Connect demo banking and Coach. If the certificate error persists there, provider integration remains blocked on the machine's native TLS configuration.

The UI is not a production banking service. Sign-in registration, one-time share-token endpoints, and exclusive edit locks retain their existing limitations. Local completion does not mean every planned production feature is implemented.
