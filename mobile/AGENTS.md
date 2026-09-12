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
App.tsx              fonts + providers + the sign-in gate
src/Root.tsx         screen switch, tab bar, sheet host (signed-in only)
src/auth/            AuthProvider/useAuth, AuthGate, the repositories, dev override
src/state/           AppContext (state + actions), seed data, types, derive helpers
src/services/        mockCapture (stand-in for POST /api/mobile/capture)
src/screens/         one file per design screen, Sheets.tsx, TabBar.tsx
src/ui/              primitives (Txt, Btn, Pill, Card…), icons (SVG), motion
src/i18n/strings.ts  all copy, ar + en
src/theme/           tokens (light/dark palettes), fonts
src/config/          env + the release config guard shared with app.config.ts
firebase/            the committed Firebase app config for both platforms
```

## Auth

`AuthGate` (`src/auth/AuthGate.tsx`) decides what renders: a blank hold while
Firebase answers, the sign-in screen when nobody is, and `Root` once someone
is. UC-1.7 (#151) specified this as expo-router `Stack.Protected` guards; this
app has no `app/` directory, so the same invariant is enforced in the
navigation the app actually has. Onboarding (UC-2.R1 #171) composes in as the
gate's `onboarding` slot when it lands.

Rules that hold here:

- **One module imports the Firebase auth SDK** — `firebaseAuthRepository.ts`.
  A test asserts it, so the "never log an ID token" rule is one file to read.
- **Nothing in `src/auth/` calls `console.*`.** Also asserted.
- **The dev bypass needs four conditions at once** (`devBypass.ts`): a
  development bundle, `APP_ENV=development`, a non-empty
  `EXPO_PUBLIC_DEV_BEARER_TOKEN`, and an API host on the developer's machine.
  `releaseGuard.ts` additionally fails the *build* if the variable is set for
  staging or production, so a binary that could honour it is never made.
- **Sign-in failures never say which half was wrong**, and a password reset
  reports the same thing whether or not the account exists.
- **`firebase/google-services.json` and `firebase/GoogleService-Info.plist`
  are committed on purpose** (#151). `.gitignore` negates them explicitly
  because many global gitignores exclude both by name.

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
