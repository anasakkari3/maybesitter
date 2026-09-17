# Expansion orchestration ledger

Updated: 2026-09-17
Current integration base: `a38e00d0` (`origin/main` after #476)

This is the live ownership and dependency ledger for the expansion program.
Git and current GitHub state remain authoritative; Graphify is refreshed
incrementally after material changes and is used as the navigation index.

## Priority stabilization: real-user UAT findings

A real-user UAT ran on 2026-09-17. It used the iOS Simulator with real Firebase
Auth and a real local backend, on frozen `6b9c069`, before #469/#471. Capture →
review → commit → act → history worked, account isolation passed, and Arabic and
Hebrew RTL passed. It also found three defects in the core loop. Each was
re-verified in source on `9edb93b`, after #471 and #473.

**Integration priority:** core-loop correctness outranks new provider or
expansion work. While any lane below is open, the integration lane merges it
before any new provider lane. A provider PR that collides with these files
waits.

| Issue | Severity | Defect on current main | Fix contract |
| --- | --- | --- | --- |
| #474 | P1 | "Leave it without a time" leaves `needsClarification` set, so the item can never be confirmed and the capture is lost. | The server's clarify `none` ("no specific time") answer settles the item as a confirmable `unscheduled` draft, reusing `applyEdits`' null-time path. "Leave it without a time" sends that answer. The contract rule that a confirm-time edit with half an answer stays unconfirmable is unchanged. |
| #475 | P1 | After iOS permission is denied, "Ring for Must items" still shows as on and nothing warns the user. | The saved preference is kept. The OS permission is read on mount and on every return to the foreground. A warning at the Must control offers Open phone settings. `provisional` is handled too. |
| #477 | P1 | A daily plan exists only after the server morning job. The plan screen offers no build action and tells users to turn on delivery that is already on. | On-demand build through the canonical `composeDailyPlan` + `createIfAbsent` path shared with the morning tick. It is idempotent, counts as generation 1, sends no push, and adds no second planner. |

**Shared-surface handoff:** the integration lane hands the #475 and #477 lanes
their own locale blocks in `mobile/src/i18n/locales/{en,ar,he}.json`: `notif*`
keys to #475 and `plan*` keys to #477. Neither lane edits any other shared
surface. On rebase, a locale conflict is resolved by keeping both sides' keys.

**Merge gates (all three required, in order):**
1. **Lane:** a failing test first, shown red on unmodified code. Then the fix,
   plus a mutation check proving the test fails for its own defect. Focused
   tests, both typechecks, `expo lint --no-cache` and `check:test-registration`
   must pass.
2. **Integration:** fetch and rebase onto the latest `origin/main`, then rescan
   for exact overlaps with merged work. The full mobile Jest suite must pass,
   plus the full root `npm test` for backend changes. A red is never waived.
3. **PR:** GitHub CI green on the rebased head. The integration lane reviews the
   diff against the fix contract before merging.

## Release-candidate cross-feature UAT

These items go to the final release-candidate UAT on a device or simulator
build of the RC SHA. Each must be walked by hand; green CI does not count.

| Item | What the RC UAT must show |
| --- | --- |
| #474 | Capture "Study probability for two hours this week" → Leave it without a time → Confirm → the item is on Today with no time. In a two-item proposal, skip one and answer the other. |
| #475 | Enable Ring for Must items → Don't Allow → a warning appears at the control → Open phone settings → allow → return → the warning is gone. Relaunch while denied → the warning is still shown. |
| #477 | Fresh account with delivery off, then with delivery on → Build today's plan → a plan renders → reopen → same plan → Regenerate works. Double-tap builds one plan. |
| #200 | Press Done, Later and Not doing it on a real notification (UAT automation could not drive Notification Center). |
| #203 | Add the widget through the OS widget gallery (UAT automation could not open the gallery). |
| Consent burst | Onboarding's concurrent consent writes persist on the Firestore emulator. UAT lost writes on the in-memory adapter only; unconfirmed, and needs JDK 21. |
| #480 | A clarification item completed by edit (title + time) → confirm → Undo removes it. Found while fixing #474; P2, not yet owned. |
| Setup (#471) | With AI consent declined, the guided setup still leads somewhere usable. The pre-#469 "Add goals yourself" screen had no input. |

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
| Mobile locale files (`notif*`, `plan*` blocks) | #475 and #477 stabilization lanes by handoff | Other lanes adding copy wait for these to merge or keep to a disjoint key block. |

An active conflict in one subsystem is not a program-wide blocker.

## Lane ledger

| Lane | Status | Branch | Base SHA | Owned files | Upstream dependencies | Active collisions | PR | CI / test status | Merge status | External blockers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Integration | active | `program/uat-stabilization-ledger` | `a38e00d` | this ledger; later shared config/package changes | all landed contracts | Dependabot shared package files, deployment workflow PRs, and the local football workspace | pending | documentation-only validation pending this refresh | active | Apple/Google console/device verification later |
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
| Post-473 ledger refresh | complete | merged | `a38e00d` | orchestration ledger | #473 | none | #476 | CI green | merged | none |
| Stabilization: clarify skip (#474) | active, priority | `fix/474-clarify-skip-confirmable` | `9edb93b` | `lib/services/captureBoundary/clarifyService.ts` (+ minimal `mobileCaptureService` persistence fix if proven needed), `mobile/src/features/capture/`, `mobile/src/screens/ReviewScreen.tsx`, focused and contract tests | none | none | #479 | red-before/green-after with 3 mutation checks; mobile 184 suites / 2477 tests; root 5278 pass; CI green on `44b3d06` | gates 1-3 passed; awaiting owner merge (auto-mode blocks agent merges) | RC UAT walk |
| Stabilization: Must ring permission (#475) | active, priority | `fix/475-must-ring-permission-state` | `9edb93b` | `NotificationsSettingsScreen.tsx`, focused tests, `notif*` locale block (handoff) | none | locale files shared with #477 (disjoint blocks) | #483 | red-before/green-after with 4 mutation checks; mobile 184 suites / 2477 tests; CI green on `44b3d06` | gates 1-3 passed; awaiting owner merge | RC UAT walk; physical-device permission check |
| Stabilization: plan build on demand (#477) | active, priority | `fix/477-plan-build-on-demand` | `9edb93b` | `lib/services/dailyPlan/`, `src/app/api/mobile/plans/`, `PlanScreen.tsx`, plan API client, focused tests, `plan*` locale block (handoff) | canonical planner | locale files shared with #475 (disjoint blocks) | #482 | root 5294 pass; mobile 2482 pass; mutation checks on idempotency, push and date window; CI green on `44b3d06` | gates 1-3 passed after a gate-3 return (creating build now limited to the account's today/tomorrow; stored plans still returned for any date); awaiting owner merge | RC UAT walk |

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
