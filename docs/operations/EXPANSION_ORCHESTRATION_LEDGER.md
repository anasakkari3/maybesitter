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
| Root package manifest | PR #402, PR #403, dependabot PRs | Foundation lanes must not register tests or dependencies in `package.json`. |
| Mobile package manifest and lockfile | PR #402, PR #405, dependabot PRs | No native/provider package setup yet. |
| Mobile locale files | PR #405 | Integration lane batches copy changes after notification lane lands. |
| Storage path registry | PR #405 | Foundation lanes avoid `lib/storage/paths.ts`; new storage names queue through integration. |
| GitHub Actions dependency updates | Dependabot PR #372, #373 | Integration lane defers workflow changes. |

An active collision in one subsystem does not block unrelated foundation lanes.

## Lane ledger

| Lane | Status | Branch | Base SHA | Owned files | Upstream dependencies | Active collisions | PR | Test status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Integration | running | `program/integration-lane` | `01b4b939a9cc` | `docs/operations/EXPANSION_ORCHESTRATION_LEDGER.md` | none | package/lockfile collisions reserved here | not opened | doc-only |
| Context foundations | running | `program/foundation-context` | `01b4b939a9cc` | new provider-independent contracts and focused contract tests | none | must avoid package registration and share files | not opened | pending |
| Action policy foundations | running | `program/foundation-actions` | `01b4b939a9cc` | new action policy contracts and focused contract tests | none | must avoid package registration and provider implementations | not opened | pending |
| Cost attribution foundations | running | `program/foundation-costs` | `01b4b939a9cc` | new cost attribution contracts and focused contract tests | existing usage guard concepts | must not create a second usage store | not opened | pending |

## Blocked lanes

| Lane | Blocker | Resume condition |
| --- | --- | --- |
| HealthKit native setup | native capability and privacy/store surfaces | owner/device capability decisions and mobile ownership clearance |
| Health Connect native setup | native dependencies and Android config | mobile dependency ownership clearance |
| RevenueCat setup | native packages, store products, owner console work | owner store products and dependency queue clearance |
| Share provider extensions | active share PR ownership | PR #402/#403 merged or explicitly handed off |
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
