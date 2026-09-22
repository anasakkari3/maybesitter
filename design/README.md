# Claude Design export — Round 2

The single design source for the React Native app in `mobile/`.

- **Source project:** `https://claude.ai/design/p/7f9b0a08-61c9-4326-90c0-ea5b2523fdb7`
  ("MaybeSitter Round-2 mobile design")
- **Exported:** see `exportedAt` in `EXPORT_MANIFEST.json`
- **Exported with:** the DesignSync tool (read-only) from Claude Code
- **Round:** 2 — replaces Round 1 (`d96ab124-…`, `MaybeSitter.dc.html`), which
  is what the nine shipped screens were built from and is still what they look
  like today.

## Files

| File | What it is |
|---|---|
| `R2App.dc.html` | The design itself: one React class rendering every screen, sheet and dialog |
| `r2-strings.js` | All copy, three languages: `ar` (primary) · `en` · `he` |
| `r2-seed.js` | The sample persona and her week — commitments, plan, memory, activity, shares, feeds |
| `support.js` | The Claude Design runtime the HTML loads (generated; byte-identical to Round 1) |
| `r2-frame.jsx` | Picks the device frame from the `platform` prop |
| `ios-frame.jsx` | iOS device frame (starter scaffold, not product UI; unchanged from Round 1) |
| `android-frame.jsx` | Android/Material 3 device frame (starter scaffold, new in Round 2) |
| `EXPORT_MANIFEST.json` | `sha256` and byte count per file, plus the export timestamp |

## What Round 2 changes

Round 1 was a flat state machine: one screen at a time, nine names. Round 2 is
an app shell — **three tabs** (`today` · `calendar` · `settings`) each with its
own navigation stack, a central capture button, plus *tasks* (full-screen
flows), *sheets* and *dialogs* layered over them.

Routes are strings: `today`, `calendar/details:c1`, `today/plan`,
`settings/@edit`, `capture:review`, `today/!drop`. Prefix `@` is a sheet,
`!` is a dialog.

It also adds what Round 1 had no answer for: a `scenario` prop with twenty
states (`empty`, `allDone`, `loading`, `partial`, `offline`, `error`, `sync`,
`syncError`, `quiet`, `planAccepted`, `planEmpty`, `planGenerating`,
`planDismissed`, `nextStarted`, `calDisconnected`, `reauth`, `revoked`,
`notifBlocked`, `notifProvisional`), a `textSize` prop (`default` · `large` ·
`xl`, a 1 / 1.2 / 1.45 multiplier over the whole type ramp), and an Android
frame beside the iOS one.

## What Round 2 does **not** cover

This matters before anything is deleted. The export renders real UI for:

`today` · `calendar` · `plan` · `details` · `settings` (root list only) ·
the `capture` → `review` → `saved` flow · the `share` flow · the sheets
(`edit`, `defer`, `more`, `postpone`, `planMove`, `readings`, `flag`,
`clarify`) · the toast and dialogs.

Everything else is **routable but unbuilt**:

- All sixteen settings sub-screens — `calendarSettings`, `feeds`, `routine`,
  `energy`, `categories`, `langAppearance`, `sources`, `reminders`, `morning`,
  `widget`, `trust`, `knows`, `memory`, `activity`, `account`, `about` — render
  one shared placeholder. `hasScreen()` reads `this.builtScreens`, which the
  export never assigns, so it is always false.
- `onboarding`, `auth`, `permission`, `notif`, `gallery` and `deleteAccount`
  have route entries and state, but no `obVals`/`trustVals` builder and no
  template branch. They render nothing.

The app in `mobile/` **has** those screens today and they work. Round 2 is a
redesign of the spine, not a replacement for the whole app.

## Where the tokens live

Unlike Round 1, Round 2 declares them. `renderVals()` emits one
custom-property string per scheme (26 colour roles), a nine-step type ramp
(`--f-display` … `--f-meta`, each `calc(Npx * var(--ts))`) and per-platform
safe areas. `mobile/scripts/extract-design-tokens.mjs` reads them out.

Round 2 restyles exactly three colours — the bar's alpha in both schemes
(.86 → .88 light, .88 → .90 dark) and the dark scrim, which becomes a deeper
neutral black (`rgba(10,14,16,.45)` → `rgba(0,0,0,.55)`). Every other colour
carries over unchanged. `tokens.test.ts` now checks all twenty-three roles
against this export in both schemes, so this is machine-checked rather than
read off by eye.

Two things the app had to do on its own, the export now does itself:

- **dark on-accent** is `#101416`, the accessible value the app deviated to.
  There are no deviations left.
- **Noto Sans Hebrew** is loaded alongside Outfit and Noto Naskh Arabic.

`mobile/src/design/tokens.source.json` pins this folder's
`EXPORT_MANIFEST.json` by sha256 and is checked by
`mobile/src/design/__tests__/tokens.test.ts`.

## Rules

- This folder is the single design source for `mobile/`.
- Do not hand-edit the exported files. Re-export instead: a re-export replaces
  the whole folder in one commit and `exportedAt` changes. The sha256 test
  fails until `sourceManifestSha` is updated, which is the point.
- The HTML loads React and Babel from a CDN at runtime, so opening it offline
  shows the frame but not the rendered screens. That is a property of the
  export, not a missing asset: it references no images, icons or font
  binaries, and all SVG is inline.
