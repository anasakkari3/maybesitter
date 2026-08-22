# Audit P0/P1 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two release-blocking P0 defects (new commitments lost on relaunch; default capture path ignores real time/date input) and three P1 defects (stale "Enabled" notification-permission display, fabricated calendar connection, no time-editing UI) found by the 2026-08-22 simulator audit and independently reproduced live against this branch.

**Architecture:** Phase 1 is a small, surgical persistence-layer fix in `InMemoryCommitmentRepository` plus a companion test-data fix, fully local and TDD-able with no backend dependency. Phase 2 switches the mobile app's *default* capture path from `MockCaptureService` (a keyword-matching fixture) to the already-built, already-tested server-side extraction pipeline (`ruleBasedExtractor` behind `/api/mobile/capture`) by making `ApiCaptureService` the default instead of gating it behind `isLocalBackend`/`API_BASE_URL`. Phase 3 fixes three independent P1 UI/state-sync bugs, each isolated to one screen or one provider wiring decision.

**Tech Stack:** Flutter/Dart (mobile), Riverpod (state/DI), `flutter_test` (unit/widget tests), Next.js API routes + TypeScript (backend), `SharedPreferences` (on-device persistence).

**Spec:** This plan is derived directly from live reproduction and code tracing, not a separate spec document. Evidence trail: `MAYBESITTER_SIMULATOR_PRODUCT_TRUTH_AUDIT_2026-08-22.md` (external audit) cross-checked against this session's own simulator repro (screenshots + on-disk `SharedPreferences` plist inspection) and source reads on branch `core-value/native-reminders` @ commit `375800e`.

## Global Constraints

- Work happens on branch `core-value/native-reminders` in worktree `/Users/anasakkari/Desktop/1-Projects/MaybeSitter/worktrees-core-value/native-reminders`. Do not touch `mobile/` files outside this worktree.
- Every task's fix must ship with a **failing-first** test reproducing the exact bug, per `superpowers:test-driven-development`.
- Do not run `flutter test` with a glob — run explicit file paths, matching this repo's existing convention (see `test/unit/audit_regressions_test.dart` for a file that must stay green after Task 1).
- Test file convention (confirmed from `test/unit/in_memory_repository_test.dart`): package-absolute imports (`package:maybesitter_mobile/...`, never relative `../`), one `group()` per class under test, `late` instance + `setUp()`, sentence-style `test()` names, black-box calls against public API only.
- **Security constraint (blocks Phase 2 going any further than local dev/testing):** this branch does NOT include the alpha-trace session-hijack fix (upstream fix commit `463fc1c`, described in project memory as fixing "a critical pre-existing alpha-trace session hijack (G1/G2) that lets one pilot participant read another's raw medical text"). The `/api/mobile/capture` route this plan wires the mobile app to writes raw captured text into that same trace store (`src/app/api/mobile/capture/route.ts:27`, `recordTraceStage(... stage('input_received', { inputText: ... }))`). Phase 2 is safe for local development and manual verification only. **Do not point a real pilot or shared build at a live `/api/mobile/capture` backend until the G1/G2 fix is merged onto this branch** — flag this to the user again before any such deployment.

---

## Phase 1 — P0: Newly created commitments survive relaunch

### Task 1: Fix `saveAll()` to persist new commitments, and fix the stale-seed skip filter

**Files:**
- Modify: `mobile/lib/services/mock/in_memory_commitment_repository.dart:68-93` (`_persist()`), `:242-253` (`saveAll()`)
- Test: `mobile/test/unit/in_memory_repository_test.dart`

**Interfaces:**
- Consumes: existing `InMemoryCommitmentRepository(stateStore: CommitmentStateStore?)` constructor, existing `CommitmentStateStore.save(Map<String, CommitmentStateChange>)` / `.load()` contract from `mobile/lib/services/mock/commitment_state_store.dart` (unchanged).
- Produces: `saveAll()` now durably persists every commitment it adds, not just status/date changes to pre-existing seed items. No public signature changes — `saveAll(List<Commitment>)` keeps its existing type.

**Root cause (verified via live simulator repro + on-disk `SharedPreferences` plist inspection, not just static reading):** `saveAll()` (line 242) mutates `_commitments` and calls `_notify()` but never calls `_persist()`. Separately, `_persist()`'s skip condition (line 75: `if (commitment.status == CommitmentStatus.pending && commitment.completedAt == null) continue;`) treats "pending, uncompleted" as "unmodified seed data" — which is indistinguishable from a brand-new commitment nobody has acted on yet. Both bugs must be fixed together: fixing only `saveAll()` would still have new pending commitments filtered out by the skip condition.

