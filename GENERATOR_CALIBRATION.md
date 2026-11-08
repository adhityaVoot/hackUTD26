# Kitchen Table: Calibrated Synthetic Household Generator

**For:** Claude Code, Antigravity, Cursor, or any coding agent working in the `kitchen-table` repo.
**Tracks:** PNC, NVIDIA, SpacetimeDB. Nessie and Capital One are removed.
**Goal:** Generate synthetic households whose behavior matches published US data, show the sources in the app, and prove it with a validation report.

> **The one-line pitch:** "Every household is synthetic. Every pattern comes from the BLS, the Federal Reserve, the CFPB, and the NY Fed. Here are the sources, and here is the test that proves the population matches them."

---

## 0. Rules for the agent (read first)

1. **Never invent a number.** Every parameter lives in `calibration.ts` with a `source` field. If a value is our own assumption, its source is `"ASSUMPTION"` and it must appear in the Assumptions table (section 9).
2. **Never fetch data at runtime.** All values below are already pulled. Reducers must stay deterministic.
3. **Money is integer cents. Dates are integer day numbers.** Convert at the edges only.
4. **One seeded RNG** (`engine/rng.ts`, mulberry32). The same seed must always produce the same households and the same forecast.
5. **Only the backend lead edits `spacetimedb/src/index.ts`.** The generator lives in `engine/` and is pure TypeScript with no SpacetimeDB imports, so it can be unit tested and reused by the notebook.
6. **Build in the order of the steps below.** Each step ends with a check. Do not move on until it passes.

---

## 1. Files to create

```
kitchen-table/
  spacetimedb/src/
    engine/
      rng.ts              seeded RNG + helpers (uniform, normal, lognormal, bernoulli, pick)
      calibration.ts      every parameter, with value + source + note   (NEW)
      population.ts       draws one household profile from calibration  (NEW)
      generator.ts        turns a profile into 365 days of history + 60 days of obligations
      validate.ts         computes population stats vs targets          (NEW)
    index.ts              reducers: seed_demo, seed_population, validate_population
  docs/
    DATA_SOURCES.md       copy of section 2 and section 9 of this file
  notebooks/
    calibration_check.ipynb   pulls the population via `spacetime sql`, charts it vs targets
```

**Check:** the project builds with empty stubs for each new file.

---

## 2. Sources (already pulled, November 7, 2026)

| # | Source | Publisher | Latest release | What we use it for |
|---|---|---|---|---|
| S1 | Consumer Expenditures, 2025 | BLS | Oct 29, 2026 | Spending by category, income and spending by quintile |
| S2 | Economic Well-Being of U.S. Households in 2025 (SHED) | Federal Reserve Board | May 13, 2026 | Shocks, bill stress, $400 test, card carrying, overdraft rate |
| S3 | Length of Pay Periods in the CES Survey | BLS | Feb 2023 data | Paycheck cadence mix |
| S4 | G.19 Consumer Credit | Federal Reserve Board | Monthly | Credit card APR |
| S5 | Quarterly Report on Household Debt and Credit | NY Fed | Q2 2026 (Aug 11, 2026) | Card balances; limits via S5b |
| S5b | Wolf Street analysis of NY Fed data | Wolf Street (secondary) | Aug 25, 2026 | Aggregate card limit ($5.56T) |
| S6 | State of the Automotive Finance Market | Experian | Q2 2026 | Car payment, loan size, APR, term |
| S7 | Primary Mortgage Market Survey | Freddie Mac (via FRED) | Weekly | Current 30-year mortgage rate |
| S8 | Data Point: Frequent Overdrafters | CFPB | Aug 2017 | Overdraft concentration, checking balances |
| S9 | Weathering Volatility 2.0 | JPMorgan Chase Institute | Oct 2019 | Cash buffers, income volatility |
| S10 | Personal Income and Outlays | BEA | Oct 29, 2026 | Macro saving rate (sanity check only) |

URLs are in section 11.

---

## 3. `calibration.ts`: every parameter

Use this shape for every value:

```ts
export type Param<T> = { value: T; source: string; note?: string };

export const CAL = {
  meta: {
    pulledOn: { value: "2026-11-07", source: "team" },
    dollarsYear: { value: 2025, source: "S1", note: "CE 2025 dollars; no inflation adjustment applied" },
  },
  // ...sections below
} as const;
```

