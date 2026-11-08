# Frontend integration status

Verified against `tandem-hackutd` on Maincloud. Existing four-tab navigation is retained.

## Implemented against existing interfaces

- Vital math drawer reads only the `math_json`, reason, value, and band already exposed in `my_vitals`. No client-generated financial explanation is substituted.
- Coach fork cards display baseline/after runway, crunch risk, and health score from same-scope vital rows. Actual replies still require a deployed Coach action.
- Purchase form uses live Full-access checking/savings accounts and baseline rows. Its submission creates a uniquely correlated fork, adds a cents-based one-time change, waits for the committed change and forecast view, then displays baseline/after medians and the recomputed p10–p90 range. It does not use sample accounts or a local forecast model.
- Recent editing presence resolves person IDs to household names. The editor becomes locally read-only while another recent editor is present. This is not a server-enforced lease.
- Admin counters update with subscribed row snapshots. Audit panel searches and exports visible consent/approval records with a SHA-256 payload checksum. This is a scoped audit viewer, not a replacement for a durable immutable audit service.

## Configuration and backend blockers

### Sign-in

Configured with public client ID `client_034tn4mKpPebmrzFj9lznr` using react-oidc-context. Authority: `https://auth.spacetimedb.com/oidc`; scopes `openid profile email`; authorization-code/S256 PKCE. Callback is `${window.location.origin}/callback` and logout is exactly `window.location.origin`.

Registered browser origins: `http://localhost:5173`, `http://127.0.0.1:5173`. Vite does not silently choose another port. Magic-link email is enabled. Google and GitHub are intentionally disabled. No client secret is present.

Authenticated connections pass `auth.user.id_token` to the SDK. Demo login connects with no token and retains PATELS/name/four-digit PIN joining. Identity changes clear all cached household rows. The provider accepted read-only authorization requests for both origins; completing an email link and then checking `my_member` is the remaining manual end-to-end test.

### Purchase expense convention

The checked-in spec says all lever amounts are cents, but does not establish whether a `one_time` expense is signed negative or positive. Confirm and set `VITE_PURCHASE_EXPENSE_SIGN=-1` or `1`. Submission stays disabled until this is explicit. Baseline account forecasts can be viewed meanwhile. Mutating purchase tests were not run against existing family data.

### Goals

The deployment provides `add_goal` and `remove_goal` but no caller-filtered goals view or update action. Suggested projection: `my_goals -> { id, name, target_cents, target_day, account_id, shared }`, with optional explicit current progress. Enforce personal/shared visibility on the server. Publish `update_goal` if editing existing goals is supported. Refresh the generated adapter and backendContract after deployment. Saved-goals UI does not pretend browser drafts are server records.

### Enforceable editing locks

Needed: per-change lease view with owner person ID, expiration and revision; acquire/renew/release actions; atomic lease/revision validation on all change mutations. Scenario presence alone cannot enforce exclusivity. The existing view does not identify a locked change, and no heartbeat or lease reducer is deployed.

### One-time app tokens

Frontend expects `create_share_token({ appName, scope })` returning `{ token, redeemUrl, expiresAt }`, with expiry as an ISO timestamp. The corresponding GET redemption URL accepts `Authorization: Bearer <one-time token>`. Server must scope the grant, enforce expiry, and consume it once atomically. A working curl command is generated only from a valid server response. Redemption origin defaults to the configured Spacetime host; use `VITE_SHARE_REDEEM_ORIGIN` for an explicitly authorized alternate origin. Tokens stay in component memory, not persistent storage. The deployment currently has neither mint nor redemption endpoint, so this flow cannot be end-to-end tested.

### Additional service coverage

Global live-ops metrics and AI audit traces need dedicated authorized views. Current counters and audit export reflect only rows visible to the current caller. No sensitive private-table query or broad fallback is used.