- [ ] **Step 1: Write the failing test proving new commitments are lost on relaunch**

Add this test to the existing `group('InMemoryCommitmentRepository Tests', ...)` block in `mobile/test/unit/in_memory_repository_test.dart` (add the `commitment_state_store.dart` import at the top alongside the existing two imports):

```dart
import 'package:maybesitter_mobile/services/mock/commitment_state_store.dart';
```

```dart
    test('a newly confirmed commitment survives a relaunch', () async {
      final store = InMemoryStateStore();
      final first = InMemoryCommitmentRepository(stateStore: store);
      await first.ready;

      final newCommitment = Commitment(
        id: 'new-1',
        title: 'Remind me to call Ahmad tomorrow at 3 PM',
        description: 'Captured via text input',
        scheduledDate: DateTime.now().add(const Duration(days: 1)),
        startTime: '10:00 AM',
        priority: CommitmentPriority.should,
        status: CommitmentStatus.pending,
        category: 'Personal',
      );
      await first.saveAll([newCommitment]);

      final relaunched = InMemoryCommitmentRepository(stateStore: store);
      await relaunched.ready;
      final restored = await relaunched.getById('new-1');

      expect(restored, isNotNull);
      expect(restored!.title, 'Remind me to call Ahmad tomorrow at 3 PM');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/unit/in_memory_repository_test.dart` (from `mobile/`)
Expected: FAIL — `restored` is `null` because `getById('new-1')` finds nothing in the freshly-constructed `relaunched` repository (it only re-seeds the fixed demo data; `new-1` was never written to the store).

- [ ] **Step 3: Fix `_persist()`'s skip condition to cover new (non-seed) commitments**

In `mobile/lib/services/mock/in_memory_commitment_repository.dart`, the seed IDs are known at construction time. Add a field tracking them and use it to change what "unmodified" means — from "status is pending" to "this ID was present in the original seed set." Modify the class as follows:

```dart
  final List<Commitment> _commitments = [];
  final Set<String> _seedIds = {};
```

In `_seedInitialData()` (wherever it currently populates `_commitments.addAll([...])` around line 115), after that call add:

```dart
    _seedIds.addAll(_commitments.map((c) => c.id));
```

Then replace the `_persist()` skip condition (lines 74-78):

```dart
      // Only what a person changed. A pending commitment with no completion is
      // the seed as shipped and needs no row.
      if (commitment.status == CommitmentStatus.pending &&
          commitment.completedAt == null) {
        continue;
      }
```

with:

```dart
      // Seed data as shipped needs no row unless the user changed it. Any
      // commitment not in the original seed set is new — created by the
      // user via capture — and must be written regardless of its status,
      // since "pending" is indistinguishable from "seed" by status alone.
      final isUnmodifiedSeed = _seedIds.contains(commitment.id) &&
          commitment.status == CommitmentStatus.pending &&
          commitment.completedAt == null;
      if (isUnmodifiedSeed) {
        continue;
      }
```

This means the persisted `CommitmentStateChange` must carry the full commitment, not just status/date/completedAt, for new (non-seed) items. Check `CommitmentStateChange` in `mobile/lib/services/mock/commitment_state_store.dart` — if it only has `status`/`scheduledDate`/`completedAt` fields, extend it to optionally carry the full commitment for new items:

Read the current `CommitmentStateChange` class definition first (`mobile/lib/services/mock/commitment_state_store.dart`) to see its exact fields before extending it — add a nullable `Commitment? fullCommitment` field (serialized as an optional nested JSON object) used only when the entry represents a new (non-seed) commitment, alongside its existing `toJson`/`fromJson`.

Update the `_persist()` change-building loop to populate `fullCommitment` for non-seed entries:

```dart
    final changes = <String, CommitmentStateChange>{};
    for (final commitment in _commitments) {
      final isUnmodifiedSeed = _seedIds.contains(commitment.id) &&
          commitment.status == CommitmentStatus.pending &&
          commitment.completedAt == null;
      if (isUnmodifiedSeed) {
        continue;
      }
      final isNew = !_seedIds.contains(commitment.id);
      changes[commitment.id] = CommitmentStateChange(
        status: commitment.status,
        scheduledDate: commitment.scheduledDate,
        completedAt: commitment.completedAt,
        fullCommitment: isNew ? commitment : null,
      );
    }
```