### 3.1 Income and spending scale by quintile (S1, Table 3)

| Quintile | Avg income before taxes | Avg annual spending | Spending scale vs all units |
|---|---|---|---|
| Q1 | $18,125 | $37,935 | 0.463 |
| Q2 | $46,080 | $51,405 | 0.628 |
| Q3 | $78,584 | $68,983 | 0.842 |
| Q4 | $126,349 | $92,250 | 1.126 |
| Q5 | $286,188 | $159,512 | 1.948 |
| All | $110,847 | $81,905 | 1.000 |

- Draw each household's quintile uniformly (20% each), then draw income as `quintileMean × lognormal(0, 0.15)`.
- **Spending scale** = quintile spending ÷ $81,905. Multiply every category below by it.
- Q1 spends more than it earns in CE (students, retirees, under-reported income). For the backtest population, **exclude Q1 by default** and note this in the README. It keeps crunch rates realistic for working households, which is PNC's target segment.

### 3.2 Monthly spending by category, all consumer units (S1, Table 1)

| Category | 2025 annual | Per month | Per day | Model |
|---|---|---|---|---|
| Food at home (groceries) | $6,491 | $541 | $17.77 | Random daily, 3 to 4 trips a week |
| Food away from home (dining) | $4,142 | $345 | $11.34 | Random daily, weekend uplift |
| Shelter | $17,626 | $1,469 | | Fixed: rent or mortgage (section 3.6) |
| Utilities, fuels, public services | $4,931 | $411 | | Fixed monthly bill, seasonal (ASSUMPTION A3) |
| Gasoline and other fuels | $2,503 | $209 | $6.85 | Random, every 5 to 9 days |
| Other vehicle expenses | $4,765 | $397 | | Insurance fixed monthly; repairs come from shocks |
| Healthcare (total) | $6,470 | $539 | | Health insurance fixed; medical shocks separate |
| Health insurance | $4,310 | $359 | | Fixed monthly (payroll deduction or bill) |
| Entertainment | $4,084 | $340 | $11.18 | Random daily + subscriptions |
| Apparel and services | $2,010 | $168 | $5.50 | Random, low frequency |
| Education | $1,583 | $132 | | Only households with a student member |

**Daily model for random categories:**
`amount_today = Bernoulli(p_day) × lognormal(mu, sigma)`, where
- `p_day` = expected trips per day (groceries 0.5, dining 0.45, gas 0.15, entertainment 0.25, apparel 0.06),
- `mu = ln(monthly_target × scale / (30.4 × p_day)) − sigma²/2`, so the **mean** matches the CE monthly target,
- `sigma` = 0.54 (p90 is about 2x the median) for groceries and gas, 0.72 (p90 about 2.5x) for dining, entertainment and apparel.
- Dining on Fri/Sat/Sun: multiply `p_day` by 1.4 and divide weekday `p_day` so the monthly mean is unchanged (ASSUMPTION A2).

**Check:** over 365 days, each category's simulated mean is within ±5% of its target for a 1,000-household test run.

### 3.3 Paycheck cadence (S3)

| Cadence | Share of private establishments |
|---|---|
| Biweekly (every other Friday) | 43.0% |
| Weekly | 27.0% |
| Semimonthly (1st and 15th) | 19.8% |
| Monthly | 10.3% |

- Draw cadence per earner. Dual-earner households draw twice, independently.
- Take-home pay = gross × (1 − effective tax rate). Effective tax rate is **ASSUMPTION A1** (Q2 15%, Q3 20%, Q4 24%, Q5 30%).
- Note: the BLS table counts establishments, not workers. Say "most common pay cadence" in the pitch, not "share of workers."

### 3.4 Credit cards (S2, S4, S5, S5b)

