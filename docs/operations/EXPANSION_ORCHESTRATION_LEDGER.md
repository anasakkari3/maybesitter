# Expansion orchestration ledger

Updated: 2026-09-16
Current integration base: `d828b65769fca884ae66bb05dc5b01b40507359d`

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
| Home widgets, mobile app config/packages/locales/settings | PR #449 | Native health config, readiness UX, App Intents registration, and RevenueCat SDK wiring stay out of shared mobile files. Narrow local modules may proceed. |
| Mobile package manifests and lockfile | Dependabot #229, #363, #365, #367, #368, #370 plus #449 | Integration lane must reconcile versions; feature lanes do not edit these files. |
| Root package manifests and lockfile | Dependabot #228, #358-#362 | Dependency-free domains proceed; integration classifies dependency PRs before adding a solver package. |
| Deployment workflow | Dependabot #372-#373 | No expansion lane edits `.github/workflows/deploy.yml`. |

An active conflict in one subsystem is not a program-wide blocker.

## Lane ledger

| Lane | Status | Branch | Base SHA | Owned files | Upstream dependencies | Active collisions | PR | CI / test status | Merge status | External blockers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Integration | active | `program/integration-ledger-live` | `006b2e8` | this ledger; later shared config/package/privacy changes | all landed contracts | #449 and Dependabot shared files | #455 | documentation-only validation passed | open | Apple/Google store declarations later |
| Foundations | complete | merged stack | through `e624f9a` | connection, readiness, UserState, task, policy, cost, architecture, provider runtime contracts | none | none | #406-#436 | merged CI green | merged | none |
| Gmail provider | complete | merged | `81aa70d` | Gmail adapter; prompt boundary tests | provider runtime | none | #437 | focused 11 pass; CI green | merged | OAuth app credentials for live verification |
| Microsoft Graph provider | complete | merged | `3cba437` | Graph adapter; busy-block tests | provider runtime | none | #438 | focused 31 pass; CI green | merged | Microsoft app credentials for live verification |
| Todoist + Notion providers | complete | merged | `006b2e8` | task provider adapters; integration tests | provider runtime; canonical external task | none | #439 | focused 10 pass; CI green | merged | provider credentials for live verification |
| RescueTime context | CI running | `program/rescuetime-context-domain` | `006b2e8` | aggregate context adapter; UserState projection tests | provider runtime; UserState projection | none | #440 | focused 34 pass; typecheck and registration pass | open | provider credentials for live verification |
| Meeting intelligence | CI running | `program/meeting-intelligence-domain` | `006b2e8` | meeting proposal boundary; proposal tests | provider runtime; canonical commitment proposal | none | #441 | focused 61 pass; typecheck and registration pass | open | meeting-provider credentials for live verification |
| Cross-provider identity | ready for PR | `program/cross-provider-dedupe` | `006b2e8` | provider-independent identity decisions and adversarial integration cases | Gmail, Microsoft Graph, canonical external task | none | pending | focused integration suite 25 pass; typecheck and registration pass | local commit `2b6d817` | none |
| Travel planning | CI running | `program/travel-planning-domain` | `d828b65` | travel constraint projection; planner tests | canonical planner | none | #442 | focused 28 pass; typecheck and registration pass | open | live travel estimate provider not selected |
| HealthKit native bridge | CI running | `program/healthkit-native-bridge` | `81aa70d` | local Expo module, iOS bridge, narrow adapters/tests | canonical readiness | shared app config remains owned by #449 | #456 | root 18 + mobile 3 pass; root/mobile typecheck and registration pass; prebuild passed; full iOS simulator app build passed | open | physical iOS permission/read verification; Apple declarations |
| Health Connect native bridge | CI running | `program/health-connect-native-bridge` | `81aa70d` | local Expo module, Android bridge/manifest, narrow adapters/tests | canonical readiness | shared app config/package remains owned by #449 | #457 | root 18 + mobile 3 pass; root/mobile typecheck and registration pass; prebuild passed; Health Connect Kotlin target compiles; full app assemble reaches the pre-existing Firebase notification metadata conflict in #449's app-config surface | open | Android device permission verification; Play declaration |
| Action Gateway runtime | CI running | `program/action-gateway-runtime` | `d828b65` | canonical action execution and audit runtime | Action Policy | none | #450 | focused 42 pass; typecheck and registration pass | open | provider executors require credentials |
| MCP capability gateway | stacked CI running | `program/mcp-capability-domain` | `2f6b78d` | MCP capability adapter; policy/red-team tests | #450 | none | #451 | focused 59 pass; typecheck and registration pass | open, stacked | operator mappings and live MCP credentials |
| RevenueCat entitlement domain | CI running | `program/revenuecat-entitlement-domain` | `d828b65` | entitlement projection and tests | entitlement foundation | SDK wiring collides with #449/Dependabot mobile packages | #452 | focused 18 pass; typecheck and registration pass | open | store products, RevenueCat credentials, device restore verification |
| Timefold shadow experiment | CI running | `program/timefold-shadow-experiment` | `d828b65` | dependency-free planner experiment and metrics | canonical planner | solver dependency addition requires Dependabot reconciliation | #453 | focused 16 pass; typecheck and registration pass | open | none for dependency-free boundary |
| Controlled email actions | stacked CI running | `program/controlled-email-actions` | `2f6b78d` | review-bound draft/send flow; safety tests | #450; Gmail/Graph executors | none | #454 | focused 53 pass; typecheck and registration pass | open, stacked | live provider credentials |

## Automatically unblocked

- #448 cleared the reminder action ownership that previously blocked native
  health module work. HealthKit and Health Connect native bridges are now
  implemented as isolated local Expo modules.
- #436 landed the canonical provider runtime. Provider PRs #437-#441 now target
  `main` directly and no longer duplicate the runtime contract in their diffs.
- #445 landed ICS ingestion and released the root package, calendar, and storage
  ownership boundary. All active program branches were rebased and retested on
  `d828b65`.
- Action, travel, Timefold, entitlement, MCP, and controlled-email lanes have
  advanced without waiting for unrelated package collisions.

## Current blocked integration work

| Work | Blocking condition | Automatic resume condition |
| --- | --- | --- |
| HealthKit app entitlement and usage description | #449 owns `mobile/app.config.ts` | Refresh main/Graphify and add through integration lane after #449 merges. |
| Health Connect shared Android/app declarations | #449 and mobile package PRs own shared mobile setup | Reconcile after current mobile owners merge. |
| Mobile readiness UX and locale copy | #449 owns settings/locales | Start from refreshed main after #449 merges. |
| RevenueCat SDK/native wiring | #449 and mobile Dependabot own manifests/lockfile; store products need owner | Reconcile packages, then prebuild and device-test. |
| Timefold solver dependency | root Dependabot PRs own package surfaces | Classify and reconcile dependency PRs after the benchmark boundary merges. |
| Live OAuth/provider verification | external app credentials | Run contract-approved smoke tests when credentials are supplied. |

## Merge discipline

Before every merge: fetch `origin/main`, refresh Graphify incrementally when
main changed, rebase, rerun relevant tests, and verify that no merged PR
supersedes the lane. After every material main update, rescan collisions and
rebase affected open lanes. Keep `graphify-out/` uncommitted.