- [ ] **Step 4: Make `saveAll()` call `_persist()`**

Replace `saveAll()` (lines 243-253):

```dart
  @override
  Future<void> saveAll(List<Commitment> commitments) async {
    for (final c in commitments) {
      final idx = _commitments.indexWhere((existing) => existing.id == c.id);
      if (idx >= 0) {
        _commitments[idx] = c;
      } else {
        _commitments.add(c);
      }
    }
    _notify();
  }
```

with:

```dart
  @override
  Future<void> saveAll(List<Commitment> commitments) async {
    for (final c in commitments) {
      final idx = _commitments.indexWhere((existing) => existing.id == c.id);
      if (idx >= 0) {
        _commitments[idx] = c;
      } else {
        _commitments.add(c);
      }
    }
    _notify();
    await _persist();
  }
```

- [ ] **Step 5: Update `_restore()` to lay a full new commitment over the seed list, not just field-level changes**

`_restore()` currently only walks `_commitments` (the seed list) and applies `change.status`/`scheduledDate`/`completedAt` onto existing entries by index (lines 54-64). It needs a second pass that adds back any persisted change carrying a `fullCommitment` whose ID isn't already in `_commitments`:

```dart
  Future<void> _restore() async {
    final store = stateStore;
    if (store == null) return;

    Map<String, CommitmentStateChange> changes;
    try {
      changes = await store.load();
    } catch (_) {
      return;
    }
    if (changes.isEmpty) return;

    var restored = false;
    for (var i = 0; i < _commitments.length; i++) {
      final change = changes[_commitments[i].id];
      if (change == null) continue;
      _commitments[i] = _commitments[i].copyWith(
        status: change.status,
        scheduledDate: change.scheduledDate,
        completedAt: change.completedAt,
      );
      restored = true;
    }

    final existingIds = _commitments.map((c) => c.id).toSet();
    for (final change in changes.values) {
      final saved = change.fullCommitment;
      if (saved != null && !existingIds.contains(saved.id)) {
        _commitments.add(saved);
        restored = true;
      }
    }

    if (restored) _notify();
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `flutter test test/unit/in_memory_repository_test.dart`
Expected: PASS, all tests including the new one.

- [ ] **Step 7: Run the full existing regression suite to confirm no breakage**

Run: `flutter test test/unit/audit_regressions_test.dart`
Expected: the two "what the user did survives a relaunch" tests for *completed*/*postponed* still pass (they exercise the pre-existing seed-mutation path, untouched by this change's seed-ID skip logic since those commitments ARE in `_seedIds`).

- [ ] **Step 8: Commit**

```bash
git add mobile/lib/services/mock/in_memory_commitment_repository.dart mobile/lib/services/mock/commitment_state_store.dart mobile/test/unit/in_memory_repository_test.dart
git commit -m "fix: persist newly created commitments so they survive relaunch"
```

### Task 2: Fix the pre-existing failing test (`audit_regressions_test.dart`) — test bug, not product bug

**Files:**
- Modify: `mobile/test/unit/audit_regressions_test.dart:136-153`

**Interfaces:**
- Consumes: `InMemoryCommitmentRepository.getToday()`/`getUpcoming()` (unchanged by Task 1).
- Produces: nothing new — this only fixes stale hardcoded dates in an existing test.

**Root cause (verified by running the test and reading `getToday()`/`getUpcoming()` at `in_memory_commitment_repository.dart:204-231`):** the test postpones a commitment to the fixed date `DateTime(2026, 8, 21, 9, 0)`. Both `getToday()` and `getUpcoming()` filter relative to the *real* `DateTime.now()` at test-run time. Since the system date is on or after 2026-08-22, `2026-08-21` is in the past — the postponed commitment lands in neither list, so `.firstWhere(...)` throws `Bad state: No element`. This is a test-authoring bug (a hardcoded "future" date that becomes past), unrelated to Task 1's persistence fix.

- [ ] **Step 1: Confirm current failure**

Run: `flutter test test/unit/audit_regressions_test.dart`
Expected: FAIL on `a postponed date survives a relaunch` with `Bad state: No element` at line 151.

- [ ] **Step 2: Replace the hardcoded date with one computed relative to `DateTime.now()`**

In `mobile/test/unit/audit_regressions_test.dart`, inside `test('a postponed date survives a relaunch', ...)`, replace:

```dart
      final newDate = DateTime(2026, 8, 21, 9, 0);
