# Development plan: from now until the store accounts are funded

Date: 2026-11-12. Baseline: `main` = `de7fcb84`.
- Legacy staging (`maybesitter-api-staging`) serves `de7fcb84` at 100% (revision `00676-qew`).
- Production is still on `sha-ee82d01` until the owner dispatches `deploy.yml`.

Companion: `docs/plans/2026-11-12-qa-audit-plan.md`; agent staffing: `docs/plans/2026-11-12-agent-team.md`.

## Owner direction this plan follows

- Apple Developer ($99/yr) and Google Play ($25) wait for funding the owner is expecting. The launch date is set once the money arrives.
- Until then, keep building. Every item here must be doable **without** a store account.
- Core plus per-feature add-ons is the business model:
  - free tier at most 50¢ a user a month (internal 40¢);
  - base subscription ₪10;
  - Gmail add-on $4–5.
- "Never harm quality". Any model-cost cut ships only after a before/after run on a golden set with zero recall loss.
- No spend without stating the exact cost and getting the owner's yes. No production deploy without the owner.
- Market Evidence Gate #61 still governs Stage B releases. Turning a staging-only module on in production is an owner exception, recorded the way the proactive-loop exception was (AGENTS.md §6).

## What "done" means for the period

When the money arrives, it should take **days, not weeks** to get to the closed test:
1. a production build that already runs the latest `main`;
2. every feature planned for launch has passed the QA audit on a real device against staging;
3. the purchase flow is code-complete and only needs real products;
4. listing assets are ready.

---

## Track D1 — Release plumbing that needs no store account

