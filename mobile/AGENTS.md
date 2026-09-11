# MaybeSitter mobile app (React Native · Expo SDK 57)

## Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before
writing any code. This app targets Expo SDK 57, React Native 0.86, React 19.2.

## Design source of truth

Every screen follows the Claude Design project
`https://claude.ai/design/p/d96ab124-0531-4fef-9e0b-084677ee8911`
(`MaybeSitter.dc.html`, round 1). Nothing else is a design reference.

Rules the design fixes, which code must keep:

- Arabic first (RTL), English mirrored. Direction is set once on the root view
  (`direction: 'rtl'`); use `start`/`end` offsets and `borderStart*`, never
  `left`/`right`, so layouts mirror without per-screen code.
- Times and dates inside Arabic text go through `ltr()` from `src/i18n/strings.ts`.
- Inside a `Btn` (a `Pressable`), full-width text in a column aligns to the
  physical left even under `direction: 'rtl'`. Give start-aligned column
  content `alignItems: 'flex-start'` instead of relying on `textAlign`.
- Digits and Latin-only labels that sit in tight boxes (calendar day numbers)
  use `<Txt latin>`: Noto Naskh's tall line box clips them otherwise.
- One teal accent (`ac`) for actions and "done", one warm sand (`wm`) for
  "must". Nothing is red anywhere.
- There is no "overdue". Only active, done, rearranged, dropped on purpose.
  «أسقطه بوعي» has the same weight as «تمّت».
- Suggestions always say «هذا اقتراح. لم يتغيّر أي شيء بعد.» and nothing is
  saved without an explicit confirm.
- Spoken Arabic for actions: تمّت · لسّا · احكيها · أسقطه بوعي.
- Colours come from `src/theme/tokens.ts`; never hard-code hex in screens.
- Respect reduce-motion (`useReducedMotion` in `src/ui/motion.tsx`).

## Layout

```
App.tsx              fonts + providers
src/Root.tsx         screen switch, tab bar, sheet host
src/state/           AppContext (state + actions), seed data, types, derive helpers
src/services/        mockCapture (stand-in for POST /api/mobile/capture)
src/screens/         one file per design screen, Sheets.tsx, TabBar.tsx
src/ui/              primitives (Txt, Btn, Pill, Card…), icons (SVG), motion
src/i18n/strings.ts  all copy, ar + en
src/theme/           tokens (light/dark palettes), fonts
```

## Backend

The app will talk to `/api/mobile/**` in the repository root. Today it runs on
the design's sample week (`src/state/seed.ts`) and the mock capture service.
Fields the design needs that the backend does not return yet: duration / end
time, items with no time and yesterday's items, sentence-span → card mapping,
ambiguity and "big task" flags.

## Commands

```
npm start          # Expo dev server
npm run ios        # iOS simulator
npx tsc --noEmit   # type-check
```