| Parameter | Value | Source |
|---|---|---|
| Has a credit card, income < $25k | 46% | S2 Table 40 |
| Has a credit card, $25k–$49,999 | 71% | S2 Table 40 |
| Has a credit card, $50k–$99,999 | 88% | S2 Table 40 |
| Has a credit card, $100k+ | 97% | S2 Table 40 |
| Carried a balance in past year (among holders), < $25k / $25–50k / $50–100k / $100k+ | 52% / 57% / 50% / 37% | S2 Table 40 |
| Carried a balance, all holders | 45% | S2 Table 40 |
| APR on accounts assessed interest | 22.15% (May 2026) | S4 |
| Aggregate card balances | $1.263T (Q2 2026) | S5 |
| Aggregate card limits | $5.56T (Q2 2026) | S5b (secondary, from NY Fed data) |
| Implied aggregate utilization | 22.7% | derived: 1.263 ÷ 5.56 |

- Card **autopay rule**: `full` for non-carriers, `minimum` or `fixed amount` for carriers.
- APR per card: `normal(22.15, 3.0)`, clipped to 14% to 30%.
- Card limit: scale with income. Start at `0.25 × annual gross income` per household, split across 1 to 3 cards (ASSUMPTION A4), then tune so the population utilization lands near 22.7% (section 7).
- Statement day: uniform 1 to 28. **Due date = statement day + 21 to 25 days** (the CARD Act of 2009 requires statements to go out at least 21 days before the due date).
- Minimum payment: `max($35, 1% of balance + interest charged)` (ASSUMPTION A5, common issuer formula).

### 3.5 Car loans (S6)

| Parameter | New | Used | Source |
|---|---|---|---|
| Average monthly payment (Q2 2026) | $765 | $542 | S6 |
| Average loan amount (Q2 2026) | $43,610 | $27,852 | S6 |
| APR, prime borrowers (661–780) | 6.15% | 8.81% | S6 |
| Average term (Q1 2026) | 69.5 months | 67.7 months | S6 |

- 60% of Q3 to Q5 households have a car loan, 45% of Q2 (ASSUMPTION A6). New vs used: 50/50 for Q4 to Q5, 30/70 below.
- Derive the payment from loan amount, APR and term with the standard amortization formula; it should land near the Experian averages.

### 3.6 Housing (S1, S7)

- Owner vs renter: 65% own (ASSUMPTION A7; matches the long-run US homeownership rate, so source it to Census HVS if time allows).
- Monthly shelter target = `$1,469 × spending scale` (S1). For owners, treat ~85% of it as the mortgage payment, the rest as maintenance (ASSUMPTION A8).
- Mortgage APR: draw the **origination year** uniformly from 2016 to 2025, then use a rate band for that year (ASSUMPTION A9). The current 30-year rate is **7.18%** (Freddie Mac, Nov 5, 2026, S7); use it as the rate for any **new** mortgage in a fork ("buy a house in 2027").
- Rent and mortgage are due on the 1st.

### 3.7 Expense shocks (S2, Table 23)

Share of **adults** with each major unexpected expense in the prior 12 months, converted to a monthly probability per adult: `p_month = 1 − (1 − p_year)^(1/12)`.

| Shock | Annual | Monthly per adult | Median cost bracket | Model amount |
|---|---|---|---|---|
| Major vehicle repair or replacement | 30% | 2.93% | $1,000–$1,999 | lognormal, median $1,500, sigma 0.72 |
| Major house or appliance repair | 22% | 2.05% | $1,000–$1,999 | lognormal, median $1,500, sigma 0.72 |
| Unexpected major medical expense | 21% | 1.95% | $1,000–$1,999 | lognormal, median $1,500, sigma 0.72 |
| Phone or computer repair or replacement | 18% | 1.64% | $500–$999 | lognormal, median $750, sigma 0.54 |
| Legal expenses, taxes, or fines | 10% | 0.87% | $2,000–$4,999 | lognormal, median $3,500, sigma 0.54 |
| **Any of the above** | **59%** | | | validation target |

- Only owners get house repairs. Only households with a car get vehicle shocks.
- Shocks land on a random day and are paid from checking (or a card, if the household carries a balance, 50/50).
- Median brackets are from S2; using the bracket midpoint is ASSUMPTION A10.

### 3.8 Starting cash buffers (S8, S9)

