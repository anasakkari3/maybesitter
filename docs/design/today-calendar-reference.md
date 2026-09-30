# Today and Calendar — September 29 reference

The user requested replacing the two existing mobile tab screens with the
approved screenshot and the React Native prototype produced from it. This is a
scoped continuation of the existing application, based on `57915e33`.

The reference hash is recorded in
`mobile/src/design/today-calendar.source.json`. The screenshot supplies only
the small masked laptop illustration; every label, card, icon, button and
scrolling list is a native component.

## What changed

- Today uses the reference header, pink gradient primary card, rounded task
  rows, disclosure affordances, paired action buttons and gradient plan row.
- Calendar uses the reference week strip, pink selected day, chronological
  timeline, real All/Commitments/Busy filters and gradient review entry.
- Header controls open the existing commitment search, reminder settings and
  account screens. The tab bar adopts the reference appearance on these two
  roots and keeps its existing navigation/history behavior.
- Shared presentation lives in `src/ui/referenceDesign.tsx` and
  `src/ui/referenceIcons.tsx`; scoped colors and gradients live in
  `src/theme/tokens.ts`. The existing fonts remain script-aware.

## Product behavior retained

The account queries, mutations, authentication, consent, account isolation,
query invalidation and backend boundaries are unchanged. There is no prototype
store or sample week in the product screens. Existing next-step confirmation,
offered actions, duplicate-tap protection, quiet hours and all six plan states
remain intact. Saved week placements retain both their planned time and their
original due information. Calendar busy rows expose times only.

The reference's fictional durations, focus blocks, free slots and waiting count
are not asserted without corresponding product data. The calendar continues to
show today and the six days the API can actually answer. Arabic-first RTL,
English/Hebrew copy, date/time isolation, light mode, Dynamic Type, reduced
motion and reduced transparency remain supported.

## Validation

- Mobile TypeScript check passed.
- Today, next-step, plan composition, placement and date suites: 148 tests.
- Calendar, saved placements, meeting preparation and disconnect suites: 75 tests.
- Calendar filtering plus UI/accessibility reality audits: 34 tests.
- Navigation, tab clearance, RTL, screen-shell, localization and existing token
  guards: 193 tests.
- New header route, touch, dynamic type, reduced-transparency and actual gradient
  contrast coverage: 19 tests.
- The test runs overlap; these counts should not be added as unique coverage.
- Targeted ESLint reports no errors. The tab bar's existing nested `Tab`
  component still produces three `react-hooks/static-components` warnings.
- A fresh Debug iOS build succeeded and was installed on the existing
  `MS-UAT-20260927` iOS 26.5 simulator. The real app rendered both tab roots.
  Settings navigation, Arabic dark appearance, day selection and commitment
  filtering were verified through the native UI. The screenshot is saved at
  `outputs/today-calendar-integration-20260929/calendar-ar.png` in the workspace.
- Simulator screen capture became intermittent during the remaining visual
  walkthrough. Large-text and populated-list behavior are covered by the
  native component tests; this run does not claim a completed device walkthrough
  for those cases or an Android device test.

The initial native preview used development-only fixtures. The follow-up below
replaced that test setup with real authenticated HTTP requests and durable local
storage; the production configuration was not changed.

## Backend-connected follow-up — September 29

The integrated Debug app was run with `EXPO_PUBLIC_API_MODE=api`, an empty dev
bearer override, and normal email/password sign-in through the Firebase Auth
emulator. The matching backend ran from this worktree on port 3001, using the
Firestore emulator's isolated `reference-ui` database and synthetic accounts.
The cloud model remained disabled; capture used the rules engine.

Verified through the running app and API:

- Capture and confirm saved three synthetic commitments through `/api/mobile`.
- Today loaded its real next-step recommendation and Today/upcoming records.
  Pressing “Do this one” showed Started; pressing “Already done” changed the
  stored commitment to completed and refreshed Today to “1 of 2 done today”.
- Calendar removed that completed commitment, selected the next day, displayed
  its saved task, applied the Commitments filter, and opened the task details.
- Editing a task title in the native sheet persisted through the real PATCH
  endpoint. A subsequent conditional API time change appeared in both Today
  and Calendar after a cold app launch.
- Restarting the backend preserved the completion, edited title and new time.
- An unauthenticated request returned 401. A second synthetic account had empty
  lists and received 404 for the first account's commitment.
- On-demand daily-plan construction returned a proposal and the Today plan row
  displayed it as a suggestion, not as an accepted plan.

Two issues found during verification were fixed:

1. Separate Next.js route modules could call Firestore settings twice on the
   same cached SDK client, causing 503 responses. A shared weak registry now
   tracks that client across route module reloads. The regression reproduces
   independent module copies; actual emulator reads also pass after the fix.
2. The unverified-email banner and screen each added the top device inset.
   The banner now communicates when it owns that clearance; screens retain
   their state when the banner or keyboard changes. The final cold-launch
   screenshot confirms the extra band and clipped header are gone.

Follow-up checks passed: 13 focused storage tests, 15 auth tests, one emulator
storage isolation test, 70 mobile banner/screen/Today tests, and both backend
and mobile TypeScript checks. Focused lint had no errors; two existing
`Root.tsx` ref-assignment warnings remain.

Evidence is in the workspace's `outputs/today-calendar-integration-20260929/`:
`auth-isolation.json`, `live-api-mutations.json`,
`persistence-after-restart.json`, `today-live-backend-after-restart.png`, and
`calendar-live-backend-after-restart.png`.

Limits: this verifies the local backend with Firebase emulators, not staging
or production. No Android or external calendar-provider connection was tested.
Simulator automation could not perform scroll gestures reliably; scrolling
retains component-test coverage, not a completed gesture walkthrough. The
pre-existing dev bearer shortcut opens the gate but does not feed the API
repository; it was not used for the successful verification and remains
unchanged. Normal Firebase sign-in is the validated path.