```

with:

```dart
      final now = DateTime.now();
      final newDate = DateTime(now.year, now.month, now.day + 3, 9, 0);
```

- [ ] **Step 3: Run test to verify it passes**

Run: `flutter test test/unit/audit_regressions_test.dart`
Expected: PASS, all tests in the file.

- [ ] **Step 4: Commit**

```bash
git add mobile/test/unit/audit_regressions_test.dart
git commit -m "fix: use a relative future date in the postpone-survives-relaunch test"
```

---

## Phase 2 — P0: Default capture path uses real extraction instead of a hardcoded mock

**Design decision (confirmed with user):** wire the mobile app's default build to the existing, already-tested server-side extractor (`ruleBasedExtractor` via `proposeMobileCapture` behind `/api/mobile/capture`), rather than building new on-device parsing. This is a smaller, lower-risk change since the extraction logic and the mobile-side HTTP client (`ApiCaptureService`) both already exist and are tested — the only gap is which one the default build picks.

**Constraint reminder:** per Global Constraints, this phase is for local/manual verification only until the alpha-trace G1/G2 fix (commit `463fc1c` on a separate branch) is merged onto this branch — do not point a shared or pilot build at a hosted instance of this backend yet.

### Task 3: Start the backend locally and confirm `/api/mobile/capture` produces real extraction

**Files:** none modified — this is a verification-only task gating Task 4.

- [ ] **Step 1: Start the Next.js backend in dev mode**

Run (from the repo root, `/Users/anasakkari/Desktop/1-Projects/MaybeSitter/worktrees-core-value/native-reminders`): `npm run dev`
Expected: server listening on `http://localhost:3000` (Next.js default), no startup errors.

- [ ] **Step 2: Manually POST a real-time-bearing sentence and confirm the extractor honors the time**

Run:
```bash
curl -s -X POST http://localhost:3000/api/mobile/capture \
  -H "Content-Type: application/json" \
  -d '{"text":"Remind me to call Ahmad tomorrow at 3 PM","referenceTime":"2026-08-22T09:00:00.000Z","timezone":"Asia/Jerusalem","scopeId":"default"}'
```
Expected: JSON response with a proposed item whose time reflects `15:00`/`3 PM`, not a hardcoded `10:00`. If it does NOT honor the time, STOP — this means `ruleBasedExtractor` itself has the same defect as the mock for this input shape, and Task 4 must not proceed until that's understood (return to Phase 1 of `systematic-debugging` on the extractor itself before continuing).

- [ ] **Step 3: No commit — this is a verification checkpoint.** Record the actual JSON response in your task notes for Task 4's manual verification step to compare against.

### Task 4: Make `ApiCaptureService` (real extraction) the default instead of `MockCaptureService`

