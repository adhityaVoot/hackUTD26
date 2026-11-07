# Cursor prompt sequence — Tandem

Paste these into Cursor **Agent mode**, in order. One prompt = one task. Don't move on until its **Check** passes. Each prompt assumes `TANDEM_SPEC.md` and `.cursor/rules/tandem.mdc` are in the repo root.

Who runs it: **[BE]** backend lead, **[DS]** data/ML lead, **[FE]** frontend lead, **[PL]** product lead.

---

## Phase 0 — Setup (one person, ~45 min)

**Before Cursor (terminal):**
```bash
curl -sSf https://install.spacetimedb.com | sh
spacetime login
spacetime dev --template react-ts      # name the project tandem
```
Copy `TANDEM_SPEC.md`, `CURSOR_PROMPTS.md` and `.cursor/rules/tandem.mdc` into the project root. Keep the SpacetimeDB rule files the template added.

Check Nessie from your laptop (replace KEY):
```bash
curl "https://prod-api.nessieisreal.com/customers?key=KEY"
curl "http://api.nessieisreal.com/customers?key=KEY"
```
Whichever returns JSON is your `NESSIE_BASE_URL`.

**P0.1 [BE]**
```
Read TANDEM_SPEC.md sections 1–5. Set up the project skeleton from section 4:
- create the folders in "Target layout" with empty placeholder files (engine/, ai/, nessie/, src/screens, src/components, src/hooks, src/lib, src/styles/tokens.css)
- add spacetime.local.json to .gitignore (and spacetime.*.local.json)
- create spacetime.local.json with the env keys from section 5.3 and empty-string placeholders I will fill in
- add vitest as a devDependency for spacetimedb/ and a "test" script
- install react-router-dom and recharts in the client
Do not write any tables or reducers yet. Tell me exactly how to verify the app still runs.
```
**Check:** `spacetime dev` still runs; two browser windows show the template's live updates.

---

## Phase 1 — Foundations (4:00–8:00 PM)

**P1.1 [BE] — schema**
```
Read TANDEM_SPEC.md sections 3, 5 and 6. Create spacetimedb/src/tables.ts with EXACTLY the tables in section 6 (all private, same columns, indexes and types). In spacetimedb/src/index.ts, build `const spacetimedb = schema({...all tables}, { env: {...section 5.3...} })` and `export default spacetimedb`. Remove the template's person table and reducers. Add init/clientConnected/clientDisconnected lifecycle hooks (section 5.5) that only update member.online and lastActiveAt if a member row exists. Do not add other reducers yet. Make sure it publishes.
```
**Check:** `spacetime dev` publishes with no errors; `spacetime describe <db>` lists all tables.

**P1.2 [BE] — auth helpers**
```
Read TANDEM_SPEC.md sections 7 and 10. Create spacetimedb/src/auth.ts with requireMember, requireCoOwner, requireStepUp (5-minute window using ctx.timestamp vs member.stepUpAt), requireAdmin (compares to ctx.env.ADMIN_CODE; always throws if unset). All throw SenderError with clear messages. Keep them as non-exported helpers imported by index.ts. Show me how you typed ctx and which SDK type you used (spec 5.4 VERIFY note).
```

**P1.3 [DS] — engine basics**
```
Read TANDEM_SPEC.md sections 3 and 9. Implement spacetimedb/src/engine/types.ts, rng.ts, calendar.ts (DEMO_START_DATE = '2026-11-01', simDay<->ISO date, cadence expansion for monthly/biweekly/semimonthly/once) and generator.ts. The engine must import NOTHING from spacetimedb. Implement the DEMO Patels config so the story beats in 9.7 hold, plus the backtest population generator. Write vitest tests in engine/__tests__ asserting: same seed = identical output; the demo story beats (crunch ~day 27 >= 55% computed later — for now assert obligations collide within days 25–29 and Maya's balance path dips around day 12). Run the tests.
```
**Check:** `npm test` passes in `spacetimedb/`.

**P1.4 [BE] — seed + join + PIN**
```
Read TANDEM_SPEC.md sections 6, 7 and 10. Implement reducers adminSeedDemo, joinHousehold, setPin, verifyPin exactly as the section 7 table says, using engine/generator.ts. adminSeedDemo also creates the baseline scenario (status 'baseline', set household.baselineScenarioId) and the default Signal grant for Sam's side-business account (90 days, with a grantExpiry one-shot row). PIN hashing per section 10 item 3 (label DEMO). Write consentLog rows. Every reducer starts with the right auth helper.
```
**Check:** `spacetime call <db> admin_seed_demo '{"adminCode":"...","inviteCode":"PATELS"}'` then `spacetime sql <db> "SELECT * FROM person"` shows Priya, Sam, Maya. (Use the reducer name shown by `spacetime describe`.)

