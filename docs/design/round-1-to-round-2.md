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

**Every Round-1 colour survives Round 2 byte for byte.** The retheme is
additive, not a break. Round 2's real change is that the values are
*declared* — Round 1 had no `:root` and no custom properties, so
`tokens.source.json` had to be built by counting literals.

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
2. **Additive tokens** — add the ten new roles and the Round-2 ramp to
   `theme/tokens.ts` alongside the legacy names. No screen changes, so no
   screen tests move.
3. **`--ts` text scaling** — wire the multiplier and the `xl` tab-bar
   behaviour. Standalone, and it fixes a live accessibility defect.
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

Nothing in `mobile/src` has been changed yet beyond step 1.
