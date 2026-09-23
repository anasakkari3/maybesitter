# Design system

The current visual authority is the user-approved coral continuation (2026-09-23).

## Where the values come from

The 15 supplied reference screens supersede the historical R2 teal palette.
`coral.source.json` records their SHA-256 hashes and the complete new color
roles. `tokens.source.json` and the R2 export remain intact as historical
provenance for navigation, typography, layout, and motion.

The tests pin both the old export's integrity and the approved continuation's
roles. Contrast checks cover primary/muted text, actions, links, confirmed
states, and disabled labels in both schemes. White on bright coral from the
references is deliberately replaced by dark ink. Light mode uses a deeper
coral. See `docs/design/coral-continuation.md` for coverage and decisions.

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
