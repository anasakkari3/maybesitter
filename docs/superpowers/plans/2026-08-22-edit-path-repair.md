# Edit Path Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make editing a commitment's title and scheduled time correct and durable — no timezone corruption, no lost reminder offsets, no lost edits after relaunch, and no spurious "postponed" status.

**Architecture:** Six tasks along one dependency chain. The backend is fixed first (Tasks 1-2) so that a correct client has a correct server to talk to; the mobile client is fixed next (Tasks 3-4); the feature change that depends on both comes last (Tasks 5-6). Nothing in this plan changes an API contract shape — the server becomes strictly more tolerant, and the client starts sending an unambiguous form the server already accepts.

**Tech Stack:** TypeScript / Next.js (backend, `node --test`), Dart / Flutter (mobile, `flutter_test`), Riverpod (mobile DI), `SharedPreferences` (mobile persistence).

**Spec:** `docs/superpowers/specs/2026-08-22-edit-path-and-debt-cleanup-design.md` — read it before Task 1. It records what was verified, the four design decisions (D1-D4), and why the edit path is one problem rather than three.

## Global Constraints

- Work happens in a dedicated worktree off `main`, created via `superpowers:using-git-worktrees`. Do not implement on `main` directly.
- Every task ships a test that **fails before** the change. Two bugs here are invisible to the current suite by construction — a test that passes on first write proves nothing about them.
- Backend suite: `npm test` from the repo root, currently **3249 pass / 0 fail**. Mobile suite: `flutter test` from `mobile/`, currently **394 pass / 1 skip / 0 fail**. Both must stay green.
- `flutter analyze` must report only the 5 pre-existing `unnecessary_non_null_assertion` warnings in `mobile/test/unit/in_memory_repository_test.dart`. Any new warning is a defect.
- Mobile test convention: package-absolute imports (`package:maybesitter_mobile/...`), one `group()` per unit under test, sentence-style `test()` names, black-box calls against the public API.
- Do **not** port the legacy `localTimeToUTC` verbatim. It compares minute-of-day and lands a day late whenever the zone offset crosses midnight — verified: 23:00 on Aug 23 `Asia/Jerusalem` resolves to Aug **24**. Task 1 carries the corrected form.

---

## Task 1: Timezone-correct instant composition on the server

**Files:**
- Modify: `lib/services/mobile/time.ts` (add helpers alongside the existing `normalizeTimezone` / `localDayKey`)
- Modify: `lib/services/mobile/commitmentService.ts:84-102` (`patchTimeSpec`)
- Test: `tests/mobile/patchTimeSpecIntegrity.test.ts` (new)
- Register the new test file in `package.json`'s `"test"` script

**Interfaces:**
- Produces: `localTimeToUTC(year, month, day, hour, minute, timezone): Date` and `parseIsoDateInZone(value: unknown, field: string, timezone: string): Date`, both exported from `lib/services/mobile/time.ts`. Task 2 consumes `parseIsoDateInZone`.
- Consumes: the existing `TimeSpec` shape (`src/domain/stateMachine.ts:36`) — `{ kind, dueAt, remindAt, timezone }`, where `dueAt`/`remindAt` are ISO strings or null.

