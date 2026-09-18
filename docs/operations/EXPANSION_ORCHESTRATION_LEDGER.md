# Expansion orchestration ledger

Updated: 2026-09-18
Current integration base: `c60d896` (`origin/main` after #485)
Release-candidate SHA for UAT: `c60d896`

This is the live ownership and dependency ledger for the expansion program.
Git and current GitHub state remain authoritative; Graphify is refreshed
incrementally after material changes and is used as the navigation index.

## Priority stabilization: real-user UAT findings — LANDED

A real-user UAT ran on 2026-09-17. It used the iOS Simulator with real Firebase
Auth and a real local backend, on frozen `6b9c069`, before #469/#471. Capture →
review → commit → act → history worked, account isolation passed, and Arabic and
Hebrew RTL passed. It also found three defects in the core loop.

**All three are now fixed and on main**, together with the #469 onboarding
follow-up, as a single dependency-ordered integration train on 2026-09-17/18:

| Issue | PR | Merged as | What landed |
| --- | --- | --- | --- |
| #474 | #479 | `9929900` | The clarify `none` answer settles the item as a confirmable time-less draft. The command is built through `applyEditToCommands({resolvedTime: null})` — the same path a confirm-time "No time" edit takes — so the two cannot disagree about what a time-less commitment is. The locked rule that a confirm-time edit with half an answer stays unconfirmable is unchanged. |
| #477 | #482 | `5962505` | On-demand build for the account's today/tomorrow. It adds **no second planner**: `storeFirstPlan` was extracted as the single first-plan generation path and the morning tick was refactored onto it, so the two callers cannot drift. Idempotent through `createIfAbsent`'s transaction; sends no push. |
| #475 | #483 | `335b452` | The saved preference is never written, so allowing notifications later just works. OS permission is read on mount and on every foreground return, race-guarded by a monotonic counter. `provisional` is handled distinctly from `denied`. The blocked Must choice renders warm, not accent. |
| #469 follow-up | #484 | `2490cd7` | The first setup question is a broad conversational life narrative. |
| #480 | #485 | `c60d896` | The commands a manual completion commits are written back onto the proposal, in the same transaction as the commitments, so `persisted`, the collision warning, Undo and activation can all resolve the commitment the confirm created. |

**Integration evidence.** Each PR passed a three-stage gate. Gate 3 was run by
the integration lane against the then-current main, and every merge was
re-verified rather than trusting a prior green:

- #479 was based on the live main tip, so its CI was genuinely fresh. Root
  5278/5278, mobile 184 suites / 2477 tests.
- #482 was rebased onto `9929900` and force-pushed to get fresh CI. Root
  5297/5297, mobile 184 / 2487, CI 9/9 green on the rebased head.
- #483 was rebased onto `5962505` and force-pushed. Mobile 184 / 2492, CI 9/9
  green on the rebased head.
- #484 could not be force-pushed by the integration lane. Instead of accepting
  CI that was green on a three-commit-stale base, `git merge-tree` was used to
  prove the merge result was byte-identical to the locally rebased tree, and
  CI's own steps were then reproduced on that exact tree: mobile `tsc` clean,
  `expo lint --no-cache` 0 errors, mobile `npm test -- --runInBand` 185 suites /
  2523 tests, root 5297/5297, root typecheck clean.
- Post-merge, main `2490cd7` was re-verified directly: its tree is identical to
  the verified tree and root is 5297/5297.

**Locale collision — resolved.** #482, #483 and #484 all edited
`mobile/src/i18n/locales/{ar,en,he}.json`. The integration lane owned the
reconciliation and kept every side. After the final rebase this was verified,
not assumed: all three key blocks coexist (`plan*`, `notif*`, `obSetupLife*`),
the keys #484 replaced (`obSetupIntro`, `obSetupWork*`) are gone from all three
files, no code in `mobile/src` still references a removed key, and key parity is
exact (`ar == en`, `he == en + _meta`, that asymmetry being pre-existing).
`parity.test.ts` and `typedKeys.test.ts` enforce this going forward.

**Still open from this work:** #480 (P2), found while fixing #474 and
deliberately not folded into it. A clarification item completed by hand in
review may be persisted and activated while the confirm response returns
`persisted: []`, so Undo and the collision warning skip it. It is owned by the
S3/UAT lane, to be re-verified against post-integration main `2490cd7` before
being fixed — #479 changed the clarify path but not the edit path #480 describes.

## Release-candidate cross-feature UAT

These items go to the final release-candidate UAT on a device or simulator
build of the RC SHA. Each must be walked by hand; green CI does not count.

**RC candidate SHA: `c60d896`** (`origin/main` after #485). This is the build
the S3/UAT lane should test. The integration lane ran no simulator or device
verification for the train above — that is the UAT lane's, and concurrent
sessions sharing the bundle id have contaminated simulator results before.

| Item | What the RC UAT must show |
| --- | --- |
| #474 | Capture "Study probability for two hours this week" → Leave it without a time → Confirm → the item is on Today with no time. In a two-item proposal, skip one and answer the other. |
| #475 | Enable Ring for Must items → Don't Allow → a warning appears at the control → Open phone settings → allow → return → the warning is gone. Relaunch while denied → the warning is still shown. |
| #477 | Fresh account with delivery off, then with delivery on → Build today's plan → a plan renders → reopen → same plan → Regenerate works. Double-tap builds one plan. |
| #200 | Press Done, Later and Not doing it on a real notification (UAT automation could not drive Notification Center). |
| #203 | Add the widget through the OS widget gallery (UAT automation could not open the gallery). |
| Consent burst | Onboarding's concurrent consent writes persist on the Firestore emulator. UAT lost writes on the in-memory adapter only; unconfirmed, and needs JDK 21. |
| #480 | A clarification item completed by edit (title + time) → confirm → Undo removes it, and the collision warning covers it. Fixed in #485; never reproduced on a device, so the RC walk is what confirms it. |
| #484 | The first setup screen reads as a conversation in ar, he and en, RTL included, and leads somewhere usable with AI consent declined. |
| Setup (#471) | With AI consent declined, the guided setup still leads somewhere usable. The pre-#469 "Add goals yourself" screen had no input. |

## Provider integration status — corrected classification

A single "complete / merged" status on a provider lane was misleading, and this
records why. Tracing the production call paths on `9b08eeb` found that **every
provider adapter on main is a normalizer**: it turns an already-fetched payload
into a provider-independent model and performs no HTTP.

The transports are declared as ports — `GmailApiPort`, `MeetingTranscriptPort`,
`ProviderOAuthClient`, `ProviderCredentialVault`, `ProviderOAuthStateStore` —
and **the only implementations of any of them were test doubles**. Also verified
absent: any provider SDK in the dependency tree, and any provider OAuth callback
route. The only provider URLs in `lib/` are OAuth *scope strings*, not
endpoints; `google-auth-library` is there solely to verify Cloud Scheduler OIDC
tokens. The Google Calendar screen (#152) is a development-only mobile demo
whose token dies with the screen and never reaches the backend.

So "files exist on main" never meant "the integration works". No lane below may
be reported as implemented without naming which of these it has.

| Provider | Domain contract | Normalizer | Production auth | Production transport | Product flow wired | Tested offline | Verified live |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gmail | yes | yes | **Phase A, draft** | no | no | yes | **no** |
| Microsoft Graph | yes | yes | Phase A applies | no | no | yes | **no** |
| Todoist | yes | yes | Phase A applies | no | no | yes | **no** |
| Notion | yes | yes | Phase A applies | no | no | yes | **no** |
| RescueTime | yes | yes | Phase A applies | no | no | yes | **no** |
| WHOOP | yes | **no** (token lifecycle and sync planning only) | Phase A applies | no | no | partial | **no** |
| Meeting intelligence | yes | yes | Phase A applies | no | no | yes | **no** |
| RevenueCat | yes | yes (entitlement projection) | n/a | n/a | no | yes | **no — store/native lane** |

Blocked-by, stated per lane rather than collapsed:

- **All seven context providers:** BLOCKED BY OWNER CREDENTIAL for live
  verification, and until Phase B lands, BLOCKED BY MISSING PRODUCTION
  TRANSPORT — which is not an owner blocker but work.
- **RevenueCat:** BLOCKED BY STORE/CONSOLE. StoreKit and Play Billing
  verification cannot be replaced by a server-side HTTP read.
- **HealthKit / Health Connect:** BLOCKED BY PHYSICAL DEVICE. Device-native
  lanes, outside any HTTP harness by construction.

A provider becomes VERIFIED LIVE only after a credential-backed probe runs
successfully through #490 against the production transport. Never on the
strength of mocks.

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

| Mobile locale files | cleared | #482, #483 and #484 have all landed and their key blocks were reconciled by the integration lane. No lane currently owns these files; a new lane adding copy must still rescan exact overlaps and keep to a disjoint key block. |

An active conflict in one subsystem is not a program-wide blocker.

## Lane ledger

| Lane | Status | Branch | Base SHA | Owned files | Upstream dependencies | Active collisions | PR | CI / test status | Merge status | External blockers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Integration: UAT stabilization ledger | complete | merged | `a38e00d` | this ledger | all landed contracts | none | #478 | documentation-only | merged `44b3d06` | none |
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
| Stabilization: clarify skip (#474) | complete | merged | `44b3d06` | `lib/services/captureBoundary/clarifyService.ts`, `mobile/src/features/capture/`, `mobile/src/screens/ReviewScreen.tsx`, focused and contract tests | none | none | #479 | red-before/green-after with 3 mutation checks; root 5278/5278; mobile 184 suites / 2477 tests; CI 9/9 green on the merged head | merged `9929900` | RC UAT walk |
| Stabilization: plan build on demand (#477) | complete | merged | `9929900` (rebased) | `lib/services/dailyPlan/`, `src/app/api/mobile/plans/[date]/build/`, `PlanScreen.tsx`, plan API client, focused tests, `plan*` locale block | canonical planner | locale files, reconciled by integration | #482 | mutation checks on idempotency, push and date window; root 5297/5297; mobile 184 / 2487; fresh CI 9/9 on the rebased head | merged `5962505` | RC UAT walk |
| Stabilization: Must ring permission (#475) | complete | merged | `5962505` (rebased) | `NotificationsSettingsScreen.tsx`, focused tests, `notif*` locale block | none | locale files, reconciled by integration | #483 | red-before/green-after with 4 mutation checks; mobile 184 / 2492; fresh CI 9/9 on the rebased head | merged `335b452` | RC UAT walk; physical-device permission check |
| First setup screen (#469 follow-up) | complete | merged | `335b452` (merge-tree verified) | `mobile/src/features/onboarding/`, `setupChatCache`, `VoiceButton.tsx`, `.maestro/onboarding.yaml`, `obSetupLife*` locale block | #471 setup flow | locale files, reconciled by integration | #484 | mobile 185 suites / 2523 tests via CI's own `--runInBand`; root 5297/5297; `tsc` and `expo lint --no-cache` clean; merge result proven byte-identical to the verified tree | merged `2490cd7` | RC UAT walk in ar/he/en |
| Stabilization: manual completion persisted (#480) | complete | merged | `9929900` (merge-tree verified) | `captureBoundaryService.ts`, `mobileCaptureService.ts`, `participantState.ts`, contract and football collision tests | #479 | none | #485 | test proven red on unfixed main with the defect's own assertion; root 5299/5299; typecheck clean; `mobile/` byte-identical to main so its CI job carries over; CI 9/9 green on the PR head | merged `c60d896` | device walk of Undo and the collision warning |
| Integration | active | `program/post-stabilization-ledger` | `c60d896` | this ledger; later shared config/package changes | all landed contracts | Dependabot shared package files, deployment workflow PRs, and the local football workspace | this PR | documentation-only | active | Apple/Google console/device verification later |

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
- #479, #482, #483, #484 and #485 landed on `9929900`, `5962505`, `335b452`,
  `2490cd7` and `c60d896`. All three core-loop UAT defects are fixed, so **the stabilization
  hold on provider and expansion lanes is released**: core-loop correctness no
  longer outranks expansion work, and the shared mobile locale files have no
  active owner. The next lane to touch them rescans exact overlaps first.
- The former "awaiting owner merge (auto-mode blocks agent merges)" blocker on
  the three stabilization PRs is cleared; the integration lane merged all four.
  Force-pushing a rebase is still not always available to it, so where it is
  refused the merge-result identity is proven with `git merge-tree` and CI's
  steps are reproduced locally on that exact tree.

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

**Never carry a green forward.** A PR's CI is fresh only if its base is the
live main tip; check the base SHA, do not read the `mergeable` flag as
sufficient. Where a rebase cannot be pushed, prove the merge result with
`git merge-tree` and reproduce CI's steps on that tree. Run `expo lint` with
`--no-cache`: the cache both invents stale errors and hides real new ones.

**Graphify freshness.** The graph at `graphify-out/` is rooted at the *project*
folder, which contains ~60 sibling worktrees at different commits plus archived
Flutter build artifacts, which is why it is ~1.1 GB. An incremental update
therefore re-reads unrelated worktrees and can make the graph a worse index for
main than a known-stale one. Treat it as a navigation aid whose staleness must
be stated, verify anything it says against the source before acting, and prefer
scoped updates.
