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

Native preview uses the existing development-only fixture mode and its guarded
local auth override. Fixtures validate rendering and navigation, not persistence
against a live account. No backend or release configuration was changed.