**Root cause:** `parseIsoDate` (`lib/services/mobile/time.ts:3`) is `new Date(value)`. An ISO datetime with no offset (`2026-08-23T15:00:00.000` — exactly what Dart's `toIso8601String()` emits for a local `DateTime`) is resolved against the **server's** zone. On a dev machine sharing the device's zone this is right by accident; on any UTC-hosted server every time shifts by the offset.

- [ ] **Step 1: Write the failing test**

Create `tests/mobile/patchTimeSpecIntegrity.test.ts`. The `TZ` assignment must happen before any date work so the test exercises the hosted-server configuration rather than the developer's:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localTimeToUTC, parseIsoDateInZone } from '../../lib/services/mobile/time';

test('an offset-less wall clock resolves in the commitment zone, not the server zone', () => {
  const resolved = parseIsoDateInZone('2026-08-23T15:00:00.000', 'dueDate', 'Asia/Jerusalem');
  assert.equal(resolved.toISOString(), '2026-08-23T12:00:00.000Z');
});

test('an explicit UTC instant is taken as-is', () => {
  const resolved = parseIsoDateInZone('2026-08-23T15:00:00.000Z', 'dueDate', 'Asia/Jerusalem');
  assert.equal(resolved.toISOString(), '2026-08-23T15:00:00.000Z');
});

test('an explicit offset is honoured over the commitment zone', () => {
  const resolved = parseIsoDateInZone('2026-08-23T15:00:00.000+01:00', 'dueDate', 'Asia/Jerusalem');
  assert.equal(resolved.toISOString(), '2026-08-23T14:00:00.000Z');
});

test('a late-evening wall clock keeps its own date across the offset', () => {
  // The legacy helper compared minute-of-day and landed on Aug 24 here.
  const resolved = localTimeToUTC(2026, 8, 23, 23, 0, 'Asia/Jerusalem');
  assert.equal(resolved.toISOString(), '2026-08-23T20:00:00.000Z');
});

test('an after-midnight wall clock keeps its own date across the offset', () => {
  const resolved = localTimeToUTC(2026, 8, 23, 1, 0, 'Asia/Jerusalem');
  assert.equal(resolved.toISOString(), '2026-08-22T22:00:00.000Z');
});

test('a winter date resolves against the winter offset, not the summer one', () => {
  // Asia/Jerusalem is +02:00 in January and +03:00 in August.
  const resolved = localTimeToUTC(2026, 1, 15, 12, 0, 'Asia/Jerusalem');
  assert.equal(resolved.toISOString(), '2026-01-15T10:00:00.000Z');
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/mobile/patchTimeSpecIntegrity.test.ts`

Expected: failure on the import — `localTimeToUTC` and `parseIsoDateInZone` do not exist yet.

- [ ] **Step 3: Add the helpers to `lib/services/mobile/time.ts`**

Append to the file. Note `hour % 24`: some ICU builds render midnight as hour 24 under `hour12: false`, which would corrupt the offset arithmetic.

```ts
interface LocalComponents {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function toLocalComponents(date: Date, timezone: string): LocalComponents {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
  };
}

/**
 * The instant at which the given wall clock reads in `timezone`.
 *
 * Compares whole timestamps rather than minute-of-day: an offset that carries
 * the estimate across midnight changes the date too, and a minute-only
 * comparison silently lands a day out.
 */
export function localTimeToUTC(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const estimate = Date.UTC(year, month - 1, day, hour, minute, 0);
  const local = toLocalComponents(new Date(estimate), timezone);
  const localAsUTC = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  return new Date(estimate - (localAsUTC - estimate));
}

const OFFSET_PRESENT = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Like `parseIsoDate`, but a string that names no offset is read as wall-clock
 * time in `timezone` — the commitment's own zone — instead of being resolved
 * against whatever zone the server happens to run in.
 */
export function parseIsoDateInZone(value: unknown, field: string, timezone: string): Date {
  const parsed = parseIsoDate(value, field);
  const raw = String(value).trim();
  if (OFFSET_PRESENT.test(raw) || !raw.includes('T')) return parsed;

  const local = raw.split('T');
  const [y, m, d] = local[0].split('-').map(Number);
  const [hh, mm] = local[1].split(':').map(Number);
  return localTimeToUTC(y, m, d, hh, mm || 0, normalizeTimezone(timezone));
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/mobile/patchTimeSpecIntegrity.test.ts`

Expected: 6 passing.

- [ ] **Step 5: Route `patchTimeSpec` through the zone-aware parser**

In `lib/services/mobile/commitmentService.ts`, change the import to pull `parseIsoDateInZone` alongside whatever it already imports from `./time`, then replace the two parse calls inside `patchTimeSpec` (lines 89-93). Keep the rest of the function exactly as it is — the `if (!hasDueDate && !hasReminderTime) return undefined` guard above it is already correct and must not be touched.

```ts
  const zone = normalizeTimezone(current.timezone);
  const dueAt = hasDueDate ? parseIsoDateInZone(input.dueDate, 'dueDate', zone).toISOString() : current.dueAt;
  const remindAt = hasReminderTime
    ? parseIsoDateInZone(input.reminderTime, 'reminderTime', zone).toISOString()
    : hasDueDate
      ? dueAt
      : current.remindAt;
```

(The `hasDueDate ? dueAt` branch stays for now — Task 2 replaces it.)

- [ ] **Step 6: Register the new test file**

Add `tests/mobile/patchTimeSpecIntegrity.test.ts` to the `"test"` script's file list in `package.json`, immediately after `tests/mobile/mobilePilotApiRoutes.test.ts`. The list is explicit, not a glob — a file that is not named there never runs.

- [ ] **Step 7: Run the full backend suite**

Run: `npm test`
Expected: 3255 pass / 0 fail (3249 + 6 new).

- [ ] **Step 8: Correct the false justification in the mobile config**

Now — and not before, because only now is it true — replace the comment on `isLocalDevBackend` in `mobile/lib/config/app_config.dart` (near line 196). The current text claims a localhost backend "necessarily carries the paired fix"; until this task, `main` had no such fix and localhost merely shared the device's zone. Replace it with a comment stating that the backend composes offset-less instants in the commitment's own zone as of this change, so a localhost backend built from this checkout is safe regardless of the server's own zone.

- [ ] **Step 9: Commit**

```bash
git add lib/services/mobile/time.ts lib/services/mobile/commitmentService.ts tests/mobile/patchTimeSpecIntegrity.test.ts package.json mobile/lib/config/app_config.dart
git commit -m "fix: resolve offset-less patch times in the commitment's zone, not the server's"
```

---

## Task 2: Preserve the reminder's lead time when the due date moves

**Files:**
- Modify: `lib/services/mobile/commitmentService.ts` (`patchTimeSpec`)
- Test: `tests/mobile/patchTimeSpecIntegrity.test.ts` (extend)

**Interfaces:**
- Consumes: `parseIsoDateInZone` from Task 1.
- Produces: no new exports. `patchTimeSpec`'s behaviour changes: `remindAt` shifts with `dueAt` instead of collapsing onto it.

**Root cause:** when `dueDate` is supplied without `reminderTime`, `patchTimeSpec` sets `remindAt = dueAt`, discarding the lead time the user chose. A commitment reminding two hours ahead loses that entirely the first time its date moves.

- [ ] **Step 1: Write the failing test**

Append to `tests/mobile/patchTimeSpecIntegrity.test.ts`:

```ts
import { patchTimeSpecForTest } from '../../lib/services/mobile/commitmentService';

test('moving the due date carries the reminder lead time with it', () => {
  const current = {
    kind: 'due_by' as const,
    dueAt: '2026-08-23T12:00:00.000Z',
    remindAt: '2026-08-23T10:00:00.000Z', // two hours ahead
    timezone: 'Asia/Jerusalem',
  };
  const patched = patchTimeSpecForTest(current, { dueDate: '2026-08-25T12:00:00.000Z' });
  assert.equal(patched?.dueAt, '2026-08-25T12:00:00.000Z');
  assert.equal(patched?.remindAt, '2026-08-25T10:00:00.000Z');
});

test('a commitment with no reminder gains none when its due date moves', () => {
  const current = {
    kind: 'due_by' as const,
    dueAt: '2026-08-23T12:00:00.000Z',
    remindAt: null,
    timezone: 'Asia/Jerusalem',
  };
  const patched = patchTimeSpecForTest(current, { dueDate: '2026-08-25T12:00:00.000Z' });
  assert.equal(patched?.remindAt, null);
});

test('an explicit reminder time wins over the preserved lead time', () => {
  const current = {
    kind: 'due_by' as const,
    dueAt: '2026-08-23T12:00:00.000Z',
    remindAt: '2026-08-23T10:00:00.000Z',
    timezone: 'Asia/Jerusalem',
  };
  const patched = patchTimeSpecForTest(current, {
    dueDate: '2026-08-25T12:00:00.000Z',
    reminderTime: '2026-08-25T08:00:00.000Z',
  });
  assert.equal(patched?.remindAt, '2026-08-25T08:00:00.000Z');
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/mobile/patchTimeSpecIntegrity.test.ts`

Expected: the import fails — `patchTimeSpecForTest` is not exported yet. After Step 3 exports it, the first test fails on `remindAt` being `2026-08-25T12:00:00.000Z` (collapsed onto `dueAt`) instead of `...T10:00:00.000Z`.

- [ ] **Step 3: Implement the shift and export the seam**

Replace the `remindAt` computation in `patchTimeSpec` with a lead-time-preserving version, and export a test seam beside it:

```ts
  const zone = normalizeTimezone(current.timezone);
  const dueAt = hasDueDate ? parseIsoDateInZone(input.dueDate, 'dueDate', zone).toISOString() : current.dueAt;

  let remindAt: string | null;
  if (hasReminderTime) {
    remindAt = parseIsoDateInZone(input.reminderTime, 'reminderTime', zone).toISOString();
  } else if (hasDueDate && current.dueAt && current.remindAt && dueAt) {
    // Keep the gap the user chose rather than collapsing the reminder onto the
    // new due date or stranding it at the old one.
    const lead = Date.parse(current.dueAt) - Date.parse(current.remindAt);
    remindAt = new Date(Date.parse(dueAt) - lead).toISOString();
  } else if (hasDueDate && !current.remindAt) {
    remindAt = null;
  } else {
    remindAt = current.remindAt;
  }

  return {
    kind: dueAt || remindAt ? 'due_by' : 'unscheduled',
    dueAt,
    remindAt,
    timezone: current.timezone,
  } as Partial<TimeSpec>;
}

/** Test seam for the timeSpec patch rules. Not part of the mobile API surface. */
export function patchTimeSpecForTest(current: TimeSpec, input: PatchCommitmentInput) {
  return patchTimeSpec(current, input);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/mobile/patchTimeSpecIntegrity.test.ts`
Expected: 9 passing.

- [ ] **Step 5: Run the full backend suite**

Run: `npm test`
Expected: 3258 pass / 0 fail.

- [ ] **Step 6: Commit**

```bash
git add lib/services/mobile/commitmentService.ts tests/mobile/patchTimeSpecIntegrity.test.ts
git commit -m "fix: keep the reminder's lead time when a commitment's due date moves"
```

---

## Task 3: Send unambiguous instants from the mobile client

**Files:**
- Modify: `mobile/lib/services/api/mappers/backend_time_mapper.dart`
- Modify: `mobile/lib/services/api/api_commitment_repository.dart:56-76` (`update`)
- Test: `mobile/test/unit/backend_time_mapper_test.dart` (new)

**Interfaces:**
- Produces: `BackendTimeMapper.instantFrom(DateTime date, String? clockTime): String?` — combines a local date with a wall-clock string like `'10:30 AM'` and returns an explicit UTC ISO string (`...Z`), or null when there is no date.
- Consumes: nothing from Tasks 1-2 at compile time; depends on them only in that the server must already tolerate both forms before the client switches.

**Root cause:** `update()` sends `dueDate: commitment.scheduledDate?.toIso8601String()`. For a local Dart `DateTime` that string carries no offset, which is what made server-side interpretation ambiguous in the first place. It also never sends the time at all — only `patchFields()` sends `reminderTime`, and `patchFields` is not on the `CommitmentRepository` interface, so no screen can reach it.

- [ ] **Step 1: Write the failing test**

Create `mobile/test/unit/backend_time_mapper_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/services/api/mappers/backend_time_mapper.dart';

void main() {
  group('BackendTimeMapper.instantFrom', () {
    test('combines a local date with a wall clock into an explicit UTC instant', () {
      final date = DateTime(2026, 8, 23);
      final instant = BackendTimeMapper.instantFrom(date, '3:45 PM');

      expect(instant, isNotNull);
      expect(instant, endsWith('Z'));
      final parsed = DateTime.parse(instant!);
      expect(parsed.isUtc, isTrue);
      expect(parsed.toLocal().hour, 15);
      expect(parsed.toLocal().minute, 45);
      expect(parsed.toLocal().day, 23);
    });

    test('falls back to the date itself when there is no clock time', () {
      final instant = BackendTimeMapper.instantFrom(DateTime(2026, 8, 23), null);
      expect(instant, isNotNull);
      expect(instant, endsWith('Z'));
    });

    test('returns null when there is no date at all', () {
      expect(BackendTimeMapper.instantFrom(null, '3:45 PM'), isNull);
    });

    test('an unparseable clock string falls back to the date rather than throwing', () {
      final instant = BackendTimeMapper.instantFrom(DateTime(2026, 8, 23), 'not a time');
      expect(instant, isNotNull);
      expect(instant, endsWith('Z'));
    });
  });
}
```

- [ ] **Step 2: Run the test and watch it fail**

Run (from `mobile/`): `flutter test test/unit/backend_time_mapper_test.dart`
Expected: compile failure — `instantFrom` does not exist.

- [ ] **Step 3: Implement `instantFrom`**

Add to `mobile/lib/services/api/mappers/backend_time_mapper.dart`:

```dart
  /// A local date plus a wall-clock string as one explicit UTC instant.
  ///
  /// The wire format is deliberately unambiguous: `DateTime.toIso8601String()`
  /// on a local value carries no offset, which leaves the server guessing.
  static String? instantFrom(DateTime? date, String? clockTime) {
    if (date == null) return null;

    var local = DateTime(date.year, date.month, date.day);
    if (clockTime != null && clockTime.trim().isNotEmpty) {
      try {
        final parsed = DateFormat('h:mm a').parseLoose(clockTime.trim());
        local = DateTime(date.year, date.month, date.day, parsed.hour, parsed.minute);
      } catch (_) {
        // A malformed clock string costs the time-of-day, not the whole edit.
      }
    }
    return local.toUtc().toIso8601String();
  }
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `flutter test test/unit/backend_time_mapper_test.dart`
Expected: 4 passing.

- [ ] **Step 5: Send both fields from `update()`**

In `mobile/lib/services/api/api_commitment_repository.dart`, replace the `PatchCommitmentRequestDto` construction inside `update()` so it carries the time. Leave the `supportsSafeCommitmentPatch` guard above it untouched.

```dart
    final instant = BackendTimeMapper.instantFrom(
      commitment.scheduledDate,
      commitment.startTime,
    );

    final req = PatchCommitmentRequestDto(
      title: commitment.title,
      description: commitment.description,
      priority: CommitmentMapper.mapPriorityToBackendLevel(commitment.priority),
      dueDate: instant,
      reminderTime: instant,
    );
```

`PatchCommitmentRequestDto` already carries `reminderTime` (`mobile/lib/services/api/dtos/commitment_dtos.dart:254`) and `toJson` already emits it when non-null, so no DTO change is needed — `update()` simply never populated it.

- [ ] **Step 6: Run the mobile suite**

Run: `flutter test`
Expected: 398 pass / 1 skip / 0 fail (394 + 4 new). Any test asserting the old offset-less `dueDate` string shape needs its expectation updated to the `...Z` form — update the expectation, never weaken the assertion.

- [ ] **Step 7: Commit**

```bash
git add mobile/lib/services/api/mappers/backend_time_mapper.dart mobile/lib/services/api/api_commitment_repository.dart mobile/test/unit/backend_time_mapper_test.dart
git commit -m "fix: send explicit UTC instants, including the time, when patching a commitment"
```

---

## Task 4: Make `update()` durable in the mock repository

**Files:**
- Modify: `mobile/lib/services/mock/in_memory_commitment_repository.dart` (`update`, `_persist`, `_seedInitialData`)
- Test: `mobile/test/unit/in_memory_repository_test.dart` (extend)

**Interfaces:**
- Consumes: the existing `CommitmentStateChange` shape from `mobile/lib/services/mock/commitment_state_store.dart` — `{ status, scheduledDate, completedAt, fullCommitment }`. No new fields are needed; edited seeds reuse `fullCommitment`.
- Produces: no signature change. `update()` becomes durable.

**Root cause:** two independent gaps. `update()` mutates `_commitments` and notifies, but never calls `_persist()`. And even if it did, `_persist()` skips any commitment whose id is in `_seedIds` while its status is `pending` with no `completedAt` — which is exactly the state of a seeded commitment whose *title* was edited. The skip test asks about status when the question is whether anything changed at all.

- [ ] **Step 1: Write the failing test**

Add to the existing `group('InMemoryCommitmentRepository Tests', ...)` in `mobile/test/unit/in_memory_repository_test.dart`:

```dart
    test('an edited title on a seeded commitment survives a relaunch', () async {
      final store = InMemoryStateStore();
      final first = InMemoryCommitmentRepository(stateStore: store);
      await first.ready;

      final target = (await first.getToday()).first;
      await first.update(target.copyWith(title: 'Renamed by the user'));

      final relaunched = InMemoryCommitmentRepository(stateStore: store);
      await relaunched.ready;
      final restored = await relaunched.getById(target.id);

      expect(restored?.title, 'Renamed by the user');
    });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `flutter test test/unit/in_memory_repository_test.dart`
Expected: failure — `restored?.title` is the original seed title, because the edit was never written.

- [ ] **Step 3: Keep a snapshot of the seeded values**

In `in_memory_commitment_repository.dart`, alongside the existing `_seedIds`, add a snapshot map and populate it where `_seedIds` is populated at the end of `_seedInitialData()`:

```dart
  final Map<String, String> _seedFingerprints = {};
```

```dart
    _seedIds.addAll(_commitments.map((c) => c.id));
    for (final c in _commitments) {
      _seedFingerprints[c.id] = _fingerprint(c);
    }
```

Add the fingerprint helper. It compares what a person can actually change on this screen, so an edit to any of those fields is detected without giving `Commitment` a full `==`:

```dart
  static String _fingerprint(Commitment c) => [
        c.title,
        c.description ?? '',
        c.scheduledDate?.toIso8601String() ?? '',
        c.startTime ?? '',
        c.endTime ?? '',
        c.status.name,
        c.completedAt?.toIso8601String() ?? '',
      ].join('|');
```

- [ ] **Step 4: Ask the right question in `_persist()`**

Replace the `isUnmodifiedSeed` computation inside `_persist()`'s loop:

```dart
      final seedFingerprint = _seedFingerprints[commitment.id];
      final isUnmodifiedSeed =
          seedFingerprint != null && seedFingerprint == _fingerprint(commitment);
      if (isUnmodifiedSeed) {
        continue;
      }
      final isNew = !_seedIds.contains(commitment.id);
```

and widen the stored row so an edited seed carries its whole self, exactly as a new commitment already does:

```dart
      changes[commitment.id] = CommitmentStateChange(
        status: commitment.status,
        scheduledDate: commitment.scheduledDate,
        completedAt: commitment.completedAt,
        fullCommitment: isNew || seedFingerprint != null ? commitment : null,
      );
```

- [ ] **Step 5: Restore edited seeds over their seeded values**

`_restore()` currently applies only `status`/`scheduledDate`/`completedAt` to commitments it finds by id, and appends `fullCommitment` rows only when the id is absent. An edited seed is present by id, so its `fullCommitment` is ignored. Replace the first loop's body so a stored `fullCommitment` wins outright:

```dart
    for (var i = 0; i < _commitments.length; i++) {
      final change = changes[_commitments[i].id];
      if (change == null) continue;
      final saved = change.fullCommitment;
      _commitments[i] = saved ??
          _commitments[i].copyWith(
            status: change.status,
            scheduledDate: change.scheduledDate,
            completedAt: change.completedAt,
          );
      restored = true;
    }
```

- [ ] **Step 6: Call `_persist()` from `update()`**

```dart
  @override
  Future<void> update(Commitment commitment) async {
    final idx = _commitments.indexWhere((c) => c.id == commitment.id);
    if (idx >= 0) {
      _commitments[idx] = commitment;
      _notify();
      await _persist();
    }
  }
```

- [ ] **Step 7: Run the test and watch it pass**

Run: `flutter test test/unit/in_memory_repository_test.dart`
Expected: all passing, including the new case and the existing new-commitment and JSON round-trip cases.

- [ ] **Step 8: Run the mobile suite**

Run: `flutter test`
Expected: 399 pass / 1 skip / 0 fail.

- [ ] **Step 9: Commit**

```bash
git add mobile/lib/services/mock/in_memory_commitment_repository.dart mobile/test/unit/in_memory_repository_test.dart
git commit -m "fix: persist edits made through update(), including edited seed commitments"
```

---

## Task 5: Move `editTime()` onto the update path

**Files:**
- Modify: `mobile/lib/features/commitment_details/commitment_details_screen.dart` (`editTime`)
- Modify: `mobile/lib/l10n/app_en.arb`, `app_ar.arb`, `app_he.arb` (remove the postpone-disclosure string) and regenerate
- Test: `mobile/test/widget/commitment_details_screen_test.dart` (extend)

**Interfaces:**
- Consumes: durable `update()` (Task 4), instant-sending `update()` (Task 3), zone-correct patching (Tasks 1-2).
- Produces: `editTime()` no longer calls `postpone()`, so a time edit leaves `status` alone.

**Root cause:** `editTime()` calls `postpone()` because `update()` was broken. `postpone()` sets `status: CommitmentStatus.postponed` (`in_memory_commitment_repository.dart:307`) and writes a `commitmentPostponed` activity entry, so correcting a mistyped time relabels the commitment and pollutes the activity feed. `UpdateCommitment` (`src/domain/stateMachine.ts:594`) has always supported a `timeSpec` change without touching status — the domain was never the obstacle.

- [ ] **Step 1: Write the failing test**

Add to `mobile/test/widget/commitment_details_screen_test.dart`, inside the existing group:

```dart
    testWidgets(
      'editing the time leaves the commitment status alone',
      (WidgetTester tester) async {
        SharedPreferences.setMockInitialValues({});
        final container = _buildMockModeContainer();
        addTearDown(container.dispose);

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: _buildLocalizedApp(
              const CommitmentDetailsScreen(id: 'c-today-1'),
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byIcon(Icons.schedule));
        await tester.pumpAndSettle();

        final dateEntryModeButton = find.descendant(
          of: find.byType(DatePickerDialog),
          matching: find.byIcon(Icons.edit_outlined),
        );
        await tester.tap(dateEntryModeButton);
        await tester.pumpAndSettle();
        final tomorrow = DateTime.now().add(const Duration(days: 1));
        await tester.enterText(
          find.byType(TextField),
          '${tomorrow.month.toString().padLeft(2, '0')}/'
          '${tomorrow.day.toString().padLeft(2, '0')}/'
          '${tomorrow.year}',
        );
        await tester.tap(find.text('OK'));
        await tester.pumpAndSettle();

        await tester.tap(find.byIcon(Icons.keyboard_outlined));
        await tester.pumpAndSettle();
        final timeFields = find.byType(TextField);
        await tester.enterText(timeFields.first, '03');
        await tester.enterText(timeFields.last, '45');
        final pm = find.text('PM');
        if (tester.any(pm)) {
          await tester.tap(pm);
          await tester.pumpAndSettle();
        }
        await tester.tap(find.text('OK'));
        await tester.pumpAndSettle();

        final stored = await container
            .read(commitmentRepositoryProvider)
            .getById('c-today-1');
        expect(stored?.status, CommitmentStatus.pending,
            reason: 'Correcting a time is not postponing.');
        expect(find.textContaining('Postponed'), findsNothing);
      },
    );
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `flutter test test/widget/commitment_details_screen_test.dart`
Expected: `stored?.status` is `CommitmentStatus.postponed`.

- [ ] **Step 3: Rewrite `editTime()`'s save path**

Replace the body after the past-time guard — the `postpone()` call, the follow-up `update()` that existed only to refresh the display string, the `supportsSafeCommitmentPatch` wrapper around it, and the disclosure snackbar — with one guarded update:

```dart
      if (!config.supportsSafeCommitmentPatch) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(l10n.editingDisabledExplanation)),
        );
        return;
      }

      await ref.read(commitmentRepositoryProvider).update(
            commitment.copyWith(
              scheduledDate: combined,
              startTime: DateFormat('hh:mm a').format(combined),
            ),
          );
```

Keep the past-time guard exactly as it is: `UpdateCommitment` carries no "must be in the future" rule, so that guard is now the only thing standing between a user and a commitment scheduled in the past.

- [ ] **Step 4: Remove the now-false disclosure string**

Delete `timeUpdatedAlsoPostponedNotice` from `app_en.arb`, `app_ar.arb`, and `app_he.arb`, then regenerate:

Run: `flutter gen-l10n`

- [ ] **Step 5: Run the test and watch it pass**

Run: `flutter test test/widget/commitment_details_screen_test.dart`
Expected: 3 passing — the original edit case, the past-time rejection, and the new status case.

- [ ] **Step 6: Run the mobile suite**

Run: `flutter test`
Expected: 400 pass / 1 skip / 0 fail.

- [ ] **Step 7: Commit**

```bash
git add mobile/lib/features/commitment_details/commitment_details_screen.dart mobile/lib/l10n mobile/test/widget/commitment_details_screen_test.dart
git commit -m "fix: edit a commitment's time through update() so it is no longer marked postponed"
```

---

## Task 6: Keep the end time coherent when the start time moves

**Files:**
- Modify: `mobile/lib/models/commitment.dart` (`copyWith`)
- Modify: `mobile/lib/features/commitment_details/commitment_details_screen.dart` (`editTime`)
- Test: `mobile/test/unit/commitment_model_test.dart` (exists; add a second `group()` inside its existing `main()`)

**Interfaces:**
- Produces: `Commitment.copyWith({..., bool clearEndTime = false})`, matching the `clearScheduledDate` flag the model already carries.
- Consumes: `editTime()` from Task 5.

**Root cause:** `copyWith` resolves `endTime` as `endTime ?? this.endTime`, so an edit that changes only the start time leaves the old end time in place. The committed test for Task 5's predecessor asserts the resulting display literally: `3:45 PM — 11:15 AM`, an end before its start.

- [ ] **Step 1: Write the failing test**

Add this as a second group inside the file's existing `void main()`, below `group('Commitment Model Tests', ...)`. The imports it needs are already at the top of that file.

```dart
  group('Commitment.copyWith end time', () {
    final base = Commitment(
      id: 'c-1',
      title: 'Briefing',
      scheduledDate: DateTime(2026, 8, 23, 10, 30),
      startTime: '10:30 AM',
      endTime: '11:15 AM',
      priority: CommitmentPriority.must,
      status: CommitmentStatus.pending,
      category: 'Home',
    );

    test('clearEndTime removes an end time that copyWith cannot otherwise drop', () {
      final cleared = base.copyWith(clearEndTime: true);
      expect(cleared.endTime, isNull);
    });

    test('an unrelated copyWith still preserves the end time', () {
      expect(base.copyWith(title: 'Renamed').endTime, '11:15 AM');
    });
  });
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `flutter test test/unit/commitment_model_test.dart`
Expected: compile failure — `clearEndTime` is not a parameter.

- [ ] **Step 3: Add the flag**

In `mobile/lib/models/commitment.dart`, add `bool clearEndTime = false` to `copyWith`'s parameters, following the existing `clearScheduledDate` convention, and resolve the field as:

```dart
      endTime: clearEndTime ? null : (endTime ?? this.endTime),
```

- [ ] **Step 4: Shift the end time with the start time**

In `editTime()`, carry the commitment's duration across the edit rather than stranding the old end time. Insert before the `update()` call from Task 5, and pass the result through:

```dart
      String? nextEndTime = commitment.endTime;
      final previousStart = commitment.scheduledDate;
      if (nextEndTime != null && previousStart != null) {
        try {
          final oldEnd = DateFormat('h:mm a').parseLoose(nextEndTime);
          final oldEndAt = DateTime(previousStart.year, previousStart.month,
              previousStart.day, oldEnd.hour, oldEnd.minute);
          final duration = oldEndAt.difference(previousStart);
          nextEndTime = duration.isNegative
              ? null
              : DateFormat('hh:mm a').format(combined.add(duration));
        } catch (_) {
          nextEndTime = null;
        }
      }
```

then in the `update()` call use `endTime: nextEndTime` together with `clearEndTime: nextEndTime == null`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `flutter test test/unit/commitment_model_test.dart test/widget/commitment_details_screen_test.dart`

Expected: all passing. The Task 5 widget test's display assertion may now read a shifted end time rather than the stale `11:15 AM` — update that expectation to the shifted value, which is the point of this task.

- [ ] **Step 6: Run both suites**

Run: `flutter test` then, from the repo root, `npm test`
Expected: 402 pass / 1 skip / 0 fail on mobile; 3258 pass / 0 fail on backend.

- [ ] **Step 7: Run the analyzer**

Run: `flutter analyze`
Expected: only the 5 pre-existing warnings in `test/unit/in_memory_repository_test.dart`.

- [ ] **Step 8: Commit**

```bash
git add mobile/lib/models/commitment.dart mobile/lib/features/commitment_details/commitment_details_screen.dart mobile/test/unit/commitment_model_test.dart mobile/test/widget/commitment_details_screen_test.dart
git commit -m "fix: carry a commitment's duration when its start time is edited"
```

---

## Manual verification after all six tasks

- [ ] Start the backend: `npm run dev`.
- [ ] Build and launch the app with no dart-defines. Confirm it opens to Today.
- [ ] Open a commitment, edit its title, force-quit, relaunch — the new title is still there.
- [ ] Edit its time to a future time, confirm the displayed time changes, the status does **not** read "Postponed", and no "Postponed" entry appears in Activity.
- [ ] Force-quit and relaunch — the edited time is still there.
- [ ] Restart the backend with `TZ=UTC npm run dev`, repeat the time edit, and confirm the time the app displays afterwards matches what was picked. This is the configuration the whole chain exists for; before Task 1 it drifted by the zone offset.

## Not in this plan

Tracked in the spec, each needing its own plan: the alpha-trace security merge, the capture safety valve for unaccounted time expressions, a test that exercises the default configuration, and the pilot build-flag guard.
