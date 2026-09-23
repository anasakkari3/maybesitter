# Round 1 → Round 2: what changed, and what it costs to adopt

Round 2 of the Claude Design project landed in `design/` on 2026-09-22
(project `7f9b0a08-…`, entry `R2App.dc.html`). This is the delta against
Round 1 (`d96ab124-…`, `MaybeSitter.dc.html`) and against the app as it
stands, so the migration can be scheduled rather than guessed at.

**The headline: Round 2 is a redesign of the spine, not a replacement for the
app.** It builds five screens and two flows. The app has twenty-four screens.
Deleting the Round-1 implementation today would delete working screens that
Round 2 does not replace.

---

## 1. Information architecture

| | Round 1 | Round 2 |
|---|---|---|
| Shape | flat state machine, one screen at a time | app shell: 3 tabs, each with its own nav stack |
| Tabs | Today · Calendar · Say it · Settings (capture is a tab) | Today · Calendar · Settings, with capture as a centre button, not a tab |
| Depth | none — every screen is a sibling | `push`/`pop` per tab; the tab bar hides when a stack is non-empty |
| Overlays | sheets only | *tasks* (full-screen flows), *sheets* (`@name`), *dialogs* (`!name`) |
| Deep links | `maybesitter://<state>` | routes are paths: `calendar/details:c1`, `today/plan`, `settings/@edit`, `today/!drop`, `capture:review` |

