# MaybeSitter mobile (Expo · React Native)

The MaybeSitter product client. Expo SDK 57, React Native 0.86, React 19.2,
TypeScript. This is the only mobile app in the repository; `mobile-rn/` must
never be created (`npm run check:no-flutter` at the repo root fails if it is).

Read `AGENTS.md` in this directory before changing anything: it records the
design rules the code must keep.

## Prerequisites

- Node 24 (the repo's `engines` require >= 22.5)
- Xcode (iOS simulator) and/or Android Studio (emulator)
- `npm ci` in this directory — `mobile/` is its own npm project with its own
  lockfile, separate from the backend at the repository root

## Environments

`app.config.ts` reads `APP_ENV` (`development` | `staging` | `production`) and
refuses to configure a staging or production build whose backend URL is
missing, not https, or points at a local/private host, or that carries a dev
bearer token. The failure is `CFG-1` and happens while Expo reads the project,
before any native compile:

```bash
APP_ENV=production npx expo config          # fails: CFG-1
APP_ENV=production EXPO_PUBLIC_API_BASE_URL=https://api.example.com npx expo config   # ok
```

The same rule (`src/config/releaseGuard.ts`) runs at runtime through
`src/config/env.ts`, so the build-time and runtime checks cannot drift.

Copy `.env.example` to `.env.local` for local work. Only `EXPO_PUBLIC_*`
values reach the bundle, so none of them may hold a secret. Staging and
production URLs live in EAS environment variables, not in this repository.

## Commands

```bash
npm start            # Metro
npm run ios          # iOS simulator
npm run android      # Android emulator
npm test             # Jest (jest-expo)
npm run typecheck    # tsc --noEmit
npx expo config      # resolve the app config (runs the CFG-1 guard)
```

## Builds

Native projects are not committed: `ios/` and `android/` are generated
(Continuous Native Generation) and gitignored. Build with EAS:

```bash
eas build --profile development --platform ios
eas build --profile staging --platform android
```

Profiles live in `eas.json`. `development` produces a dev client;
`staging` and `production` are internal/store builds.

## Tests

- Jest unit tests live next to the code in `__tests__` directories.
- `.maestro/smoke.yaml` is an end-to-end launch check; see `.maestro/README.md`.

## Layout

```
App.tsx              fonts + providers
src/Root.tsx         screen switch, tab bar, sheet host
src/config/          release guard + runtime env
src/state/           AppContext (state + actions), seed data, types, derive helpers
src/services/        mockCapture (stand-in for POST /api/mobile/capture)
src/screens/         one file per design screen, Sheets.tsx, TabBar.tsx
src/features/        pure client rules (e.g. commitments/timePatch.ts)
src/ui/              primitives, icons, motion
src/i18n/strings.ts  all copy
src/theme/           tokens (light/dark palettes), fonts
```
