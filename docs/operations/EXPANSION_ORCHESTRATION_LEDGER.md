# Expansion orchestration ledger

Updated: 2026-09-16
Current integration base: `3208ac8caf79658507bf5dd00605a3ea9fae6094`

This is the live ownership and dependency ledger for the expansion program.
Git and current GitHub state remain authoritative; Graphify is refreshed
incrementally after material changes and is used as the navigation index.

## Shared-file ownership

The integration lane exclusively owns edits to shared hotspots:

| Surface | Integration owner action |
| --- | --- |
| Root and mobile package manifests and lockfiles | Reconcile feature dependencies only after active package owners clear. |
| Shared env/config and central feature flags | Add provider flags and native declarations after their narrow contracts land. |
| Firestore indexes, rules, and storage path registry | Add schemas only with deletion, export, and least-privilege review. |
| Contract barrels and broad re-export files | Export stable contracts after duplicate-architecture checks. |
| Shared locale files | Batch user-facing copy after active mobile owners clear. |
| Privacy, store, and legal declarations | Derive declarations from implemented behavior and verified permissions. |

Feature lanes own narrow additive modules and focused tests. They do not edit
these shared surfaces unless the integration lane explicitly hands off a file.

## Active collisions

| Collision | Current owner | Program effect |
| --- | --- | --- |
| ICS mobile flow, app config, Root, API aggregation, settings, and locales | PR #460 | Native health config, readiness UX, App Intents registration, and RevenueCat SDK wiring stay out of these shared files until the owner rebases and merges. |
| Mobile package manifests and lockfile | Dependabot #229, #363, #365, #367, #368, #370 | #363 and #367 were recreated on current main but still produce an invalid lock missing `typescript@5.9.3`; #229, #365, #368, and #370 have reproducible mobile failures and are not merge candidates. |
| Root package manifests and lockfile | Dependabot #228, #358-#362 | Dependency-free domains proceed; integration classifies dependency PRs before adding a solver package. |
| Deployment workflow | Dependabot #372-#373 | No expansion lane edits `.github/workflows/deploy.yml`. |
| Football fixtures workspace | local `feat/football-fixtures` lane | The occupied main checkout contains unresolved integration changes across shared package, mobile, storage, and contract files. Integration uses a clean detached worktree and does not alter that workspace. |

An active conflict in one subsystem is not a program-wide blocker.

## Lane ledger

| Lane | Status | Branch | Base SHA | Owned files | Upstream dependencies | Active collisions | PR | CI / test status | Merge status | External blockers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Integration | active | `program/integration-ledger-live` | `3208ac8` | this ledger; later shared config/package/privacy changes | all landed contracts | #460, Dependabot shared files, and the local football workspace | #455 | documentation-only validation pending this refresh | open | Apple/Google store declarations later |
| Foundations | complete | merged stack | through `e624f9a` | connection, readiness, UserState, task, policy, cost, architecture, provider runtime contracts | none | none | #406-#436 | merged CI green | merged | none |
| Gmail provider | complete | merged | `81aa70d` | Gmail adapter; prompt boundary tests | provider runtime | none | #437 | focused 11 pass; CI green | merged | OAuth app credentials for live verification |
| Microsoft Graph provider | complete | merged | `3cba437` | Graph adapter; busy-block tests | provider runtime | none | #438 | focused 31 pass; CI green | merged | Microsoft app credentials for live verification |
| Todoist + Notion providers | complete | merged | `006b2e8` | task provider adapters; integration tests | provider runtime; canonical external task | none | #439 | focused 10 pass; CI green | merged | provider credentials for live verification |
| RescueTime context | complete | merged | `ec1be12` | aggregate context adapter; UserState projection tests | provider runtime; UserState projection | none | #440 | focused 34 pass; typecheck, registration, and CI pass | merged | provider credentials for live verification |
| Meeting intelligence | complete | merged | `f1822f4` | meeting proposal boundary; proposal tests | provider runtime; canonical commitment proposal | none | #441 | focused 61 pass; CI green | merged | meeting-provider credentials for live verification |
| Cross-provider identity | complete | merged | `3525ed0` | provider-independent identity decisions and adversarial integration cases | Gmail, Microsoft Graph, canonical external task | none | #459 | focused integration suite 25 pass; typecheck, registration, and CI pass | merged | none |
| Travel planning | complete | merged | `3208ac8` | travel constraint projection; planner tests | canonical planner | none | #442 | focused 28 pass; typecheck, registration, and CI pass | merged | live travel estimate provider not selected |
| HealthKit native bridge | complete | merged | `5b0e049` | local Expo module, iOS bridge, narrow adapters/tests | canonical readiness | app declaration remains owned by #460 | #456 | root 18 pass; mobile 167 suites / 2281 tests pass; typechecks, prebuild, pods, module and simulator app builds pass | merged | physical iOS permission/read verification; Apple declarations |
| Health Connect native bridge | complete | merged | `98ed28c` | local Expo module, Android bridge/manifest, narrow adapters/tests | canonical readiness | app declaration and package remain owned by #460/Dependabot | #457 | focused mobile 3 pass; mobile typecheck and CI pass; prior prebuild and Kotlin target compile pass | merged | Android device permission verification; Play declaration |
| UserState production runtime | complete | merged | `00734c7` | projection service, canonical daily-plan integration, authenticated readiness API, focused tests | readiness contracts; canonical planner | none | #461 | 41 focused auth/mobile/planner tests pass; typecheck, registration, and CI pass | merged | none |
| LLM observability runtime | CI running | `program/llm-observability-runtime` | `3208ac8` | canonical LLM log attribution and focused tests | cost attribution; existing usage guard | none | #462 | 9 focused tests pass; typecheck and registration pass after rebase | open | none |
| Action Gateway runtime | CI running | `program/action-gateway-runtime` | `3208ac8` | canonical action execution and audit runtime | Action Policy | none | #450 | focused 42 pass; typecheck and registration pass after rebase | open | provider executors require credentials |
| MCP capability gateway | stacked CI running | `program/mcp-capability-domain` | `7287582` | MCP capability adapter; policy/red-team tests | #450 | none | #451 | focused 59 pass; typecheck and registration pass after rebase | open, stacked | operator mappings and live MCP credentials |
| RevenueCat entitlement domain | CI running | `program/revenuecat-entitlement-domain` | `3208ac8` | entitlement projection and tests | entitlement foundation | SDK wiring collides with #460/Dependabot mobile packages | #452 | focused 18 pass; typecheck and registration pass after rebase | open | store products, RevenueCat credentials, device restore verification |
| Timefold shadow experiment | CI running | `program/timefold-shadow-experiment` | `3208ac8` | dependency-free planner experiment and metrics | canonical planner | solver dependency addition requires Dependabot reconciliation | #453 | focused 16 pass; typecheck and registration pass after rebase | open | none for dependency-free boundary |
| Controlled email actions | stacked CI running | `program/controlled-email-actions` | `7287582` | review-bound draft/send flow; safety tests | #450; Gmail/Graph executors | none | #454 | focused 53 pass; typecheck and registration pass after rebase | open, stacked | live provider credentials |
| Privacy and store declaration delta | CI running | `program/privacy-store-delta` | `3208ac8` | expansion privacy/store documentation only | merged provider and health behavior | none | #463 | `git diff --check`; evidence paths and exact overlap verified | open | console submission, credentials, and device evidence remain owner actions |

