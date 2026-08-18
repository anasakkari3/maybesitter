# Lane A — Product Reliability Audit and Core-Flow Fixes

> **Purpose:** an end-to-end reliability pass over the canonical Flutter app
> (`mobile/**`) ahead of pre-pilot alpha hardening: exercise capture →
> extraction → confirmation → recommendation → accept/edit/defer/dismiss/done
> → persistence, find what's actually broken, fix every reproducible P0/P1,
> and leave a trail for anything lower-severity that's still open. This is
> tooling and hardening work for the development team; it does not authorize
> pilot deployment and involved no external participants.

## Method

Findings in this report come from three sources, not just one:

1. **Code review** of `mobile/lib/features/capture/**`,
   `mobile/lib/features/commitment_details/**`, `mobile/lib/features/today/**`,
   `mobile/lib/features/next_step/**`, `mobile/lib/features/upcoming/**`,
   `mobile/lib/features/activity/**`, and the services/providers layer they
   depend on, tracing each state transition against what the UI claims it
   does.
2. **TDD regression tests** in `mobile/test/widget/lane_a_reliability_test.dart`
   — a failing test written against the defect first, then the minimal fix,
   then green.
3. **On-device verification** on a booted iOS Simulator (iPhone 17,
   iOS 26.5): `flutter run` + `xcrun simctl io screenshot` to look at actual
   rendered screens, and `flutter test integration_test/app_test.dart -d
   <device>` to drive real taps against the real compiled app (not the
   `flutter_tester` host).

The third source mattered in practice, not just in principle: one defect
(the FAB/next-step overlap below) was invisible to a widget test running at
the default test-harness geometry and only became obvious from an actual
screenshot. A regression test for it that doesn't force a realistic device
size and doesn't check a font-independent invariant will quietly stop
proving anything — see that section for the specifics.

## Flows exercised

| Flow | How |
|---|---|
| Capture composer → text entry → Analyze | Widget tests + on-device integration test (real taps, real text entry) |
| Extraction → review → select/deselect/edit/remove items → confirm | Widget tests + on-device integration test |
| Clarification prompt → option selection → review | Widget test driven through a real `GoRouter` (tap-through, not just state assertions) |
| Confirm → partial/full success → Success screen → Undo/View Tomorrow/Done | Widget tests (existing `capture_flow_test.dart` + new regression coverage) |
| Next step recommendation → Accept/Edit/Defer/Dismiss/Done | Existing `v03_next_step_card_test.dart` suite (re-run, still green) + visual confirmation on simulator |
| Today screen: header, next-step card, MUST/SHOULD/NICE/Completed sections, capture FAB | Simulator screenshots (before/after fix) + widget tests at realistic device geometry |
| Commitment details: view, edit title, mark complete, postpone, delete | Widget test (tap-through the real edit dialog, confirm persistence) + simulator screenshot |
| Locale/RTL switching (English/Arabic/Hebrew) mid-session | Existing `app_integration_test.dart`, re-run on-device |

Upcoming and Activity were code-reviewed in full (no defect surfaced) but
not re-driven on-device this pass. Settings, Trust Center, and onboarding
were not reviewed this pass at all; their existing test coverage remains
green, but that's not the same claim as having audited them.

## Defects found

| # | Description | Severity | Status |
|---|---|---|---|
| 1 | Success screen reported *every* extracted commitment as saved, including ones the participant deselected or the server failed to persist; Undo tried to delete items that were never written | P1 | Fixed |
| 2 | Resolving a clarification prompt discarded the participant's real input and extracted items, replacing them with hardcoded fixture data ("Go to the doctor" / "Work afterward") regardless of what was typed or which option was tapped | P1 | Fixed |
| 3 | Commitment Detail's pencil "Edit" icon rendered fully enabled (default/mock config, the normal local run mode) but tapping it did nothing — no dialog, no navigation, no feedback | P1 | Fixed |
| 4 | The persistent "Capture Plan" FAB on Today sits at a fixed screen position and paints above scroll content; on real device rendering it overlapped the next-step card's "Not now"/"Dismiss" actions, stealing the tap | P1 | Fixed |
| 5 | The existing regression test for #1 hung indefinitely (didn't fail, didn't pass) rather than proving anything | Test infra (blocking) | Fixed |
| 6 | `CaptureState.copyWith`'s optional fields (`errorMessage`, `analysisNote`, etc.) can't be explicitly cleared to `null` — passing `null` falls back to the old value via `??`. No currently-visible symptom found (every place that reads `errorMessage` is only reached from a status that freshly sets it), but it's a latent trap for the next state transition added to this controller | P2 (not fixed, see below) | Known, not fixed |
| 7 | Commitment Detail's edit dialog only lets you change the title, not date/time/location/category, even where the backend supports patching those fields | P2/scope | Known, not fixed |