**P1.5 [BE] — core views**
```
Read TANDEM_SPEC.md sections 5.8 and 8. Implement the canSee rule and these views: my_member, my_household, my_invite_code, household_people, my_accounts, my_txns, my_obligations, my_grants, household_consent_log. Only indexed lookups (.find/.filter on indexed columns, .count) — no .iter(). Use t.row projections where the spec lists fields. Never include inviteCode except in my_invite_code. Then tell me the generated client accessor names for each view (check src/module_bindings).
```
**Check:** three browsers joined as Priya/Sam/Maya each see only permitted accounts in `my_accounts`.

**P1.6 [FE] — client shell**
```
Read TANDEM_SPEC.md sections 5.9 and 13. Set up src/main.tsx exactly per 5.9 (db name from VITE_SPACETIMEDB_DB_NAME), App.tsx with react-router and a mobile-first layout with bottom tabs (Home, Radar, Futures, Inbox, Privacy) plus /join and /admin routes. Create src/styles/tokens.css (neutral palette, one accent, green/yellow/red bands, large readable type) and lib/money.ts (fmtCents for bigint|number, fmtPct, dayToDate). Build the Join screen (invite code, persona picker, set PIN) and a toast system that shows SenderError messages from awaited reducer calls. If not a member, redirect to /join.
```
**Check:** on a phone, join as Priya → land on Home.

**P1.7 [FE] — Home + Privacy (read-only)**
```
Build Home ("Household" screen: people seats with online dots, placeholders for score and next crunch) and Privacy (per-account list from my_accounts with visibility labels, active grants from my_grants with live countdowns, consent log). Use the generated view accessors. No write actions yet.
```
**Gate 1:** Patels seeded; three devices joined; each sees only permitted accounts.

---

## Phase 2 — Core loop (8:00 PM–12:30 AM)

**P2.1 [DS] — forecast + vitals + levers**
```
Read TANDEM_SPEC.md sections 9.2–9.4 and 9.6. Implement engine/forecast.ts (Monte Carlo, common random numbers, fixed draw order), engine/vitals.ts (six vitals + score with the exact bands and deterministic "why" templates), engine/levers.ts (validateChange + applyChanges) and engine/scope.ts. Add tests: baseline vs fork with zero changes gives identical output; demo crunch around day 27 is >= 55% while day 0 risk < 15%; vitals bands at boundaries; validateChange rejects invisible accounts. Report runtime for 300 paths x 60 days.
```

**P2.2 [BE] — recompute + futures reducers**
```
Read TANDEM_SPEC.md section 7 (fork, addChange, removeChange, propose, vote, merge, recomputeScenario). Implement recomputeScenario as a non-exported helper that builds ForecastInput from tables, runs the engine with household.seed, deletes old forecastDay/vital rows for that scenario and inserts new ones (per visible account + accountId 0 household total). Implement fork, addChange, removeChange, propose, vote with the exact auth rules (approve needs requireStepUp) and the 5-step atomic merge. Call recompute after seeding too.
```

**P2.3 [BE] — remaining core views**
```
Implement views household_scenarios, scenario_changes, my_forecast, my_vitals, household_approvals, household_commitments, my_alerts, household_presence per section 8. Individual-scope scenarios must only appear for their audience. Indexed lookups only.
```

**P2.4 [FE] — Vitals, Radar, Futures, Co-sign**
```
Read TANDEM_SPEC.md section 13. Build: Vitals screen (VitalCard with band icon+word, why, show-your-math drawer, household / just-me toggle); Radar (recharts p10–p90 band + p50 line + buffer line for household total and each visible account, CrunchStrip 60-day risk calendar); Futures list + Future detail (lever forms for each change kind in spec 9.4, DiffTable of every vital before→after + goal ETA shift, Propose); Co-sign card modal (three impact numbers ABOVE buttons, PinPad when step-up expired, approve/decline/counter, who has signed). Numbers that change flash briefly.
```

**P2.5 [BE+FE] — grants**
```
Implement createGrant, revokeGrant, renewGrant and the scheduled expireGrant per sections 7 and 10 (max 90 days, demo minimum 60 seconds, step-up required, consentLog, alert to grantee on expiry). Wire the Privacy screen: grant sheet (level, duration 2 min / 1 / 7 / 30 / 90 days, history window), revoke, renew, countdowns.
```
**Gate 2:** fork → diff → co-sign (PIN) → merge works across two phones; a 2-minute grant expires live and the data disappears.

---

## Phase 3 — Agents, time, Nessie (12:30–4:00 AM)

**P3.1 [BE] — Time Machine**
```
Implement startClock, stopClock and the scheduled tick reducer per section 7: advance simDay, move that day's futureTxn rows into txn and update balances, mark due commitments, recompute the baseline, stop at day 60. Add a Time Machine control to Admin (speed: seconds per day) and a sim-date indicator in the header.
```

