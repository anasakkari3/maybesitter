# Expansion orchestration ledger

Program start: 2026-09-16
Base main: `01b4b939a9cc`

This ledger tracks the provider-expansion program while existing S3/S4 work is
still active. It is intentionally operational: it assigns ownership, records
collisions, and names the lanes that may proceed without owner credentials.

## Shared-file ownership

The integration lane exclusively owns edits to these shared hotspots:

| Surface | Integration owner action |
| --- | --- |
| `package.json`, `package-lock.json`, `mobile/package.json`, `mobile/package-lock.json` | Queue and reconcile dependency/script changes after active share PRs land. |
| Shared env/config and central feature flags | Add provider flags only after the contract lane names them and collisions are rechecked. |
| Firestore indexes, rules, and storage path registry | Accept only explicit schema additions with deletion/export semantics. |
| Contract barrels and broad re-export files | Add exports only after each contract PR is reviewed and deduped. |
| Locale files | Batch mobile copy additions after mobile ownership clears. |
| Privacy, store, and legal declarations | Update from feature deltas, not speculative provider plans. |

Implementation lanes may add narrow files and narrow tests in their worktrees.
They should not edit the shared surfaces above directly unless the integration
lane hands off a specific patch.

## Active collisions

| Collision | Owner | Effect |
| --- | --- | --- |
| Share channel implementation | PR #402, PR #403 | Foundation lanes must not edit `lib/services/share/**` except future integration review. |
| Mobile share flow | PR #402, PR #403 | No edits to `mobile/src/features/share/**` or share fixtures. |
| Notifications, reminders, device registry | PR #405 | No edits to push/reminder/device registration, mobile notification setup, reminder settings, or related API fixtures. |
| Mobile plan screen and locale copy | PR #408 | No edits to `mobile/src/features/plan/**`, `mobile/src/screens/PlanScreen.tsx`, plan API fixtures, loop analytics, or shared mobile locale files. |
| Device calendar and commitment linking | PR #412 | No edits to device-calendar sync/linking, calendar settings, commitment mobile routes, `lib/storage/paths.ts`, mobile app config, mobile package files, or mobile locale files. |
| Root package manifest | PR #402, PR #403, PR #412, dependabot PRs | Foundation lanes must not register tests or dependencies in `package.json`. |
| Mobile package manifest and lockfile | PR #402, PR #405, PR #412, dependabot PRs | No native/provider package setup yet. |
| Mobile locale files | PR #405, PR #408, PR #412 | Integration lane batches copy changes after mobile feature lanes land. |
| Storage path registry | PR #405, PR #412 | Foundation lanes avoid `lib/storage/paths.ts`; new storage names queue through integration. |
| GitHub Actions dependency updates | Dependabot PR #372, #373 | Integration lane defers workflow changes. |

An active collision in one subsystem does not block unrelated foundation lanes.

## Lane ledger

| Lane | Status | Branch | Base SHA | Owned files | Upstream dependencies | Active collisions | PR | Test status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Integration | running | `program/integration-lane` | `01b4b939a9cc` | `docs/operations/EXPANSION_ORCHESTRATION_LEDGER.md` | none | package/lockfile/mobile config/storage path collisions reserved here | [#406](https://github.com/anasakkari3/maybesitter/pull/406) | CI pass |
| Context foundations | PR open | `program/foundation-context` | `01b4b939a9cc` | `src/contracts/v1/integrationConnectionContracts.ts`, `src/contracts/v1/readinessContracts.ts`, `src/contracts/v1/userStateProjectionContracts.ts`, `src/contracts/v1/externalTaskContracts.ts`, `tests/contract/runtimeControls.test.ts` | none | avoids package registration, mobile, share, calendar, storage paths | [#407](https://github.com/anasakkari3/maybesitter/pull/407) | focused tests pass; CI rerunning after registration fix |
| Action policy foundations | PR open | `program/foundation-actions` | `01b4b939a9cc` | `src/contracts/v1/actionPolicyContracts.ts`, `tests/safety/policyContract.test.ts` | none | avoids provider implementations and shared package manifests | [#409](https://github.com/anasakkari3/maybesitter/pull/409) | focused tests pass; CI rerunning after registration fix |
| Cost attribution foundations | PR open | `program/foundation-costs` | `01b4b939a9cc` | `src/contracts/v1/costAttributionContracts.ts`, `tests/llm/usageGuard.test.ts` | existing usage guard concepts | must not create a second usage store | [#410](https://github.com/anasakkari3/maybesitter/pull/410) | focused tests pass; CI rerunning after registration fix |
| Architecture boundary tests | PR open | `program/foundation-boundary-tests` | `01b4b939a9cc` | `tests/contract/intelligenceModuleBoundaries.test.ts` | context/action/cost contracts are adjacent but not imported | avoids package registration and provider implementation files | [#411](https://github.com/anasakkari3/maybesitter/pull/411) | focused tests pass; CI rerunning after registration fix |

## Blocked lanes

| Lane | Blocker | Resume condition |
| --- | --- | --- |
| HealthKit native setup | native capability and privacy/store surfaces | owner/device capability decisions and mobile ownership clearance |
| Health Connect native setup | native dependencies and Android config | mobile dependency ownership clearance |
| RevenueCat setup | native packages, store products, owner console work | owner store products and dependency queue clearance |
| Share provider extensions | active share PR ownership | PR #402/#403 merged or explicitly handed off |
| Device calendar/provider wiring | active device-calendar PR ownership | PR #412 merged or explicitly handed off |
| Provider OAuth implementations | external app credentials and connection UI ownership | foundation contracts merged, credentials available, UI ownership clear |

## Merge discipline

Each lane repeats:

1. Fetch `origin/main`.
2. Refresh Graphify incrementally.
3. Recheck open PRs/issues.
4. Confirm file ownership.
5. Commit only lane-owned files.
6. Run focused tests.
7. Recheck overlap before PR.
8. Open PR only when the branch is still additive and conflict-free.

Provider-specific implementations must consume these foundations rather than
redeclaring private connection, readiness, task, cost, or action-policy models.
