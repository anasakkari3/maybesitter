# Edit Path Repair and Debt Cleanup — Design

> **Historical — do not follow these commands.** This document dates from the
> retired Flutter client, when `mobile/**` was the Flutter app. **`mobile/` is
> now the React Native application.** Any `flutter` command below refers to the
> archived client at tag `archive/flutter-final`, not to anything on `main`.
> See `docs/migration/flutter-to-rn-parity.md` (UC-2.R5, #175).

Date: 2026-08-22
Status: Approved for planning
Branch target: a dedicated worktree off `main`

## Purpose

Close the technical debt that the 2026-08-22 simulator audit and its
remediation pass left behind or newly exposed. The goal is a codebase with no
known-broken behaviour in the commitment edit path, no silent data loss in
capture, and no latent landmines in build configuration — not new features and
not hosting.

Explicitly **not** in scope: hosting the backend, building Arabic/Hebrew
evaluation corpora, improving extraction quality itself, or localisation of
leaked English strings. Those are product work, tracked separately.

## What was verified before writing this

Every claim below was checked against the code or reproduced live, not carried
over from a report.

1. **The mobile edit path corrupts scheduled times on any server whose
   timezone differs from the device's.** `parseIsoDate`
   (`lib/services/mobile/time.ts:3`) is `new Date(value)` with no zone
   handling. Dart's `DateTime.toIso8601String()` on a local `DateTime` emits no
   offset (`2026-08-23T15:00:00.000`). Node then resolves that against the
   *server's* zone. Reproduced:

   | Server zone | Input | Stored | User sees |
   | --- | --- | --- | --- |
   | `Asia/Jerusalem` (dev machine) | 15:00 | `12:00Z` | 15:00 ✅ |
   | `UTC` (any hosted deploy) | 15:00 | `15:00Z` | **18:00** ❌ |

   It has stayed invisible because the dev server shares the device's zone.

2. **The fix for this exists only on a legacy branch.** Commit `87408da`
   ("backend: stop PATCH from corrupting non-UTC scheduled times") is reachable
   only from `remotes/legacy/checkpoint-sprint-01-backend`. It is not an
   ancestor of `main`.

3. **Half of that fix is already on `main` by a different route.**
   `patchTimeSpec` (`lib/services/mobile/commitmentService.ts:84`) already
   returns `undefined` when neither `dueDate` nor `reminderTime` is supplied —
   the legacy commit's "don't rebuild timeSpec you weren't asked to touch"
   principle. What is missing is its second half: composing the instant with
   `localTimeToUTC` in the commitment's own zone.

4. **`localTimeToUTC` and its test suite are harvestable.** The helper lives in
   `src/utils/timezoneUtils.ts` on the legacy branch (~18 lines, DST-correct by
   round-trip offset resolution) and does not exist on `main`. The legacy
   commit also carries `tests/mobile/routes/patchTimeSpecIntegrity.test.ts`
   (246 lines), also absent from `main`.

5. **The current `isLocalDevBackend` justification is false.** The comment
   added during the remediation pass claims a localhost backend "necessarily
   carries the paired fix". It does not — `main` has no such fix. Localhost
   merely shares the device's zone, which masks the bug rather than avoiding
   it.

6. **`UpdateCommitment` already supports time edits without a status change.**
   `src/domain/stateMachine.ts:175` accepts `updates.timeSpec`, and the handler
   at `:594` preserves status. The only reason `editTime()` reuses `postpone()`
   is that the `update()` path was broken, not that the domain lacked support.

7. **Making `update()` persist is not a one-line change.**
   `CommitmentStateChange` (`mobile/lib/services/mock/commitment_state_store.dart:31`)
   carries only `status`, `scheduledDate`, `completedAt`, `fullCommitment`, and
   `_persist()` skips any seed commitment that is still `pending` with no
   `completedAt`. A seed whose *title* was edited matches that skip condition
   and has no field to store even if it didn't.

8. **The extraction path reports confidence it has not earned.** Reproduced
   against the real rule-based extractor on a running backend:

   | Input | Items | Times kept | `needsClarification` |
   | --- | --- | --- | --- |
   | ar: 3 commitments, 3 times | 1 | 1 of 3 | **false** |
   | en: 3 commitments, 3 times | 2 | 2 of 3 | **false** |
   | en: 2 commitments, no times | 2 | — | true |
   | he: 2 commitments, 2 times | 1 | 0 of 2 | true |

   The failure mode that matters is row 1 and 2: input carried more time
   expressions than the output accounts for, and the response still declared no
   clarification needed.

## Design decisions

### D1 — Where timezone correctness lives

Three options were considered:

- **Client-only.** Mobile combines `scheduledDate` + `startTime` into a local
  `DateTime`, converts with `.toUtc()`, and sends an unambiguous `…Z` instant.
  Cheap, removes the ambiguity at source — but any other client that sends
  wall-clock time still corrupts silently.
- **Server-only** (the legacy commit's approach). Server composes wall-clock
  parts in the commitment's own zone via `localTimeToUTC`. Robust for every
  client; more server code.
- **Both.**

**Decision: both, layered.** Mobile sends an unambiguous UTC instant, and the
server treats any offset-less datetime it receives as wall-clock time *in the
commitment's own zone* rather than the server's. The client change removes the
bug for the only client we ship; the server change makes the corruption
unrepresentable regardless of caller, including the legacy web route that
shares this path. Neither half is redundant: the server rule is the invariant,
the client rule is the clean wire format.

Rejected: rejecting offset-less input with an error. It would be the strictest
option but breaks existing callers we have not audited, and this is a debt pass,
not a contract change.

### D2 — What happens to the reminder when only the due date moves

`patchTimeSpec` currently sets `remindAt = dueAt` whenever `dueDate` is supplied
without `reminderTime`, discarding whatever lead time the user had.

Two defensible behaviours: preserve `remindAt` untouched (consistent with
`UpdateCommitment`'s field-by-field merge), or move it with the due date.
Preserving it strands the reminder in the past when the due date moves forward;
overwriting it destroys the user's chosen lead time.

**Decision: preserve the offset.** When `dueDate` moves and `reminderTime` is
absent, shift `remindAt` by the same delta, keeping the gap the user chose. When
the commitment had no `remindAt`, leave it absent. This is the only option where
the user's expressed intent (the lead time) survives.

### D3 — `isLocalDevBackend` after the fix

Once the server-side fix lands on `main`, the existing behaviour becomes correct
for the right reason: a localhost backend genuinely is built from this checkout
and therefore genuinely carries the fix. No behaviour change is needed — only
the false comment must be replaced with the real justification, and it must be
sequenced *after* the fix so it is true when written.

### D4 — Scope of the capture safety valve

Improving extraction quality (splitting Arabic correctly) requires evaluation
data that does not exist and is out of scope. Refusing to *claim confidence*
does not.

**Decision: add a post-extraction guard only.** Count time expressions in the
input; if the returned items account for fewer of them than were found, force
`disposition: 'needs_clarification'` regardless of what the extractor reported.
This converts silent loss into a visible question without touching the parser.
It is deliberately a blunt instrument: it will sometimes ask when it could have
been sure, which is the safe direction for this failure class.

## Work items

Ordered by dependency. Each is independently testable and independently
revertible.

| # | Item | Depends on |
| --- | --- | --- |
| T1 | Merge the alpha-trace session-isolation fix into `main` | — |
| T2 | Harvest `localTimeToUTC` + its integrity tests; fix `patchTimeSpec` zone composition | — |
| T3 | Preserve the reminder offset when only the due date moves | T2 |
| T4 | Mobile sends unambiguous UTC instants, including the time field | T2 |
| T5 | Make `update()` durable in the mock repository | — |
| T6 | Move `editTime()` from `postpone()` to `update()` | T3, T4, T5 |
| T7 | Keep `endTime` coherent when the start time changes | T6 |
| T8 | Capture safety valve for unaccounted time expressions | — |
| T9 | One test that exercises the default configuration with no overrides | — |
| T10 | Guard that a pilot build sets both required dart-defines | — |

### T1 — Merge the alpha-trace security fix

`fix/alpha-trace-session-isolation` (`62d3ce9`, `970b9af`) fixes a session
hijack that lets one pilot participant read another's raw captured text, plus a
deletion bug. Tracing is off by default
(`MAYBESITTER_ALPHA_TRACE_ENABLED !== 'true'`), so the vulnerability is dormant
rather than live — but the capture route writes raw input text into that store,
so it wakes the moment anyone enables tracing. Merge it while it is cheap.

### T2 — Timezone-correct patching

Port `localTimeToUTC` and `toLocalComponents` from the legacy
`src/utils/timezoneUtils.ts` into a module on `main` (extending
`lib/services/mobile/time.ts` is the natural home, since `normalizeTimezone`
and `localDayKey` already live there). Rewrite `patchTimeSpec` so that a
datetime string carrying no offset is composed in `current.timeSpec.timezone`
rather than resolved against the server's zone. Strings that carry an offset or
`Z` keep their current, already-correct behaviour.

Port `tests/mobile/routes/patchTimeSpecIntegrity.test.ts` and adapt it to
`main`'s call path — it targets the same invariant even though the code it was
written against has since been refactored. Add one case that runs under a
forced non-local `TZ`, since that is the configuration where the bug appears and
the existing suite would otherwise keep passing for the wrong reason.

Then correct the `isLocalDevBackend` comment in
`mobile/lib/config/app_config.dart` (see D3) — in this task, not earlier, so the
new justification is true when it is written.

### T3 — Reminder offset preservation

Implement D2 in `patchTimeSpec`. Test: a commitment with a two-hour lead time
whose due date moves forward a day keeps a two-hour lead time; one with no
reminder gains none.

### T4 — Unambiguous instants from the client

`ApiCommitmentRepository.update()` currently sends
`dueDate: commitment.scheduledDate?.toIso8601String()` and omits the time
entirely. Compose `scheduledDate` and `startTime` into a local `DateTime`,
convert with `.toUtc()`, and send both `dueDate` and `reminderTime` as explicit
UTC instants. This is what makes editing a *time* reach the backend at all —
today only `patchFields()` sends `reminderTime`, and it is not on the repository
interface.

### T5 — Durable `update()` in the mock repository

Three changes, all in `mobile/lib/services/mock/`:

1. `InMemoryCommitmentRepository.update()` must call `_persist()`.
2. `_persist()`'s "unmodified seed" skip must detect field edits, not only
   status changes. Keep a snapshot of the seeded values at construction and
   treat any commitment that differs from its snapshot as needing a row.
3. Store the whole commitment for edited seeds, reusing the existing
   `fullCommitment` field rather than adding one field per editable attribute.
   This collapses "new commitment" and "edited seed" into a single persisted
   shape.

Test: edit a seeded commitment's title, construct a fresh repository over the
same store, and assert the edited title survives — the case that fails today.

### T6 — `editTime()` uses the update path

With T3-T5 landed, `editTime()` can call `update()` alone. Remove the
`postpone()` call, the second `update()` call that existed only to refresh the
display string, and the snackbar disclosing the postpone side effect. The status
no longer flips and no spurious "Postponed" entry reaches the activity log.

Keep the past-time guard: `UpdateCommitment` has no "must be in the future"
rule, so the guard is now the only thing preventing a scheduled time in the
past. Its existing test stays as-is.

### T7 — `endTime` coherence

`Commitment.copyWith()` cannot clear `endTime`, so editing only the start time
leaves the old end time in place and the UI renders ranges like
`3:45 PM — 11:15 AM`. Shift `endTime` by the same delta as `startTime`,
preserving the commitment's duration. Add a `clearEndTime` flag to `copyWith`
for the case where a commitment legitimately loses its end time.

### T8 — Capture safety valve

Implement D4 in the mobile capture service path
(`lib/services/captureService.ts`, where `disposition` is aggregated). Count
time expressions found in the raw input, compare against the count the returned
items resolve, and force `needs_clarification` when the input carried more.

Do not write new time patterns. `src/extraction/ruleBasedExtractor.ts:201-202`
already carries global-flagged regexes covering both English (`at`/`by`/
`around`) and Arabic (`الساعة`/`عند`/`على` plus `صباحا`/`مساء`/`المسا`)
forms, used today to strip time tokens from titles. Export them as a
`countTimeExpressions(text): number` helper and consume that, so the guard and
the parser can never disagree about what counts as a time.

Test with the reproductions from this document: the Arabic three-commitment
sentence and the English three-commitment sentence must both come back asking
for clarification instead of confidently returning fewer items.

### T9 — A test that sees the default configuration

Every widget test that renders the app injects `ApiMode.mock`, which is why the
remediation pass shipped a build that opened to a pilot token screen instead of
the app and left 391 tests green. Add one test that builds the widget tree with
no provider overrides at all and asserts it reaches the main screen.

### T10 — Pilot build flag guard

A pilot build needs `REQUIRE_PILOT_ACCESS_GATE=true` and
`ENABLE_SAFE_COMMITMENT_PATCH=true`. Omitting the first ships a build with no
access gate at all.

This repository has no CI workflows (`.github/workflows` does not exist), so
the guard is a test, not a pipeline step: assert that the checked-in pilot
build configuration — whatever declares those defines — carries both. If no
such configuration file exists yet, the task is to create one (a documented
build script or dart-define file) and test it, rather than to test nothing.
The point is that the flags live somewhere checked in and verified, instead of
in a command someone types from memory.

## Testing strategy

- Every item ships with a test that fails before the change. Several of the
  bugs here are invisible to the current suite by construction (T2 passes
  locally regardless; T9 exists because the suite is blind to the default
  config), so a test that does not fail first proves nothing.
- T2's test must control `TZ` explicitly. A test that inherits the developer's
  zone cannot distinguish the fixed code from the broken code.
- T5 and T7 assert across a repository restart, not within one instance.
- Full `npm test` and `flutter test` must stay green; both are green today
  (3249 and 394).

## Risks

- **T4 changes the wire format** of an existing endpoint's input from
  wall-clock to UTC instants. The server accepts both after T2, so this is
  additive, but any fixture or test asserting the old string shape will need
  updating.
- **T8 will over-ask.** A blunt count-based guard will sometimes request
  clarification for input the extractor handled correctly. That is the intended
  trade for this pass; tightening it belongs with the extraction-quality work.
- **T5 changes the persisted JSON shape** for edited seeds. Existing stored
  state from a previous install will not carry the new fields; the restore path
  must tolerate their absence rather than throwing.