The app's `Screen` union in `src/state/types.ts` is flat and deliberately
avoids a navigation library ("a route tree for seven leaves would be a
navigation library this app has deliberately not taken on"). Round 2's
per-tab stacks re-open that decision. It does **not** require a navigation
library — the export implements stacks in ~15 lines of `setState` — but it
does mean `Root.tsx` stops being a `switch`.

## 2. Screen-by-screen

### Round 2 builds these (migration work, design available)

| Round 2 | App today | Note |
|---|---|---|
| `today` | `TodayScreen.tsx` | restructured; next-step card, plan strip, done-list toggle |
| `calendar` | `CalendarScreen.tsx` | week strip with per-day load bars; busy blocks shown as times only |
| `plan` | `PlanScreen.tsx` | proposal/accepted/generating/dismissed/empty, move-with-collision-check, regen budget |
| `details` | `DetailsScreen.tsx` | edit · done · reopen · postpone · drop · delete |
| `settings` (root list) | `SettingsScreen.tsx` | four groups; rows only |
| `capture` → `review` → `saved` | `CaptureScreen` + `ReviewScreen` + `SavedScreen` | one task with steps, not three screens — matches the app's existing `capture` single-entry decision |
| `share` | `ShareScreen.tsx` | preview → reading → review, plus four refusal states |
| sheets: `edit` `defer` `more` `postpone` `planMove` `readings` `flag` `clarify` | `Sheets.tsx` (`postpone` `edit` `confirmDrop` `confirmDelete` `toast`) | Round 2 adds `defer`, `more`, `planMove`, `flag`; revives `clarify`/`readings`, which #165 had deliberately dropped in favour of the server's own question |

### Round 2 does not build these (the app has them; they would be lost)

`hasScreen()` reads `this.builtScreens`, which the export never assigns, so it
is always false and all sixteen settings sub-screens render one shared
placeholder:

`calendarSettings` · `feeds` · `routine` · `energy` · `categories` ·
`langAppearance` · `sources` · `reminders` · `morning` · `widget` · `trust` ·
`knows` · `memory` · `activity` · `account` · `about`

And these are routable with state but have neither a `*Vals` builder nor a
template branch, so they render nothing at all:

`onboarding` · `auth` · `permission` · `notif` · `gallery` · `deleteAccount`

Against the app's `Screen` union that leaves **no Round-2 design** for:
`trust`, `knows`, `memory`, `feedbackHistory`, `activity`, `routineSettings`,
`readinessSettings`, `notificationsSettings`, `calendarSettings`,
`widgetSettings`, `footballSettings`, `calendarFeeds`, `categorySettings`,
`about`, `deleteAccount`, `gallery`, `calendarDemo` — plus sign-in, email
auth, the account-deleted receipt, the language gate and the legal screens,
which live outside that union.

> Football has no Round-2 counterpart at all: `r2-seed.js` carries a `CLUBS`
> list, but nothing renders it.

## 3. Tokens

**Round 2 restyles three colours and carries the rest over unchanged.** The
retheme is very nearly additive. Round 2's other change is that the values are
*declared* — Round 1 had no `:root` and no custom properties, so
`tokens.source.json` had to be built by counting literals.

| Token | Round 1 | Round 2 |
|---|---|---|
| `color.light.surfaceBar` | `rgba(255,255,255,.86)` | `rgba(255,255,255,.88)` |
| `color.dark.surfaceBar` | `rgba(26,32,35,.88)` | `rgba(26,32,35,.90)` |
| `color.dark.overlay` | `rgba(10,14,16,.45)` | `rgba(0,0,0,.55)` — deeper, and the blue taken out |

All three were missed on the first read of this export and caught by the test
described below, which compares every role against the export rather than
trusting a transcription.

Two things the app had already done on its own, the export now does itself:

- **`color.dark.onBrand`** — Round 1 specified `#FFFFFF`, which measures
  2.01:1 on the dark accent and fails WCAG AA. The app deviated to `#101416`
  (9.22:1). Round 2 specifies `#101416`. **The deviation is closed**;
  `deviations` is now empty and the record moved to `deviationsResolved`.
- **Noto Sans Hebrew** — added by the app in UC-2.R5 because neither Round-1
  face carried a Hebrew glyph. Round 2 loads all three families.

New roles Round 2 names that `theme/tokens.ts` does not carry yet:

| Token | Light | Dark | For |
|---|---|---|---|
| `--lnStrong` | `rgba(20,24,27,.22)` | `rgba(236,239,241,.28)` | unchecked circles, strong dividers |
| `--acd` | `#14586A` | `#8ED3E3` | pressed/hover accent |
| `--ul` | `rgba(31,122,140,.4)` | `rgba(142,211,227,.45)` | underlines |
| `--acOnInk` | `#9EDCE9` | `#6FC3D6` | accent on an ink surface |
| `--dis` / `--disTx` | `#E4E8EA` / `#4F5A5F` | `#2A3236` / `#B4BEC3` | disabled buttons |
| `--prop` | `rgba(31,122,140,.5)` | `rgba(111,195,214,.55)` | the dashed border that marks a proposal |
| `--ink` / `--onInk` | `#14181B` / `#F5F7F8` | `#ECEFF1` / `#101416` | inverted surfaces |
| `--sfBarSolid` | `#FFFFFF` | `#1A2023` | the bar where blur is unavailable |
| `--sh` / `--shBar` | see export | see export | card and bar shadows |

### Type ramp — this one *is* a break

Round 2 narrows eleven steps to nine and moves two of them:

| | Round 1 | Round 2 |
|---|---|---|
| kept | 34, 28, 15, 14, 13, 12, 11 | 34, 28, 15, 14, 13, 12, 11 |
| dropped | 26 `title2`, 22 `section`, 19 `cardTitle`, 16 `bodyLarge` | — |
| added | — | 20 `h2`, 17 `card` |

The Round-1 names are kept in `tokens.source.json` as `typeScaleLegacy`
because the shipped screens are written against them. They can only be
removed screen by screen.

### `--ts`: a text-size multiplier (new)

Round 2 multiplies the whole ramp by 1 (`default`), 1.2 (`large`) or 1.45
(`xl`), and at `xl` the tab bar drops its labels and shows icons only. This
is a direct answer to the finding that the tab bar dies at XXXL text.

## 4. Other things Round 2 adds

- **Twenty scenario states** as a first-class prop: `empty`, `allDone`,
  `loading`, `partial`, `offline`, `error`, `sync`, `syncError`, `quiet`,
  `planAccepted`, `planEmpty`, `planGenerating`, `planDismissed`,
  `nextStarted`, `calDisconnected`, `reauth`, `revoked`, `notifBlocked`,
  `notifProvisional`. Round 1 designed the happy path and left the rest to
  the implementation.
- **An Android frame** (`android-frame.jsx`, Material 3) beside the iOS one,
  and per-platform safe areas (`ios` 58/34, `android` 14/10, `bare` 22/16).
- **Hebrew throughout** `r2-strings.js`, not just as a language option.
- **A persona and a week** (`r2-seed.js`) that the app's own `src/state/seed.ts`
  can be checked against.

## 5. What it would take

Ordered so each step is independently shippable and independently verifiable.

1. **Export + pin** — *done, this branch.* `design/` replaced, manifest
   regenerated, `sourceManifestSha` updated, extraction script reads the
   declared custom properties instead of counting literals, deviation closed.
   `mobile/src/design/__tests__/tokens.test.ts` green, and each of its three
   guards proven to fail when broken.
2. **Additive tokens** — *done.* The ten new roles and the Round-2 ramp
   (`typeScaleR2`) sit in `theme/tokens.ts` alongside the legacy names, with
   `Palette` carrying the export's own short names so a migrating screen reads
   the same token in both places. No screen changed. Three colours Round 2
   actually restyles were adopted, and `tokens.test.ts` now checks all
   twenty-three roles against the export in both schemes rather than trusting
   a transcription — which is how those three were found.
3. **`--ts` text scaling** — *done.* `src/theme/textScale.ts` holds the ramp;
   `Txt` caps the platform at 1.45× and computes its line box from the size
   the text actually renders at; the tab bar goes icons-only at the `xl` step
   and keeps every accessible name. See §6.
4. **The shell** — `Root.tsx` from `switch` to three tabs with stacks, capture
   as a centre button. This is the one step that touches every screen's entry
   point; the unbuilt screens keep their current UI and simply become stack
   entries.
5. **Spine screens, one per change** — today, calendar, plan, details,
   settings root, capture flow, share flow.
6. **Decide the rest.** Sixteen settings sub-screens plus auth, onboarding and
   deletion have no Round-2 design. Either they stay on Round 1 — which is
   fine, they are leaf screens and the shell hides the seam — or Round 3
   covers them.

`Root.tsx` (step 4) has not been touched.

---

## 6. What steps 2 and 3 actually changed

### The defect step 3 fixes

`Txt` set a fixed `fontSize` and left React Native's `allowFontScaling` at its
default of **true**. Nothing in the app read the font scale, so:

- the OS enlarged every label without a ceiling, while the floating tab bar
  kept a 56-pt capture button and 8-pt padding, and the row broke; and
- `lineHeight` is *not* scaled by React Native, so every enlarged string was
  drawn into its original line box. That clips worst in Arabic, whose face
  asks for 1.6 and whose glyphs are tall — the app's primary language.

There was no icons-only path to repair: it did not exist. Step 3 adds one.

### Where this deliberately departs from the export

The export's `textSize` is a three-option picker, so its scale is exactly one
of `1 / 1.2 / 1.45`. Snapping a real reader to the nearest step would *shrink*
text for anyone between two of them — someone at 1.35× would be served 1.2×.
The app therefore keeps the platform's continuous scaling and takes two things
from Round 2 instead:

- `MAX_TEXT_SCALE` (1.45) as the ceiling, applied with `maxFontSizeMultiplier`,
  which is what keeps the geometry inside the design's bounds; and
- `textStepFor`, the discrete step, for layout decisions — thresholds at the
  midpoints, 1.1 and 1.325.

A reader at 1.35× gets text at 1.35× **and** the `xl` layout.

### Dropping a label is not dropping a name

At `xl` the four painted labels come off, exactly as the export specifies
(`tabLabels = textSize === 'xl'`). Every button keeps its `accessibilityLabel`,
so VoiceOver and TalkBack announce the same four tabs at every size, and a test
asserts the set is identical at 1× and at 1.45×.

**One consequence to know about:** a device flow that finds a tab by its
visible text will not find it for a reader at 1.325× or above. Maestro flows
and any future UI automation should match `testID` or the accessible name, not
the painted label.

### A test-environment lie, now fixed

React Native's own Dimensions mock reports `fontScale: 2`. That never mattered
while nothing read it; the moment step 3 landed, every test silently rendered
the largest layout and eighteen of them failed. `jest.setup.js` now reports 1,
so a test about anything else sees an ordinary phone, and the tests that *are*
about text size mock the module themselves.