| Fact | Value | Source |
|---|---|---|
| Liquid cash needed to weather a simultaneous income dip and spending spike | ~6.2 weeks of take-home income | S9 |
| Families without that buffer | 65% | S9 |
| Typical buffer held vs needed: low income | ~$700 held vs ~$2,500 needed | S9 |
| Typical buffer held vs needed: middle income | ~$2,000 held vs ~$5,000 needed | S9 |
| Typical buffer held vs needed: top quintile | ~$9,000 held vs ~$15,000 needed | S9 |
| Average end-of-day checking balance, non-overdrafters | > $1,550 | S8 |
| Average end-of-day checking balance, frequent overdrafters | < $350 | S8 |

- Starting liquid cash (checking + savings) = `weeksOfTakeHome × weekly take-home`, where `weeksOfTakeHome ~ lognormal(median 2.5, sigma 0.9)`, clipped to 0.2 to 30 weeks. Tune the median so ~65% of households land below 6.2 weeks (section 7).
- Split liquid cash: 35% checking, 65% savings for households with savings; 100% checking for the 37% who fail the $400 test (next table).
- S9 dollar figures are 2013 to 2018 data. Use them for shape, not exact dollars, and say so.

### 3.9 Stress targets used only for validation (S2, S8, S10)

| Target | Value | Source |
|---|---|---|
| Would cover a $400 emergency with cash or equivalent | 63% of adults | S2 |
| Did not pay all bills in full last month: overall / < $25k / $25–50k / $50–100k / $100k+ | 16% / 34% / 26% / 13% / 7% | S2 Table 19 |
| Paid an overdraft fee in the past year (banked adults): overall / < $25k / $25–50k / $50–100k / $100k+ | 12% / 17% / 20% / 12% / 6% | S2 Table 31 |
| Frequent overdrafters (more than 10 a year) | ~9% of accounts | S8 (2011–2012 data) |
| Personal saving rate, Sept 2026 | 3.8% of disposable income | S10 (macro, sanity check only) |

---

## 4. `population.ts`: draw one household profile

```ts
export function drawProfile(rng: Rng, opts: { excludeQ1: boolean }): HouseholdProfile
```

Order of draws (fixed, so seeds stay stable when you add fields at the end):

1. Quintile → gross income → earners (Q2: 1 to 2, Q3 to Q5: 2 with 70% probability; ASSUMPTION A11)
2. Pay cadence per earner (3.3) → take-home (A1)
3. Owner or renter (3.6) → shelter payment, mortgage APR and remaining term
4. Car loan yes/no → new/used → amount, APR, term → payment (3.5)
5. Card ownership by income band → number of cards → limits → APR → carrier yes/no → starting balance (3.4)
6. Spending scale and per-category `p_day`, `mu`, `sigma` (3.2)
7. Starting liquid cash and checking/savings split (3.8)
8. Optional: student member with own checking (the Maya case), education spending on
9. Household buffer setting (default $500; ASSUMPTION A12, user-editable in app)

Return a plain object. No side effects.

**Check:** `drawProfile` with the same seed returns byte-identical JSON twice.

---

## 5. `generator.ts`: profile → ledger

```ts
export function generateHistory(profile, rng, startDay, days = 365): Txn[]
export function scheduleObligations(profile, fromDay, days = 60): Obligation[]
```

Each simulated day, in this order:

1. Paychecks (by cadence; shift to the prior business day if on a weekend)
2. Fixed bills due today (rent/mortgage on the 1st, utilities, insurance, subscriptions, car payment)
3. Card statements close; card payments post on due dates by autopay rule
4. Random category spending (3.2), split between debit and card (carriers put 60% on card, others 40%; ASSUMPTION A13)
5. Shocks (3.7)
6. Interest accrues daily on carried card balances: `balance × APR / 365`
7. Record end-of-day balance per account