## Automatically unblocked

- #448 cleared the reminder action ownership that previously blocked native
  health module work. HealthKit and Health Connect native bridges are now
  merged as isolated local Expo modules in #456 and #457.
- #436 landed the canonical provider runtime. Provider PRs #437-#441 now target
  `main` directly and no longer duplicate the runtime contract in their diffs.
- #445 landed ICS ingestion and released the root package, calendar, and storage
  ownership boundary. All active program branches were rebased and retested on
  `d828b65`.
- Action, travel, Timefold, entitlement, MCP, and controlled-email lanes have
  advanced without waiting for unrelated package collisions.
- #440 landed the aggregate RescueTime context adapter on `ec1be12`; meeting
  intelligence followed in #441, the home widget in #449, HealthKit in #456,
  Health Connect in #457, and cross-provider identity in #459.
- #449 removed the former widget ownership collision. #460 is now the only
  active owner of app config, Root, ICS API aggregation, Calendar settings, and
  shared locale files; its owner has been asked to rebase onto current main.
- #461 landed production UserState composition and canonical readiness-to-plan
  projection on `00734c7`; explicit fresh user energy outranks wearable state.
- #442 landed travel preparation and departure constraints on `3208ac8`
  without introducing a second planner or assuming stale location context.

## Current blocked integration work

| Work | Blocking condition | Automatic resume condition |
| --- | --- | --- |
| HealthKit app entitlement and usage description | #460 owns `mobile/app.config.ts` | Refresh main/Graphify and add through integration lane after #460 merges. |
| Health Connect shared Android/app declarations | #460 and mobile package PRs own shared mobile setup | Reconcile after current mobile owners merge. |
| Mobile readiness UX and locale copy | #460 owns Root/settings/locales/API aggregation | Start from refreshed main after #460 merges. |
| RevenueCat SDK/native wiring | #460 and mobile Dependabot own config/manifests/lockfile; store products need owner | Reconcile packages, then prebuild and device-test. |
| Timefold solver dependency | root Dependabot PRs own package surfaces | Classify and reconcile dependency PRs after the benchmark boundary merges. |
| Live OAuth/provider verification | external app credentials | Run contract-approved smoke tests when credentials are supplied. |

## Merge discipline

Before every merge: fetch `origin/main`, refresh Graphify incrementally when
main changed, rebase, rerun relevant tests, and verify that no merged PR
supersedes the lane. After every material main update, rescan collisions and
rebase affected open lanes. Keep `graphify-out/` uncommitted.
