# Expansion orchestration ledger

Updated: 2026-09-17
Current integration base: `9edb93badf0f62004e6fa941b1d26ac5808a763c`

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
| ICS mobile flow, app config, Root, API aggregation, settings, and locales | merged in PR #460 | Former ownership blocker is clear; follow-up native/config work must still rescan exact overlaps before editing shared mobile files. |
| Language gate and guided setup chat | merged in PR #471 | Former setup/onboarding ownership blocker is clear; mobile readiness UX follow-up must not duplicate the landed language-first setup flow. |
| Mobile package manifests and lockfile | Dependabot #229, #363, #365, #367, #368, #370 | #363 and #367 were recreated on current main but still produce an invalid lock missing `typescript@5.9.3`; #229, #365, #368, and #370 have reproducible mobile failures and are not merge candidates. |
| Root package manifests and lockfile | Dependabot #228, #358-#362 | Dependency-free domains proceed; integration classifies dependency PRs before adding a solver package. |
| Deployment workflow | Dependabot #372-#373 | No expansion lane edits `.github/workflows/deploy.yml`. |
| Football fixtures workspace | local `feat/football-fixtures` lane | The occupied main checkout contains unresolved integration changes across shared package, mobile, storage, and contract files. Integration uses a clean detached worktree and does not alter that workspace. |

An active conflict in one subsystem is not a program-wide blocker.

## Lane ledger

| Lane | Status | Branch | Base SHA | Owned files | Upstream dependencies | Active collisions | PR | CI / test status | Merge status | External blockers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Integration | active | `program/post-473-ledger-refresh` | `9edb93b` | this ledger; later shared config/package changes | all landed contracts | Dependabot shared package files, deployment workflow PRs, and the local football workspace | pending | documentation-only validation pending this refresh | active | Apple/Google console/device verification later |
| Foundations | complete | merged stack | through `e624f9a` | connection, readiness, UserState, task, policy, cost, architecture, provider runtime contracts | none | none | #406-#436 | merged CI green | merged | none |
| Gmail provider | complete | merged | `81aa70d` | Gmail adapter; prompt boundary tests | provider runtime | none | #437 | focused 11 pass; CI green | merged | OAuth app credentials for live verification |
| Microsoft Graph provider | complete | merged | `3cba437` | Graph adapter; busy-block tests | provider runtime | none | #438 | focused 31 pass; CI green | merged | Microsoft app credentials for live verification |
| Todoist + Notion providers | complete | merged | `006b2e8` | task provider adapters; integration tests | provider runtime; canonical external task | none | #439 | focused 10 pass; CI green | merged | provider credentials for live verification |
| RescueTime context | complete | merged | `ec1be12` | aggregate context adapter; UserState projection tests | provider runtime; UserState projection | none | #440 | focused 34 pass; typecheck, registration, and CI pass | merged | provider credentials for live verification |
| Meeting intelligence | complete | merged | `f1822f4` | meeting proposal boundary; proposal tests | provider runtime; canonical commitment proposal | none | #441 | focused 61 pass; CI green | merged | meeting-provider credentials for live verification |
| Cross-provider identity | complete | merged | `3525ed0` | provider-independent identity decisions and adversarial integration cases | Gmail, Microsoft Graph, canonical external task | none | #459 | focused integration suite 25 pass; typecheck, registration, and CI pass | merged | none |
| Travel planning | complete | merged | `3208ac8` | travel constraint projection; planner tests | canonical planner | none | #442 | focused 28 pass; typecheck, registration, and CI pass | merged | live travel estimate provider not selected |
| HealthKit native bridge | complete | merged | `5b0e049` | local Expo module, iOS bridge, narrow adapters/tests | canonical readiness | none | #456 | root 18 pass; mobile 167 suites / 2281 tests pass; typechecks, prebuild, pods, module and simulator app builds pass | merged | physical iOS permission/read verification |
| Health Connect native bridge | complete | merged | `98ed28c` | local Expo module, Android bridge/manifest, narrow adapters/tests | canonical readiness | mobile package edits remain owned by Dependabot | #457 | focused mobile 3 pass; mobile typecheck and CI pass; prior prebuild and Kotlin target compile pass | merged | Android device permission verification; Play declaration |
| UserState production runtime | complete | merged | `00734c7` | projection service, canonical daily-plan integration, authenticated readiness API, focused tests | readiness contracts; canonical planner | none | #461 | 41 focused auth/mobile/planner tests pass; typecheck, registration, and CI pass | merged | none |
| Action Gateway runtime | complete | merged | `d5e96a6` | canonical action execution and audit runtime | Action Policy | none | #450 | focused 42 pass; typecheck, registration, and CI pass | merged | provider executors require credentials |
| MCP capability gateway | complete | merged | `eb2db9a` | MCP capability adapter; policy/red-team tests | #450 merged | none | #451 | focused 60 pass; typecheck, registration, and CI pass | merged | operator mappings and live MCP credentials |
| Controlled email actions | complete | merged | `59aa6bc` | review-bound draft/send flow; safety tests | #450 merged; Gmail/Graph executors | none | #454 | focused 71 pass; typecheck, registration, and CI pass | merged | live provider credentials |
| LLM observability runtime | complete | merged | `6b9c069` | canonical LLM log attribution and focused tests | cost attribution; existing usage guard | none | #462 | focused 23 pass; typecheck, registration, and CI pass | merged | none |
| Timefold shadow experiment | complete | merged | `c6387ff` | dependency-free planner experiment and metrics | canonical planner | solver dependency addition requires Dependabot reconciliation | #453 | focused 16 pass; typecheck, registration, and CI pass | merged | none for dependency-free boundary |
| RevenueCat entitlement domain | complete | merged | `46cac97` | entitlement projection and tests | entitlement foundation | SDK wiring still collides with Dependabot mobile package owners; no SDK wiring in this lane | #452 | focused 18 pass; typecheck, registration, and CI pass | merged | store products, RevenueCat credentials, device restore verification |
| Provider OAuth lifecycle | complete | merged | `b911807` | provider OAuth state, PKCE, vault handoff, disconnect boundary, focused tests | connection registry; provider runtime | none | #464 | focused 23 pass; typecheck, registration, and CI pass | merged | live OAuth app credentials |
| Privacy and store declaration delta | complete | merged | `826eafd` | expansion privacy/store documentation only | merged provider and health behavior | none | #463 | `check:test-registration`, `git diff --check`, and CI pass | merged | console submission, credentials, and device evidence remain owner actions |
| Native readiness app declarations | complete | merged | `c3e2bbd` | HealthKit app entitlement, health privacy manifest entry, localized native prompt, config tests | HealthKit bridge; privacy/store delta | none | #470 | mobile app config 42 pass; mobile typecheck and CI pass | merged | physical iOS permission/read verification |
| Language-first setup chat | complete | merged | `cff61ba` | setup/chat routing, onboarding copy, Graphify corpus refresh | existing mobile setup surfaces | none | #471 | GitHub CI green before merge | merged | none |
| Post-setup ledger refresh | complete | merged | `7802ba1` | orchestration ledger and privacy/store delta docs | #471 | none | #472 | `check:test-registration`, `git diff --check`, and CI pass | merged | none |
| Mobile readiness settings | complete | merged | `9edb93b` | provider-independent readiness API client, Settings screen, localized copy, and focused mobile tests | authenticated readiness API; #471 setup flow | none | #473 | mobile typecheck, focused 135-test suite, `check:test-registration`, `git diff --check`, and CI pass | merged | physical device/native readiness verification remains separate |

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
- #450 landed the canonical action gateway runtime on `d5e96a6`; MCP and
  controlled-email lanes were retargeted from the stack to `main`.