**P3.2 [DS] — candidates**
```
Implement engine/candidates.ts per section 9.5 (Sentinel candidates and Mediator candidates), deterministic, same seed, ranked, top 3 with numbers. Tests: for the demo crunch at least one candidate brings risk < 10% without worsening other vitals > 5%.
```

**P3.3 [BE] — Sentinel + AI pipeline with fallback**
```
Read TANDEM_SPEC.md section 11. In tick (after recompute): if any day in the next 30 has pBelowBuffer > 0.25 and there's no open Sentinel proposal for that crunch, compute candidates, store them in an aiRun (kind 'sentinel', inputJson = sanitized payload) and insert an aiJob at now. Implement ai/gateway.ts (allowlist, per-run pseudonyms via ctx.random, PII + injection scan), ai/prompts.ts (Sentinel prompt from 11.4), ai/model.ts (OpenAI-compatible call using env vars), and the runAiJob procedure (onSchedule aiJob) following 11.5. On any failure, missing key, or aiEnabled=false: fallback to the top candidate with the deterministic template (status 'fallback'). Reject AI text with digits; overwrite title with the candidate label; fill slots from engine numbers. Write agentLog for every step. Route alerts per scope. Add setAiEnabled (kill switch) and adminRedTeamSeed.
```
**Check:** Time Machine run → Sentinel proposal appears on both co-owner phones; with the kill switch off it still appears (fallback); red-team merchant shows `injection_flag` in agent log and is absent from inputJson.

**P3.4 [DS] — Nessie**
```
Read TANDEM_SPEC.md section 12. Implement nessie/client.ts and mapping.ts and the nessieWorker procedure (onSchedule nessieJob) handling kinds seed (20 requests per run, re-schedules itself with cursor+20), sync (upsert txn by nessieId, update balances, nessieStatus) and execute (POST transfers for queued commitments, retries up to 3 with a one-shot reschedule). Amounts in Nessie are dollars. Use ctx.env.NESSIE_BASE_URL and key as ?key=. Add adminNessieSeed and adminNessieSync, nessie_status_view, and an Admin panel showing status and latest transfer ids. Before writing POST bodies, show me the field names you'll use so I can check them against the Nessie docs.
```
**Gate 3:** Sentinel proposes a fix live; a co-signed transfer shows up in Nessie with its id on the laptop.

---

## Phase 4 — Polish (4:00–8:00 AM, feature freeze at 8)

**P4.1 [BE+FE] — routed alert (Maya)**
```
Make Maya's crunch a 'routed' recommendation: alert to the helper co-owner with the risk signal only (no transactions), proposal = transfer from the helper's checking to Maya's account, approval needed from the helper only, executes through Nessie. Build the Inbox screen with Private and Shared sections and promoteRecommendation.
```

**P4.2 [BE+FE] — Coach and Mediator (P1)**
```
Implement askCoach (rate limit via aiUsage) and requestMediation per sections 7, 9.5 and 11. Coach output levers map back from tokens, are validated against the requester's visible accounts, and create a draft fork authored by the requester. Build the Coach screen (chat, replies render as fork cards with diffs) and the "Ask Mediator" button on the co-sign card.
```

**P4.3 [DS] — backtest (P1)**
```
Implement adminRunBacktest and a scheduled batch reducer (50 households per run) computing recall at 5+ days, precision, median lead time, p10–p90 band coverage, Brier score, and the naive-forecast recall baseline, written to backtestResult. Show results in Admin. Report the real numbers to the team.
```

**P4.4 [FE] — demo polish**
```
Read TANDEM_SPEC.md section 14. Walk the demo script beat by beat and fix anything that doesn't work live on three phones. Add presence heartbeat (every 10s) and "X is editing" labels on Futures. Test every screen at projector size. Make every reducer error show a readable toast.
```

---

## Phase 5 — Ship (8:00–11:00 AM)

**P5.1 [PL]**
```
Read TANDEM_SPEC.md section 16. Write README.md with every listed section, using the real backtest numbers from Admin. Include an "Everything runs on Spacetime" section listing all tables, reducers, views, schedules and procedures from index.ts, and state that the only outbound calls (AI model, Nessie) are made from Spacetime procedures.
```
Then: publish to Maincloud, record backup video, rehearse 3 times (one with Wi-Fi off using local `spacetime start` + hotspot), make the repo public, submit to Devpost tagging PNC, Spacetime and Capital One by 10:30 AM.

---

## If Cursor gets stuck
- "Read the official doc page for this first: https://spacetimedb.com/docs/llms-full.txt — then fix it without inventing APIs."
- Errors after a schema change → regenerate bindings (`spacetime dev` or `spacetime generate ...`).
- View errors → you used `.iter()` or looked up an unindexed column.
- `spacetime logs <db> --follow` shows `console.log` from the module.