## Defects fixed

### 1. Success screen reported unsaved commitments as saved
`mobile/lib/features/capture/success_save_screen.dart` sourced its "Added N
commitments" summary and Undo action from
`captureState.extractedCommitments` — *every* item the extractor returned,
not `persistedItemIds` — the set the server actually confirmed. A
deselected item, or one that failed server-side, would be reported (and
offered for undo-deletion) as if it had been saved.

**Fix:** filter by `persistedItemIds`.
**Test:** `lane_a_reliability_test.dart` → "Success screen reports only the
commitments that were actually saved" (pre-existing test from a prior
session; the assertion was correct, but it never actually ran — see #5).
**Commit:** `5a9155e`

### 2. Clarification resolution discarded the real capture
`ClarificationSheetScreen`'s `onSelectOption` callback ignored the tapped
option and called `notifier.previewState(CaptureStatus.needsConfirmation)`
— a dev/test fixture helper — regardless of what the participant had typed
or which extracted items actually needed clarifying. The backend's
`needs_clarification` disposition is a real, reachable state (see
`lib/services/captureService.ts`, `src/extraction/extractionPolicy.ts`), so
this wasn't hypothetical: any ambiguous real input would land the
participant on a review screen showing invented commitments unrelated to
what they said.

**Fix:** added `CaptureNotifier.resolveClarification(option)`, which
unblocks the items that were waiting on clarification (clears
`needsClarification` on them) and proceeds to review using what was
actually extracted. There is no backend endpoint to interpret the option's
semantics yet, so this is deliberately the honest minimal behavior — not a
fabricated resolution — and is called out as a known limitation, not
solved, below.
**Test:** new test in `lane_a_reliability_test.dart` — taps through a real
`GoRouter` from the clarification screen to the review screen and asserts
the real extracted titles appear, and the fixture titles don't.
**Commit:** `3389b03`

### 3. Commitment Detail's Edit icon was a dead end
`commitment_details_screen.dart`'s pencil icon changes color based on
`config.supportsSafeCommitmentPatch` (true by default in mock mode — the
default local run configuration), and its tooltip reads "Edit" in that
state. But the `onPressed` branch for that exact state was empty aside from
a comment ("Mock mode editing allowed for prototyping"). The
*disabled*-looking state was more functional — it at least showed an
explanatory snackbar.

**Fix:** wired the enabled path to a minimal title-edit dialog (same
pattern already used in `ExtractionReviewScreen`), saved through the
existing `commitmentRepositoryProvider.update()`.
**Test:** new test — taps the icon, types a new title into the dialog that
appears, taps Save, confirms both the UI and the repository reflect it.
**Commit:** `4f792a2`
**Known limitation:** title-only, see remaining defect #7.

### 4. Capture FAB overlapped the next-step card's actions
Confirmed by screenshot on a real iPhone 17 simulator: the "Capture Plan"
FAB — fixed at the bottom-right of Today's own Scaffold, painted above
scroll content — sat directly on top of the next-step card's "Not
now"/"Dismiss" row on first load, no scrolling required. This happens
whenever Today's content is short enough not to need scrolling (a light
day), which is a routine, not edge-case, state.

