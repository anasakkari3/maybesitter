# Full Debt Repair — Ledger

> **Historical — do not follow these commands.** This document dates from the
> retired Flutter client, when `mobile/**` was the Flutter app. **`mobile/` is
> now the React Native application.** Any `flutter` command below refers to the
> archived client at tag `archive/flutter-final`, not to anything on `main`.
> See `docs/migration/flutter-to-rn-parity.md` (UC-2.R5, #175).

Worktree: `.worktrees/full-debt-repair`
Branch: `fix/full-debt-repair`, based on `main` @ `06df808`
Started: 2026-08-22

## Baseline (measured, not assumed)

| Gate | Result |
| --- | --- |
| `npm test` | **3249 pass / 0 fail / 0 skip** |
| `flutter test` | **394 pass / 1 skip / 0 fail** |
| `flutter analyze` | **5 warnings**, all `unnecessary_non_null_assertion` in `test/unit/in_memory_repository_test.dart:99-103` |
| `npm run typecheck` | ❌ **1 pre-existing error** — `lib/analytics/privacySafeEvents.ts:10` TS2740 |

The typecheck failure predates this branch. Recorded as item **#12**.

## Item status

| # | Item | Status |
| --- | --- | --- |
| 7 | alpha-trace session isolation | done |
| 11 | timezone shift on hosted server | done |
| 4 | `update()` not durable | done |
| 6 | time edit marks "Postponed" | done |
| 5 | `endTime` incoherent | done |
| 1 | silent commitment loss + false confidence | done |
| 3 | multilingual evaluation corpus | done |
| 8 | tests blind to default configuration | done |
| 9 | pilot build flags unpinned | done |
| 10 | localization leakage | IN PROGRESS — 7 ARB keys added, call sites not yet wired (see RESUME.md) |
| 2 | hosted backend | NOT STARTED — externally blocked, needs GCP credentials (see RESUME.md) |
| 12 | typecheck error (baseline) | done |

## Work log

| # | Failing test proved | Fix | Suite after | Commit |
| --- | --- | --- | --- | --- |
| 12 | `validateAnalyticsEvent` threw `TypeError: Cannot read properties of undefined` for 6 mobile-emitted events | privacy allowlist entries with property names taken from the Dart factories | npm 3251, typecheck 0 | `59a4c3a` |
| 7 | 3 probes failed: ownership transfer, victim's raw text readable by attacker, path traversal | cherry-picked `62d3ce9` + `970b9af` (applied byte-identically), probes registered in the explicit `npm test` list | npm 3263 | `9ebd009`, `a973575`, `e12a5e0` |
| 4 | edited title / edited start time / deleted / cancelled seed all lost on relaunch; delimiter-crafted title read as unmodified | `update`/`cancel`/`delete` now persist; seed comparison by `jsonEncode(toJson())` instead of status; whole record stored for any changed seed; deletion tombstone applied last in `_restore` | flutter 399 | `16037e0` |
| 11 (server) | offset-less datetime resolved against the server zone — same input stored a different instant under `TZ=UTC` vs `TZ=Asia/Jerusalem` | `parseIsoInstant` reads offset-less input as UTC; wired into `dueDate`, `reminderTime`, `postponedUntil` | npm 3271 under `TZ=UTC` | `7db2bbd` |
| 11 (client) + 6 | `instantFrom` absent; time edit marked the commitment postponed and wrote a false Activity entry | client sends one explicit UTC instant incl. time of day; `editTime()` moved to `update()`; disclosure string removed from all 3 ARBs | flutter 407, analyze 5 baseline | `48c4c5a` |


## Stopped

Stopped deliberately at `2df2771` on 2026-08-23, mid-item-#10. `RESUME.md` holds
the exact restart point, the remaining leak sites with file:line, and two
findings carried forward: an unfixed Arabic weekday defect in the extractor, and
a corpus case I mislabelled and removed.