- #465 landed the Android native build fix on `d8210fc` and removed the former
  #458 blocker. #460 remains open and dirty against current main, so ICS/mobile
  ownership is still active.
- #466 landed the mobile Android manifest-merge regression guard on `5806584`;
  safe open lanes were rebased again because it touched mobile package/script
  surfaces.
- #460 landed the university-calendar mobile flow on `f6cc121`; shared
  mobile/config ownership from that lane is no longer active.
- #451, #454, and #462 landed on `eb2db9a`, `59aa6bc`, and `6b9c069`.
  Remaining open program lanes were rebased and exact-overlap rescanned on the
  new main.
- #452, #453, #464, #463, and #470 landed on `46cac97`, `c6387ff`,
  `b911807`, `826eafd`, and `c3e2bbd`. HealthKit app declarations are no
  longer blocked by the former #460 ownership boundary.
- #471 landed on `cff61ba`; the language-first setup/chat flow is now on main.
  Mobile readiness UX work can continue only after an exact overlap scan against
  the landed setup surfaces.
- #472 and #473 landed on `7802ba1` and `9edb93b`. The post-setup ledger is
  refreshed, and Settings now has a provider-independent readiness surface for
  subjective energy check-ins without native package or permission wiring.

## Current blocked integration work

| Work | Blocking condition | Automatic resume condition |
| --- | --- | --- |
| Health Connect shared Android/app declarations | mobile package PRs still own package/lockfile surfaces | Reconcile declarations without package edits where possible; package wiring waits for current mobile owners. |
| RevenueCat SDK/native wiring | mobile Dependabot owns package/lockfile surfaces; store products need owner | Reconcile packages, then prebuild and device-test. |
| Timefold solver dependency | root Dependabot PRs own package surfaces | Classify and reconcile dependency PRs after the benchmark boundary merges. |
| Live OAuth/provider verification | external app credentials | Run contract-approved smoke tests when credentials are supplied. |

## Merge discipline

Before every merge: fetch `origin/main`, refresh Graphify incrementally when
main changed, rebase, rerun relevant tests, and verify that no merged PR
supersedes the lane. After every material main update, rescan collisions and
rebase affected open lanes. Keep `graphify-out/` uncommitted.