**Fix:** wrapped Today's `CustomScrollView` in `Padding(bottom:
kFabScrollClearance)` (96px — the FAB's own height + margins), so the
scrollable viewport itself never extends into the FAB's fixed zone,
independent of content length or scroll position.
**Test:** asserts the scroll viewport's own bottom edge stays above the
FAB's top edge. This required two corrections mid-flight, both left as
comments in the test:
  - The first version rendered `TodayScreen` alone in a bare `MaterialApp`,
    which gives it more vertical room than the real app (nested inside the
    router's `ShellRoute` Scaffold, which also renders the bottom tab bar) —
    passed against broken code. Fixed by wrapping the test in the same
    Scaffold + bottom-nav-bar shape as `app/router.dart`.
  - The second version measured the rect around the "Not now" text and
    still passed against broken code, because `flutter test` renders with a
    synthetic test font whose metrics are shorter than real device fonts —
    the same layout that visibly overlaps on a real phone measured as
    non-overlapping in the test harness. Fixed by asserting on the
    `CustomScrollView`'s own bounds (a hard-coded padding constant, not
    content-dependent) instead of any one piece of text.
**Verified on-device:** before/after screenshots on the iPhone 17
simulator; the fixed build shows a clean gap between the scroll content and
the FAB. The existing on-device integration test (which taps the FAB as
part of its flow) still passes.
**Commit:** `fccd50f`

### 5. The success-screen regression test hung instead of failing
Reported by the coordinator before this lane's own investigation began:
`flutter test` on this file hung for the full 5-minute default timeout
rather than failing normally. Root-caused via an isolated debug harness
(not left in the tree): the test called `await notifier.confirmSave()`
directly inside `testWidgets`, before any `tester.pump()`. `confirmSave()`
awaits a real `Future.delayed(200ms)` inside the mock capture service, and
`testWidgets` only advances its internal timer queue via `tester.pump`;
nothing had pumped yet, so that timer could never fire. A plain (non-widget)
`test()` calling the identical `confirmSave()` completed in under a
second, confirming the app logic itself was never the problem — this is a
widget-test-harness timing artifact, not a real hang in the app. On a real
device or in an `integration_test` run, real timers just fire normally.

**Fix:** wrapped the call in `tester.runAsync(() => notifier.confirmSave())`,
which escapes to the real timer zone.
**Commit:** `5a9155e` (same commit as #1, since this was required to make
that regression test meaningful at all)

## Remaining known defects (not fixed this pass)

### 6. `CaptureState.copyWith` can't clear optional fields to null
`errorMessage`, `analysisNote`, etc. use the standard `field ?? this.field`
`copyWith` pattern, which means passing `errorMessage: null` silently keeps
the *previous* error message instead of clearing it. Audited every current
call site: every state transition that reads `errorMessage` is reached only
from a status that freshly sets it in the same `copyWith` call, so there is
no currently reproducible visible symptom. Left as a known trap rather than
restructuring `copyWith` (would touch every call site) without a concrete
failure driving it — flagging it here so the next controller change that
adds a status transition doesn't get bitten silently.

**Repro condition to watch for:** any future code path where
`state.errorMessage` (or similar) is read from a status that *isn't* the
one that most recently set it.

### 7. Commitment Detail's edit dialog is title-only
The fix for defect #3 makes the Edit icon do something real, but it only
edits the commitment's title — not date, time, location, or category, even
where `ApiCommitmentRepository.update()` (and the backend PATCH endpoint)
support more fields via `PatchCommitmentRequestDto`. Scoped this way
deliberately: the defect was "does nothing," not "doesn't do everything,"
and a full multi-field edit surface is a larger feature than this audit's
P0/P1 mandate covers. Worth a follow-up ticket if commitment editing is a
priority for the pilot experience.

## Final status

- `cd mobile && flutter test`: **228 passed, 1 intentionally skipped**
  (`RUN_CANONICAL_BACKEND_FLOW` gate, unrelated to this lane), 0 failed.
- `cd mobile && flutter test integration_test/app_test.dart -d <simulator>`:
  passes on-device (real taps, real rendering) — covers capture →
  extraction → confirm → success plus mid-session locale/RTL switching.
- No backend (`src/`, `lib/` at repo root) code was touched; `npm test` was
  not re-run because nothing in scope for that suite changed.
- Files owned by other lanes (`lib/alphaTrace/**`, `lib/alphaFeedback/**`,
  `lib/quality/**`, `lib/pilot/alphaControls.ts`,
  `src/app/api/mobile/alpha/**`, the alpha contracts, `tests/alpha*/**`,
  `tests/quality/**`, `scripts/alpha-*.ts`, `docs/alpha/reviewable-trace.md`,
  `docs/alpha/dogfood-review.md`, `docs/quality/**`,
  `feedback_flag_button.dart`, `mobile/lib/l10n/**` structure) were not
  modified.

## Commits

| Commit | Summary |
|---|---|
| `5a9155e` | Success screen reports only persisted commitments; fixes the test hang that was masking it |
| `3389b03` | Resolving a clarification no longer discards the real capture |
| `4f792a2` | Commitment details Edit icon actually opens an editor |
| `fccd50f` | Capture FAB no longer overlaps the next-step card's actions |
| `3cf82e5` | Restores test viewport headroom two other test files needed after the FAB fix (caught by re-running the full suite, not by either fix's own TDD cycle) |