| ID | Work | Done when | Depends on |
|---|---|---|---|
| D1.1 | **Keep staging and production equal to `main`.** After every merge batch: Cloud Build → staging tag → smoke → staging traffic → owner dispatches `deploy.yml`. Recipe in `docs/operations/DEPLOY.md` plus the manual staging steps. | `/api/health` on both services reports the same commit as `main` | owner dispatch each time |
| D1.2 | **Android beta without Play:** distribute a signed release APK through Firebase App Distribution (free, no Play account) to the owner and early testers. | testers install from an e-mail invite; the build reaches production over https | owner names the testers |
| D1.3 | **Sign in with Apple ready behind its flag** (#145). App Store 4.8 requires it, because Google sign-in is offered. Wire the provider config so that only the account and key remain. | the flag on in a dev build shows the button; the server accepts an Apple-issued token in the emulator test | Apple account to finish |
| D1.4 | **EAS build profiles for store builds** (#150): production profile, version codes, the mobile build-time flags (`EXPO_PUBLIC_FEATURE_*`) written down per profile instead of only in the remote EAS environment. | `eas.json` and `mobile/AGENTS.md` list every build flag per profile; a local release build of each profile succeeds | — |
| D1.5 | **Store listing kit:** AR and EN copy (checked against `docs/marketing/CLAIMS_POLICY.md`), screenshots taken from the real app on the simulator and device (not mock-ups), the privacy-label answers (`docs/release/STORE_PRIVACY_DECLARATIONS.md`) and the release-AAB permission audit. | the validator in `LISTING_VALIDATION.md` passes; screenshots are SHA-tagged in `evidence/` | QA audit for the screens shown |
| D1.6 | **Close stale issues with evidence.** Issues whose code landed but which stayed open: #157, #151, #149, #147, #810, #800, #798, #663, #333, #137. | each one is closed with a link to its evidence, or re-scoped to what is really left | — |

## Track D2 — Payments: purchase flow complete without real products

| ID | Work | Done when | Depends on |
|---|---|---|---|
| D2.1 | **RevenueCat SDK in `mobile/`** (`react-native-purchases`), behind a build flag; it shows offerings for the catalog grants (`base`, `gmail_light`, `gmail_full`, `meeting_prep`, `goal_plans`, `memory_plus`). | a dev build with a RevenueCat test key lists offerings from the RevenueCat dashboard's test store | owner creates the RevenueCat project (free under $2.5k MTR) |
| D2.2 | **Webhook route** that verifies RevenueCat's authorization header and writes only the entitlement projection (`users/{uid}/features/entitlements`) through `lib/integrations/revenuecat/entitlements.ts` (#618). It stores no raw receipts and holds no content. | route tests cover purchase, renewal, expiry, refund, transfer and replay; `providerBoundary` and the enumerating guards are updated | D2.1 |
| D2.3 | **Paywall and «الميزات» purchase buttons**: copy in AR and EN, price from the store, restore purchases, manage subscription. | a design-critique pass; RNTL tests; device run in sandbox when the accounts exist | D2.1 |
| D2.4 | **`user_monthly` as its own Gmail scan status.** M5a now reports a spent month as the daily-limit state (ADR "Not done yet"). | the app says "this month's allowance is used up" with the date it renews | — |
| D2.5 | **Gate rollout:** look at staging `shadow_deny` logs for two weeks of QA traffic, then `enforce` on staging, then propose it for production. | a written review of the shadow log (counts only, no content); enforce on staging with the QA audit's money checks green | QA traffic on staging |

## Track D3 — Gmail as a sellable add-on

| ID | Work | Done when | Depends on |
|---|---|---|---|
| D3.1 | Fix the paid infinite retry (#815) and the deletion fence on observation writers (#778). The QA audit confirms them on device first. | merged with tests that fail on the old code | — |
| D3.2 | **Separate OAuth client per environment** (#825). Today a staging revoke kills a production connection. | staging reads its own client from Secret Manager; a revoke test proves isolation | owner creates the client in the Google console |
| D3.3 | **Triage eval on the owner's own labels with 600-character bodies**, then `EMAIL_TRIAGE_MODE` on in staging. | zero commitments missed on the owner-labelled set; report in the ADR | owner labels the set (about 1 hour); paid run of about 2¢ needs his yes |
| D3.4 | **CASA / verification decision paper** (#516, #152): the exact current price from an authorized lab, the 100-user cap, the break-even number of paying Gmail users, and the submission steps. | the owner decides with real numbers | — |

## Track D4 — Turning built features on (one owner decision each)

These are built and on in staging, but locked out of production in code (`lib/release/*`, `lib/services/captureKinds/runtime.ts`, `lib/planning/freeSlots.ts`).

For each one, the path is the same:
1. QA audit pass on a real device against staging;
2. the owner releases it as a recorded exception;
3. remove the environment lock in code, with its test;
4. flag in `flags.sh`;
5. production deploy.

Proposed order, by value to the core loop and lowest risk first:
1. **Goal plans** (`MAYBESITTER_FEATURE_GOAL_PLAN`). It is set nowhere, not even staging, so every `/api/mobile/goals/**` plan route answers 404 everywhere. Set it in staging first, then QA, then fix #807 and #806. It is an add-on (`goal_plans`).
2. **Smart postpone, evening impact, clash hold** (M4b).
3. **Free slots** (M4a): needs #749 (quota on manual busy sources) first.
4. **Capture kinds** (M3b).
5. **Search history** (M6, add-on) and **memory learning** (M5b, add-on).
6. **Memory translation** (M6b, add-on): needs a paid real-model check, with the owner's yes.
7. **M5a Gmail scan and calendar choice**: last, after D3.

Also decide on `MAYBESITTER_FEATURE_PRIORITY` (unset, so Today uses plain ordering): either set it in staging and test it, or record that it stays off.

## Track D5 — Gaps in the core experience

| ID | Work | Source |
|---|---|---|
| D5.1 | Reopen a completed commitment; show `postponedUntil` after a postpone. Needs a product decision first. | `CommitmentActionName`; `docs/design/astra-r2-polish.md` |
| D5.2 | A Today row says which day it is from now that yesterday rolls in. | #397 |
| D5.3 | `applyIncrementalPlanPatch` has only test callers. Either wire it into the replan tick or delete it. | `lib/services/dailyPlan/incrementalPlanApply.ts`, #524 |
| D5.4 | Backend fields the design needs and the API does not return: duration or end time, items with no time, sentence-span to card mapping. Verify which are still missing. | `mobile/AGENTS.md` |
| D5.5 | Hebrew: fonts with Hebrew glyphs, a language picker, and native review. **Defer** unless a native reviewer is found. | #335, #326, #325 |

## Track D6 — Operations and cost safety

| ID | Work | Depends on |
|---|---|---|
| D6.1 | GCP budget alerts, Vertex quota, the session metric (#328). | owner in the console |
| D6.2 | Production Workload Identity: add `assertion.environment=='production'`, and narrow the deployer roles. | owner (IAM) |
| D6.3 | Decide legacy staging versus the isolated staging project. Legacy staging works today and is how D1.1 promotes. The isolated project costs about $0–3 a month. | owner |
| D6.4 | Revisit `--min-instances` for production at launch; it is a fixed cost. | owner |
| D6.5 | Paid evals before launch: capture and profile (#330), share-injection (#193). Exact cost is stated before each run. | owner's yes |

## Track D7 — Directions written down, not scheduled now

These are evidence-gated or need money. Do not start them in this period:
- packs UI and entitlements (#618–#620);
- travel pack with a flight provider (#621);
- Context Connections (#594, ADR-0004);
- user MCP servers (ADR-0002, #590);
- Android notification signals (#593);
- background-history feed (#623);
- Apple Watch;
- the provider adapters (Graph, Todoist, Notion, WHOOP, RescueTime);
- a real financial provider;
- an on-device model.

Revisit after launch with usage data and #61.

## Order of work

1. **Week 1:**
   - D1.1 (production equals `main`);
   - QA audit Stage 1 (code) for every unit;
   - D1.6 stale-issue closure;
   - nothing is deployed to staging and no staging flag changes while the QA audit runs (it is pinned to `de7fcb84`); the goal-plan flag goes on after the audit's A7 run.
2. **Weeks 2–3:**
   - QA audit Stages 2–3 (simulator and report); fixes only after the owner reads the report;
   - D2.1–D2.4;
   - D1.2 Android beta to first testers;
   - D3.2–D3.3.
3. **Weeks 3–4:**
   - D4 releases one by one, as the QA passes come in;
   - D1.3–D1.5;
   - D2.5;
   - D3.4.
4. **When funding arrives:**
   - store accounts;
   - RevenueCat products;
   - closed test (Play needs 12 testers for 14 days);
   - launch date set then.
