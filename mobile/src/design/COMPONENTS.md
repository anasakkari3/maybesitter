# Component inventory

Every component the app renders today, where it comes from in the design, and
what it must keep. New components are added when a screen needs them, not in
advance.

## The contract every component must satisfy

1. Colours, radii, spacing, type sizes and durations come from
   `src/theme/tokens.ts`. No hex, no magic numbers in a component or screen.
2. No physical box offsets (`marginLeft`, `paddingRight`, `borderLeftWidth`…).
   The ESLint rule blocks them; use the start/end form.
3. Text goes through `Txt`, so the Arabic and Latin faces and line heights are
   chosen by script rather than by hand.
4. Anything pressable is a `Btn` (or built on it): it carries
   `accessibilityRole="button"`, an `accessibilityLabel`, and the design's
   press scale, and it respects reduce-motion.
5. A render test covers it in light and dark, and in Arabic (RTL) and English
   (LTR).

## Shipped components

| Component | File | Design state where it appears | RTL notes | Status |
|---|---|---|---|---|
| `Txt` | `src/ui/primitives.tsx` | every state | Picks Noto Naskh vs Outfit by language; `latin` forces Outfit for digits in tight boxes; sets `writingDirection` | done |
| `Btn` | `src/ui/primitives.tsx` | every state | Press scale 0.95; start-aligned column content uses `alignItems: 'flex-start'`, never `textAlign` | done |
| `Pill` | `src/ui/primitives.tsx` | today, details, review, closeout, firstmove | Six kinds (accent/soft/outline/warm/ink/ghost); min height 48 | done |
| `Card` | `src/ui/primitives.tsx` | today, calendar, details, firstmove | Radius `card`; shadow only in light scheme | done |
| `HeaderPill` | `src/ui/primitives.tsx` | details, capture, review | Back/cancel affordance; mirrors with the row | done |
| `ImpBadge` | `src/ui/primitives.tsx` | today, review, details | must = sand, should = teal container, nice = neutral | done |
| Icons | `src/ui/icons.tsx` | tab bar, capture, today | Inline SVG; directional glyphs must mirror when added | done |
| `ScreenIn` / motion helpers | `src/ui/motion.tsx` | screen transitions, sheets | Durations from `motion`; honours `useReducedMotion` | done |
| `TabBar` | `src/screens/TabBar.tsx` | today, calendar, settings | Floating bar; blur on iOS only; symmetric absolute fill | done |
| `SheetHost` | `src/screens/Sheets.tsx` | clarify, readings, rearrange, toast | Scrim + slide-up; four sheet states | done |
| Gallery | `src/design/Gallery.tsx` | dev only | Renders every row above in both schemes and both directions | built, not wired (see below) |

## Not built yet

`BottomSheet`, `Dialog`, `TextField`, `SegmentedControl`, `Skeleton`,
`Banner`, `UndoToast`, `EmptyState`, `ErrorState`, `ProcessingIndicator`,
`PermissionEducationCard`.

The original #155 text lists these, but no shipped screen renders them, and a
component with no consumer is untested inventory that the Phase 2 author would
have to fight. Each lands with the screen issue that needs it (#171–#174),
built from tokens and primitives and meeting the contract above.

## Gallery wiring

`src/design/Gallery.tsx` is complete but not mounted. Mounting it adds a
`gallery` member to the screen union in `src/state/types.ts`, a branch in
`src/Root.tsx`, and a `jump('gallery')` case — all files the localisation work
(UC-1.R3 #156) is editing in parallel. It is wired in the commit that
integrates the two, behind `__DEV__` so it can never appear in a release.
