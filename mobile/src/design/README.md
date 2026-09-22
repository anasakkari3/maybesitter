# Design system

One source, one set of values, no invented ones.

## Where the values come from

`design/` at the repository root is the Claude Design export — **Round 2**
(`R2App.dc.html`). Unlike Round 1, it declares its tokens: `renderVals()` emits
one custom-property string per scheme, a nine-step type ramp and per-platform
safe areas. `mobile/scripts/extract-design-tokens.mjs` reads them out, and
`tokens.source.json` here records them and pins the export's manifest by
sha256. `__tests__/tokens.test.ts` compares every colour role in
`src/theme/tokens.ts` against the export in both schemes, so a token cannot
drift from the design silently, and it holds every text pair to WCAG AA.

## The layers

- `src/theme/tokens.ts` — colour roles per scheme, the `Palette` short names
  the screens use (the export's own: `ac`, `wms`, `lnStrong`, `prop`…), radii,
  the Round-1 and Round-2 type ramps, motion, shadows.
- `src/theme/textScale.ts` — text follows the reader's OS font scale, uncapped;
  layout mode (normal · large · xl) follows the platform's content-size
  categories and saturates at `xl`.
- `src/ui/primitives.tsx` — `Txt`, `Btn`, `Pill`, `Card`, `Divider`.
- `src/ui/chrome.tsx` — the screen grammar: `ScreenHeader`, `BackHeader`,
  `SectionLabel`, `Tag`, `TextLink`, `EmptyState`, `Skeleton`, `Notice`.
- `src/ui/taskHeader.tsx`, `src/ui/dialog.tsx`, `src/ui/toast.tsx` — the
  task header, the one confirmation shape, the calm confirmation of a write.

`COMPONENTS.md` is the inventory. The Round-1 gallery screen is gone with
Round 1; the components are exercised by the screens' own tests.
