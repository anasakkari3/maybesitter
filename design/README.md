# Claude Design export

The single design source for the React Native app in `mobile/`.

- **Source project:** `https://claude.ai/design/p/d96ab124-0531-4fef-9e0b-084677ee8911` ("Mobile app design scope")
- **Exported:** see `exportedAt` in `EXPORT_MANIFEST.json`
- **Exported with:** the DesignSync tool (read-only) from Claude Code
- **Round:** 1 — the prototype the current screens were built from

## Files

| File | What it is |
|---|---|
| `MaybeSitter.dc.html` | The design itself: one React state machine rendering every screen and sheet |
| `support.js` | The Claude Design runtime the HTML loads (generated; not a design artefact) |
| `ios-frame.jsx` | The iOS device frame used to present the screens (starter scaffold, not product UI) |
| `github.md` | The project's own note of which repo files it was grounded in |
| `EXPORT_MANIFEST.json` | `sha256` and byte count per file, plus the export timestamp |

## Screens and states in the export

The design is not a set of artboards; it is one state machine. The states are:

`today` · `calendar` · `capture` · `review` · `saved` · `details` · `closeout`
· `firstmove` · `settings`

with the sheet states `clarify`, `readings`, `rearrange` and `toast`.

`mobile/src/state/types.ts` mirrors these names, and `maybesitter://<state>`
deep links open any of them directly (`mobile/src/links.ts`).

## Where the tokens live

There is **no** `:root` block and no CSS custom properties in the export. The
only `<style>` block holds `@keyframes` and a `prefers-reduced-motion` guard.
Every colour, size and spacing value is an inline literal inside the component
script. Tokens therefore have to be *extracted*, not read — that is UC-1.R2
(#155), which pins `mobile/src/design/tokens.source.json` to this folder's
`EXPORT_MANIFEST.json` sha256.

Typefaces come from Google Fonts at the top of the HTML: **Outfit** (Latin) and
**Noto Naskh Arabic** (Arabic). There are no Hebrew glyphs in either face, so
Hebrew needs a face that the design does not yet name.

## Rules

- This folder is the single design source for `mobile/`.
- Do not hand-edit the exported files. Re-export instead: a re-export replaces
  the whole folder in one commit and `exportedAt` changes.
- The HTML loads React and Babel from a CDN at runtime, so opening it offline
  shows the frame but not the rendered screens. That is a property of the
  export, not a missing asset: the export references no images, icons or font
  binaries, and all SVG is inline.

## Note on the old issue text

OWNER-A4 (#138) was written before S0 and says the export is for `mobile-rn/`
and that only the owner can perform it. Both are stale: the app lives in
`mobile/`, and the export was performed read-only by an agent through
DesignSync.