**Files:**
- Modify: `mobile/lib/services/providers.dart` (the `captureServiceProvider` definition, and `AppConfig`'s default `apiMode` in `mobile/lib/config/app_config.dart:53`)
- Test: `mobile/test/unit/providers_test.dart` if it exists (check first via `find mobile/test -iname "*provider*"`; if none exists for capture service selection, add assertions inline in a new small test file `mobile/test/unit/capture_service_selection_test.dart`)

**Interfaces:**
- Consumes: existing `CaptureService` interface (`mobile/lib/services/contracts/capture_service.dart`), existing `ApiCaptureService` and `MockCaptureService` classes (unchanged).
- Produces: `captureServiceProvider` now returns `ApiCaptureService` when a backend is reachable per `AppConfig`, and still falls back to `MockCaptureService` only as an explicit, clearly-labeled fallback (not the silent default).

**Important:** do not simply flip the default so `ApiCaptureService` is used with no reachable backend — that would trade "wrong answers" for "the app hangs/errors on every capture" when no `API_BASE_URL` is configured (e.g., CI, a fresh checkout with no backend running). The fix is to make local-backend mode the default expectation for capture specifically, while being explicit in-product when it's unavailable, per the existing `ERR-001`-style "Cannot reach MaybeSitter" screen the audit confirmed already works well.

- [ ] **Step 1: Read `AppConfig` fully before changing it**

Read `mobile/lib/config/app_config.dart` in full (already partially known: `apiMode` defaults to `ApiMode.mock` at line 53; `isLocalBackend` getter at line 156; `_configuredBaseUrl = String.fromEnvironment('API_BASE_URL')` at line 32). Confirm there is no other consumer besides `captureServiceProvider` that would break by changing the default `apiMode`.

- [ ] **Step 2: Write the failing test asserting `captureServiceProvider` prefers `ApiCaptureService` by default**

Create `mobile/test/unit/capture_service_selection_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:maybesitter_mobile/services/api/api_capture_service.dart';
import 'package:maybesitter_mobile/config/app_config.dart';

void main() {
  group('AppConfig default capture mode', () {
    test('default apiMode is localBackend, not mock', () {
      const config = AppConfig();
      expect(config.apiMode, ApiMode.localBackend);
    });
  });
}
```

(Match this to `AppConfig`'s actual constructor signature once read in Step 1 — if it isn't a simple const constructor, adjust instantiation accordingly, keeping the assertion the same.)

- [ ] **Step 3: Run test to verify it fails**

Run: `flutter test test/unit/capture_service_selection_test.dart`
Expected: FAIL — current default is `ApiMode.mock`.

- [ ] **Step 4: Change the default in `AppConfig`**

In `mobile/lib/config/app_config.dart`, change the default `apiMode` (currently `ApiMode.mock` per line 53) to `ApiMode.localBackend` when no explicit override says otherwise. Preserve the existing `API_BASE_URL`-driven override behavior — if `_configuredBaseUrl` is empty, fall back to a sensible default local URL (`http://localhost:3000`) rather than forcing every developer to set the env var. Read the surrounding logic at `app_config.dart:104` (`fromEnvironment`) before editing, since it currently treats an empty `API_BASE_URL` as the *signal* to select mock mode — that branch must become "use localBackend against the default localhost URL" instead.

- [ ] **Step 5: Run test to verify it passes**

Run: `flutter test test/unit/capture_service_selection_test.dart`
Expected: PASS.

- [ ] **Step 6: Run the full existing mobile test suite to catch any other test relying on mock-by-default**

Run: `flutter test` (full suite; this project's CLAUDE.md/memory notes an explicit file list is used elsewhere for `npm test` — check `mobile/` for an equivalent convention before assuming a bare glob is safe here; if none is documented, a full-directory `flutter test` is this project's existing norm per the audit's own baseline run)
Expected: no new failures introduced. Any test that implicitly depended on `MockCaptureService`'s keyword-fixture behavior (e.g. a widget test typing "doctor" and "work" and expecting the two-item mock split) will need updating — this is expected and should be fixed by either injecting `MockCaptureService` explicitly in that test's provider overrides (Riverpod `ProviderScope(overrides: [...])`) rather than relying on the app-wide default.

- [ ] **Step 7: Manually verify in the simulator**

Using the same flow as this session's audit repro (Maestro or manual): with the backend from Task 3 running locally, capture "Remind me to call Ahmad tomorrow at 3 PM" and confirm the proposed time now reflects 3 PM, not 10:00 AM.

- [ ] **Step 8: Commit**

```bash
git add mobile/lib/config/app_config.dart mobile/lib/services/providers.dart mobile/test/unit/capture_service_selection_test.dart
git commit -m "fix: default mobile capture to real extraction backend instead of hardcoded mock"
```

---

## Phase 3 — P1 fixes (independent of each other; order doesn't matter)

### Task 5: Notification settings screen re-checks live OS permission instead of showing stale cached state

**Files:**
- Modify: `mobile/lib/features/settings/settings_screen.dart:93-97`, `mobile/lib/services/providers.dart` (near `AppSettingsNotifier`, line ~412-473)
- Test: `mobile/test/unit/native_notification_service_test.dart` (extend using its existing `_FakeGateway` pattern) or a new `mobile/test/widget/settings_screen_test.dart` if permission display is better tested at the widget level — check which convention `settings_screen.dart` already has test coverage under before choosing.

**Interfaces:**
- Consumes: existing `NativeNotificationService.checkPermission()` (`mobile/lib/services/native_notification_service.dart:143`, interface at line 94, backed by `gateway.checkPermission()` at line 153) — already implemented, just unused for this purpose.
- Produces: `settings_screen.dart` (or the settings provider it reads from) now calls `checkPermission()` on screen load/resume and updates `AppSettings.notificationsEnabled` to match live OS state, rather than only writing that field once at initial request time (`providers.dart:472-473`).

**Root cause (confirmed by subagent code trace):** `AppSettings.notificationsEnabled` is a cached bool, written exactly once by `AppSettingsNotifier.toggleNotifications()` right after the initial permission request succeeds (`notifications_permission_screen.dart:33-36` → `providers.dart:472-473`). Nothing re-reads native state afterward, so revoking permission in system Settings never updates it — the app keeps showing "Enabled."

- [ ] **Step 1: Read the current `AppSettingsNotifier` and `settings_screen.dart` in full**

Read `mobile/lib/services/providers.dart` around lines 400-480 and `mobile/lib/features/settings/settings_screen.dart` in full to see exact widget lifecycle hooks available (e.g. does it use `ConsumerStatefulWidget` with `didChangeDependencies`/`initState`, or is it a plain `ConsumerWidget`?). This determines where a "refresh on screen show" hook can live.

- [ ] **Step 2: Write the failing test**

Extend `mobile/test/unit/native_notification_service_test.dart` using its existing `_FakeGateway` (already has `permission` and `permissionAfterRequest` fields per the file's current structure) with a new test:

```dart
    test('checkPermission reflects a permission revoked after the initial grant', () async {
      final gateway = _FakeGateway(
        permission: NativeNotificationPermission.granted,
      );
      final service = NativeNotificationService(gateway: gateway);
      // Simulate the user revoking permission in system settings.
      gateway.permission = NativeNotificationPermission.denied;

      final current = await service.checkPermission();

      expect(current, NativeNotificationPermission.denied);
    });
```

(Adjust the exact constructor name for `NativeNotificationService` and whether `_FakeGateway`'s `permission` field is mutable post-construction by reading the file first — this test asserts the *service* layer already reports live state correctly; if it already passes, the bug is entirely in whether `settings_screen.dart`/`AppSettingsNotifier` ever calls it, which the next step targets directly.)

- [ ] **Step 3: Confirm the service-layer test passes (it should — the gap is in the consumer, not the service)**

Run: `flutter test test/unit/native_notification_service_test.dart`
Expected: PASS if `checkPermission()` genuinely queries the gateway live each call (per the earlier trace). If it fails, the bug is deeper (in the service, not just the settings screen) — stop and re-root-cause before continuing.

- [ ] **Step 4: Wire `checkPermission()` into the settings screen/provider so it runs on screen display**

Add a method to `AppSettingsNotifier` (in `providers.dart`) such as `Future<void> refreshNotificationPermission()` that calls the notification service's `checkPermission()` and updates `state = state.copyWith(notificationsEnabled: result == NativeNotificationPermission.granted)`. Call this method from `settings_screen.dart`'s lifecycle (e.g. `initState`/`didChangeDependencies` if it's a `ConsumerStatefulWidget`, or via a `ref.listen`/`FutureProvider` refresh pattern if it's stateless — match whatever pattern Step 1 revealed).

- [ ] **Step 5: Run the full notification test file plus a manual simulator check**

Run: `flutter test test/unit/native_notification_service_test.dart`
Manual: deny notifications at the OS level in the simulator, open Settings screen in-app, confirm it now shows "Disabled"/whatever the denied-state copy is (per audit note PERM-002/PERM-003, avoid re-introducing the microphone-vs-notification copy confusion noted as a separate minor defect — out of scope here).

- [ ] **Step 6: Commit**

```bash
git add mobile/lib/services/providers.dart mobile/lib/features/settings/settings_screen.dart mobile/test/unit/native_notification_service_test.dart
git commit -m "fix: settings screen re-checks live OS notification permission instead of cached state"
```

### Task 6: Calendar import must use the real Apple Calendar service by default, not the fabricating mock

**Files:**
- Modify: `mobile/lib/services/providers.dart:137-145` (`calendarImportServiceProvider`)
- Test: `mobile/test/unit/calendar_import_service_test.dart` (already exists, already tests `AppleCalendarImportService` with `FakeAppleCalendarBridge` — extend with a provider-selection assertion, or add a small dedicated test)

**Interfaces:**
- Consumes: existing `AppleCalendarImportService` (already implemented, already tested against a real permission-status enum `AppleCalendarAuthorizationStatus`) and existing `MockCalendarImportService`.
- Produces: `calendarImportServiceProvider` prefers `AppleCalendarImportService` by default; `MockCalendarImportService` becomes an explicit fallback/test-only path, matching the same pattern change as Task 4.

**Root cause (confirmed):** `calendarImportServiceProvider` (`providers.dart:137-145`) returns `AppleCalendarImportService` only `if (config.isLocalBackend)`, otherwise defaults to `MockCalendarImportService`, whose `connect()` unconditionally sets `connectionState: CalendarImportConnectionState.connected` (line 37) and fabricates a synthetic `ImportedCalendarBusyBlock` (lines 41-49) without ever calling a native calendar permission API. This is the exact same "default points at the fixture, not the real thing" pattern as the capture-service bug.

- [ ] **Step 1: Confirm this is genuinely independent of `isLocalBackend`/`API_BASE_URL`**

`AppleCalendarImportService` talks to a native calendar bridge (`FakeAppleCalendarBridge` in tests), not the Next.js backend — read `mobile/lib/services/apple_calendar_import_service.dart` in full to confirm it has no backend HTTP dependency (only a native platform channel/bridge). If confirmed, this fix is independent of Phase 2 / the backend-availability concern, and should not be gated on `isLocalBackend` at all — it should just always be the default.

- [ ] **Step 2: Write the failing test**

Add to `mobile/test/unit/calendar_import_service_test.dart` or a new small provider test, asserting the provider does not select the mock by default. If `providers.dart`'s providers aren't easily unit-testable in isolation, write this as a `ProviderContainer` test:

```dart
    test('calendarImportServiceProvider defaults to the real Apple Calendar service', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final service = container.read(calendarImportServiceProvider);
      expect(service, isA<AppleCalendarImportService>());
    });
```

(Import `package:flutter_riverpod/flutter_riverpod.dart` and `package:maybesitter_mobile/services/providers.dart`; adjust the exact provider container setup to match this codebase's existing Riverpod test conventions — check an existing provider test if one exists via `grep -rl "ProviderContainer" mobile/test/`.)

- [ ] **Step 3: Run test to verify it fails**

Run: `flutter test test/unit/calendar_import_service_test.dart`
Expected: FAIL — currently resolves to `MockCalendarImportService`.

- [ ] **Step 4: Change the provider default**

In `providers.dart`, change:

```dart
final calendarImportServiceProvider = Provider<CalendarImportService>((ref) {
  final config = ref.watch(appConfigProvider);
  if (config.isLocalBackend) {
    return AppleCalendarImportService(
      analyticsService: ref.watch(pilotLoopAnalyticsServiceProvider),
    );
  }
  return ref.watch(_mockCalendarImportServiceProvider);
});
```

to always return the real service:

```dart
final calendarImportServiceProvider = Provider<CalendarImportService>((ref) {
  return AppleCalendarImportService(
    analyticsService: ref.watch(pilotLoopAnalyticsServiceProvider),
  );
});
```

Leave `_mockCalendarImportServiceProvider` defined for tests/widget-preview use, but it is no longer wired as the app's default.

- [ ] **Step 5: Run test to verify it passes, then run the full calendar test file**

Run: `flutter test test/unit/calendar_import_service_test.dart`
Expected: all PASS.

- [ ] **Step 6: Manual simulator verification**

Trigger calendar import in the app; confirm a real iOS calendar permission prompt appears (matching audit test IMP-CAL-001's expectation), and that "connected" only shows after a real grant.

- [ ] **Step 7: Commit**

```bash
git add mobile/lib/services/providers.dart mobile/test/unit/calendar_import_service_test.dart
git commit -m "fix: calendar import defaults to the real Apple Calendar service, not a fabricating mock"
```

### Task 7: Add a time-of-day edit control to the commitment detail screen

**Files:**
- Modify: `mobile/lib/features/commitment_details/commitment_details_screen.dart` (around lines 89-120 `editTitle()`, 147-169 app bar actions, 267-290 read-only `ListTile`s for date/time)
- Test: check for an existing widget test at `mobile/test/widget/` covering this screen; if none exists, add `mobile/test/widget/commitment_details_screen_test.dart` following whatever widget-test convention is used elsewhere in this repo (check `grep -rl "testWidgets" mobile/test/widget/ | head -1` for a template file to match).

**Interfaces:**
- Consumes: existing `AdaptiveDateTimePicker` from `mobile/lib/design_system/adaptive/adaptive_date_time_picker.dart` (already built, currently unused on this screen per the subagent's trace), existing `Commitment.copyWith(...)` (already supports `scheduledDate`/`startTime` per its use elsewhere in `postpone()`).
- Produces: a new edit affordance on the time `ListTile` (currently read-only, lines 267-290) that opens `AdaptiveDateTimePicker` and calls `commitment.copyWith(scheduledDate: ..., startTime: ...)` on save, mirroring the existing `editTitle()` dialog pattern.

**Root cause:** the detail screen's only editable field is title (`editTitle()`); the scheduled date/time `ListTile`s render plain text with no `onTap` and no picker wired in, even though a reusable `AdaptiveDateTimePicker` widget already exists elsewhere in the design system.

- [ ] **Step 1: Read the full `commitment_details_screen.dart` and `adaptive_date_time_picker.dart`**

Read both files in full before writing code — confirm `AdaptiveDateTimePicker`'s exact constructor (what it takes: initial `DateTime`? separate date/time? a callback signature?) so Step 3 calls it correctly rather than guessing.

- [ ] **Step 2: Write the failing widget test**

Following this repo's existing widget-test convention (confirm the pattern from an existing file first), assert that tapping the time `ListTile` opens a picker and that confirming a new time updates the displayed commitment. Sketch (adjust finder strategy — `find.text`, `find.byKey`, etc. — to match how `editTitle()`'s dialog is likely already tested, if at all, or how other screens' tap-to-edit interactions are tested in this repo):

```dart
testWidgets('tapping the time field opens a time picker and updates the commitment', (tester) async {
  // Pump CommitmentDetailsScreen with a fixed test commitment via ProviderScope overrides,
  // matching this repo's existing widget test setup pattern.
  // Tap the time ListTile.
  // Expect a date/time picker (AdaptiveDateTimePicker or its host dialog) to appear.
  // Simulate selecting a new time and confirming.
  // Expect the screen's displayed time text to reflect the new value.
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `flutter test test/widget/commitment_details_screen_test.dart`
Expected: FAIL — no picker currently opens on tap (there is no `onTap` at all yet).

- [ ] **Step 4: Add the edit affordance**

In `commitment_details_screen.dart`, give the time `ListTile` (around lines 267-290) an `onTap` that opens a new `editTime()` method, structured like the existing `editTitle()` (lines 89-120) but using `AdaptiveDateTimePicker` instead of a plain text field, and calling `commitment.copyWith(scheduledDate: newDate, startTime: newStartTime)` on confirm — matching exactly how `postpone()` already mutates `scheduledDate` elsewhere in this same screen (lines 77-87), so the save path is consistent with existing state-update conventions in this file.

- [ ] **Step 5: Run test to verify it passes**

Run: `flutter test test/widget/commitment_details_screen_test.dart`
Expected: PASS.

- [ ] **Step 6: Manual simulator verification**

Open a commitment's detail screen, tap the time field, change it, save, confirm the new time displays and (per Task 1's fix) survives a relaunch if this was a user-created commitment.

- [ ] **Step 7: Commit**

```bash
git add mobile/lib/features/commitment_details/commitment_details_screen.dart mobile/test/widget/commitment_details_screen_test.dart
git commit -m "feat: allow editing a commitment's scheduled time from the detail screen"
```

---

## Verification checklist (run after all phases)

- [ ] `flutter analyze` — no issues (matches audit's clean baseline; must stay clean).
- [ ] `flutter test` (full suite) — all green, zero pre-existing or newly introduced failures.
- [ ] `npm test` (backend, from repo root) — all green (untouched by this plan, but confirms no accidental backend breakage from Phase 2/3 provider changes — there should be none, since this plan makes no backend-side edits).
- [ ] Manual repro of the original PERSIST-001/002 scenario: create 2-3 commitments via capture, confirm, force-quit, relaunch — all survive (this is the audit's own reproduction recipe; use it as the final acceptance check).
- [ ] Manual repro of CAP-003/TIME-001 (explicit English time): capture "Remind me to call Ahmad tomorrow at 3 PM" with the local backend running — proposed time reflects 3 PM.
- [ ] Manual repro of PERM-002/003: deny notifications, confirm Settings screen shows the denied state, including after a relaunch.
- [ ] Manual repro of IMP-CAL-001: trigger calendar import, confirm a real native permission prompt appears before any "connected" state shows.
- [ ] Manual repro of EDIT-002: open a commitment, edit its time, confirm it saves and persists.

**Explicitly out of scope for this plan** (per audit, still open, not addressed here — call out to the user before considering the product release-ready): multi-commitment splitting (MULTI-001/002/003), ambiguity/escalation UI (AMB-*, ESC-001/002), Arabic/Hebrew content localization leakage (L10N-001/002), privacy disclosure copy (PRIV-001), and the alpha-trace G1/G2 session-hijack fix required before any pilot with tracing enabled.