Write every event as a `txn` row (integer cents, day number, category, account). Opening balance + sum of txns must equal closing balance (the spec's `validate_household` check).

**Check:** for the Patels' seed, the reducer `validate_household` passes, and the vitals compute without NaN.

---

## 6. Demo households stay inside the calibrated ranges

The Patels, Jordan and Alex, and the Chens are hand-tuned so the story lands on cue. That is fine as long as:

- Each hand-set value is inside the population's p5 to p95 for that parameter, and
- Each override is listed in `calibration.ts` under `demoOverrides` with a one-line reason.

| Household | Quintile | Key overrides (example) |
|---|---|---|
| Patels | Q4 | Card due date moved to land in the mortgage week; liquid cash at ~2 weeks of take-home |
| Jordan and Alex | Q3 | One card carrier at ~48% utilization |
| Chens | Q5 | House goal set so the base forecast is on time by one month |

**Check:** a script prints each override next to the population p5/p50/p95 and fails if any is outside.

---

## 7. Validate the population (this is the proof)

Reducer `validate_population` runs over the 500 backtest households and writes a `calibration_result` table: `metric, target, actual, tolerance, pass`.

| Metric | Target | Tolerance | Source |
|---|---|---|---|
| Mean annual spending per household (Q2 to Q5 mix) | CE quintile means | ±10% | S1 |
| Category shares of spending | CE shares | ±3 pts | S1 |
| Households with at least one shock in 12 months (per adult basis) | 59% | ±6 pts | S2 |
| Card holders carrying a balance | 45% | ±6 pts | S2 |
| Population card utilization | 22.7% | ±5 pts | S5/S5b |
| Households with checking < $0 at least once in 365 days | 12% | ±5 pts | S2 (proxy for overdraft fee) |
| Households with more than 10 negative days in 365 | ~9% | ±4 pts | S8 |
| Households below 6.2 weeks of liquid cash | 65% | ±8 pts | S9 |
| Households hitting a projected crunch (below buffer) in the 60-day window | 15% to 25% | in range | spec |

**How to tune:** if a metric fails, change only the parameter marked ASSUMPTION that drives it (for example, starting-cash median for the overdraft rate). Never change a sourced value to make a test pass. Log each tuning change in `docs/DATA_SOURCES.md`.

**Check:** all rows pass, or the failing ones are listed honestly on the Admin screen with the actual number.

---

## 8. Show it in the app and the pitch

### Admin screen: "Where the data comes from" panel
- Generator seed and population size
- The section 7 table with pass/fail marks
- A sources list (S1 to S10) with publisher and release date
- A line: "Synthetic households. Patterns calibrated to BLS, Federal Reserve, CFPB, NY Fed and Experian data. In production, PNC account data fills the same tables."

### README section (paste as is)
> **Data.** Kitchen Table uses no real customer data. A seeded generator creates households whose spending, paychecks, card use, loans and shocks follow published US data: BLS Consumer Expenditures 2025, the Fed's 2025 SHED report, Fed G.19, the NY Fed Household Debt and Credit report, Experian auto finance data, the CFPB, and the JPMorgan Chase Institute. `validate_population` checks the 500-household population against those targets; results are on the Admin screen. In production, PNC's account feed replaces the generator and nothing else changes.

### Pitch lines
- "The Patels aren't real, but their paycheck schedule, card APR, car payment and the chance their car breaks down this year all are."
- "We checked 500 synthetic households against Fed data: 12% of banked adults paid an overdraft fee last year in the Fed's survey, and [ACTUAL]% of our households went negative."

### Judge Q&A
- **"Did you tune the data to make your demo look good?"** "The demo family is hand-set but inside the population's normal range. The 500-household backtest isn't hand-set, and it's checked against Fed targets on the Admin screen."
- **"Why not use real data?"** "We don't have access to real account data, and we shouldn't. The schema is built for PNC's feed."

---

## 9. Assumptions (not from a source; say so if asked)

| ID | Assumption | Why |
|---|---|---|
| A1 | Effective tax rate by quintile: 15 / 20 / 24 / 30% | Converts gross to take-home; CE reports pre-tax income |
| A2 | Weekend dining uplift ×1.4, mean preserved | Realistic weekly rhythm |
| A3 | Utilities seasonal multiplier: Jun to Sep ×1.25, Dec to Feb ×1.10, other 5 months ×0.74 (averages to 1.0) | Texas-style summer peak; source from EIA if time allows |
| A4 | Card limits ≈ 25% of gross income per household, 1 to 3 cards | Tuned to hit 22.7% utilization |
| A5 | Minimum payment = max($35, 1% + interest) | Common issuer formula |
| A6 | Car loan ownership by quintile | No single clean public source pulled |
| A7 | 65% homeowners | Long-run US rate; cite Census HVS if added |
| A8 | Mortgage = 85% of CE shelter for owners | CE shelter includes maintenance and other lodging |
| A9 | Mortgage rate band by origination year | Existing loans carry older rates |
| A10 | Shock amount = bracket midpoint as median | S2 gives brackets, not exact medians |
| A11 | Earner count by quintile | Simplification |
| A12 | Default buffer $500 | Product setting, user-editable |
| A13 | Debit vs card split | Simplification |

---

## 10. Caveats to state honestly

- **CE 2025** was collected with a gap: Census could not collect data in October and November 2025 because of the federal funding lapse; BLS adjusted the weights.
- **SHED** figures are per adult, not per household. We apply shocks per adult.
- **CFPB overdraft** data is from 2011 to 2012, before many banks (including PNC) changed overdraft programs. Use it for shape only.
- **JPMorgan Chase Institute** buffers are from 2013 to 2018 dollars.
- **Card limits** come from a secondary analysis of NY Fed data (S5b). Replace with the NY Fed report's own figure if someone pulls the data file.
- **Pay cadence** shares are per establishment, not per worker.

---

## 11. Source URLs

- S1 BLS Consumer Expenditures 2025: https://www.bls.gov/news.release/archives/cesan_10292026.htm (tables: https://www.bls.gov/cex/tables.htm)
- S2 Fed SHED 2025:
  - Fact sheet: https://www.federalreserve.gov/newsevents/pressreleases/files/other20260513a1.pdf
  - Economic hardships (shocks, bills): https://www.federalreserve.gov/publications/2026-economic-well-being-of-us-households-in-2025-economic-hardships.htm
  - Credit (cards): https://www.federalreserve.gov/publications/2026-economic-well-being-of-us-households-in-2025-credit.htm
  - Banking (overdraft): https://www.federalreserve.gov/publications/2026-economic-well-being-of-us-households-in-2025-banking.htm
- S3 BLS pay periods: https://www.bls.gov/ces/publications/length-pay-period.htm
- S4 Fed G.19: https://www.federalreserve.gov/releases/g19/current/ (FRED series TERMCBCCINTNS)
- S5 NY Fed Household Debt and Credit, Q2 2026: https://www.newyorkfed.org/newsevents/news/research/2026/20260811 (check whether the Q3 2026 release is out and has a newer limit figure)
- S5b Wolf Street on card limits: https://wolfstreet.com/2026/08/25/credit-card-delinquencies-payment-volume-balances-debt-to-income-and-credit-limits-in-q2-2026-americans-and-their-plastic/
- S6 Experian auto finance (via Bankrate, Q2 2026): https://www.bankrate.com/loans/auto-loans/average-monthly-car-payment/ and Experian Q1 2026: https://www.experian.com/blogs/ask-experian/average-car-payment
- S7 Freddie Mac PMMS (FRED MORTGAGE30US): https://fred.stlouisfed.org/series/MORTGAGE30US
- S8 CFPB Frequent Overdrafters: https://files.consumerfinance.gov/f/documents/201708_cfpb_data-point_frequent-overdrafters.pdf
- S9 JPMorgan Chase Institute, Weathering Volatility 2.0: https://www.jpmorganchase.com/institute/all-topics/household-financial-health/report-weathering-volatility-2-a-monthly-stress-test-to-guide-saving
- S10 BEA personal saving rate: https://www.bea.gov/data/income-saving/personal-saving-rate

---

## 12. Suggested prompts for the agent

Paste these one at a time. Each maps to a step above.

1. "Read `docs/GENERATOR_CALIBRATION.md` fully. Create the files in section 1 as typed stubs. Don't implement logic yet."
2. "Implement `calibration.ts` exactly from section 3 and section 9. Every value needs `value`, `source`, and `note` where given. Don't add values that aren't in the doc."
3. "Implement `population.ts` per section 4. Add a test that the same seed gives identical output."
4. "Implement `generator.ts` per section 5. Add the opening-plus-transactions-equals-closing check."
5. "Implement `validate.ts` and the `validate_population` reducer per section 7. Print the results table."
6. "Run validation on 500 households. For any failing metric, propose a change to an ASSUMPTION parameter only, and explain it."
7. "Build the Admin 'Where the data comes from' panel per section 8."
