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
- `src/config/__tests__/maestroFlows.test.ts` checks the flow *files* without a
  device: each parses as YAML, each `appId` matches the bundle identifier
  `app.config.ts` actually sets, and every `testID` a flow selects on is one
  the app can render. That last one is the point — a `testID` renamed in a
  component leaves a flow that still parses and fails only on the next device
  run, which may be weeks away.

### `.maestro/legal-links.yaml` (UC-4.2, #177)

The privacy policy and the terms from all three places they are reachable: the
signed-out sign-in screen, the Legal group in Settings, and the Trust Centre.

It branches, on purpose. `EXPO_PUBLIC_LEGAL_BASE_URL` is unset in every build
today — the domain is not bought (OWNER-A1 #137) — and with no base URL
`LegalLinks` renders nothing at all rather than a row that 404s. So the flow
asserts the invariant that holds either way: every surface offers the link, or
none of them does. Set the variable and the same file exercises opening the
in-app browser instead.

It branches on sign-in for the same reason: a build with
`EXPO_PUBLIC_DEV_BEARER_TOKEN` set starts signed in and never shows the sign-in
screen, and Maestro cannot sign in by itself. Run it twice — once with the
override, once without — to cover both halves.

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

## Google Sign-In troubleshooting

The button is only rendered when the build has a Web OAuth client id. That id
comes from the committed `firebase/google-services.json` (`client_type: 3`),
read by `app.config.ts` and passed through `extra.googleWebClientId`;
`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` overrides it. So "no Google button" means
that file has no web client — not a missing environment variable.

### `DEVELOPER_ERROR` (Android code 10)

Almost always a signing certificate whose SHA-1 is not registered in the
Firebase project. Every key that signs an installable build needs its SHA-1
**and** SHA-256 added under Firebase → Project settings → Android app
`com.maybesitter.app`, after which `google-services.json` must be
re-downloaded into `firebase/` and committed.

Where each fingerprint comes from:

| Build | Where the fingerprint lives |
|---|---|
| `npx expo run:android` | the prebuild debug keystore: `keytool -list -v -keystore android/app/debug.keystore -alias androiddebugkey -storepass android -keypass android` |
| EAS `development` / `staging` / `production` | `eas credentials -p android` |
| The Play store build | Play Console → App integrity → App signing — a **different** key, held by Google, and only available after the first track upload (UC-1.6a #150) |

The last row is why a build can work from EAS and fail from the Play store:
Play App Signing re-signs the upload with its own key, whose SHA-1 was never
registered. It is the one fingerprint that cannot be obtained before the first
upload.

The checklist, in the order worth trying:

1. Is the package name exactly `com.maybesitter.app`?
2. Is the SHA-1 of the key that signed *this* binary in the Firebase project?
3. Was `google-services.json` re-downloaded after adding it?
4. Is Google enabled under Firebase → Authentication → Sign-in method, with a
   support email set?
5. Is the id in `extra.googleWebClientId` the **web** client (`client_type: 3`),
   not the Android or iOS one?

The user never sees any of this: `DEVELOPER_ERROR` renders the generic copy,
because there is nothing they can do about it.

### iOS

No `iosUrlScheme` is configured by hand. The config plugin reads
`REVERSED_CLIENT_ID` out of `GoogleService-Info.plist`, which
`npx expo config --type introspect` shows as a `CFBundleURLSchemes` entry
alongside `maybesitter`. If that entry is missing, the plist is not being
picked up as `ios.googleServicesFile`.

## Release builds

```bash
eas build -p all --profile production
eas build -p all --profile staging      # internal distribution
eas submit -p android --profile production --latest
eas submit -p ios --profile production --latest
```

`eas.json` sets `appVersionSource: remote`, so EAS owns the build numbers and
nothing in the repository has to be bumped by hand.

### Release log

`version` is `1.0.0`, set once in `app.json`, and it stays there until the
product changes enough to deserve a different number. The thing that moves
between builds is the **build number**, and the repository does not hold it:
`appVersionSource: remote` means EAS assigns it, `autoIncrement` on the
`production` profile bumps it, and nothing here is bumped by hand. That is the
right trade — a number chosen by hand is a number that collides once — but it
leaves the repository with no record of which build carried which commit.

This table is that record (UC-4.6a, #182 step 1). Add a row when a build is
submitted to a track, not when it is built: a build nobody received is not a
release.

| Date | Platform | Version | EAS build no. | Profile | Track | Commit | Notes |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | No build has been cut. |

**No closed-test build exists yet.** The first one is blocked on OWNER-A2
(#158): there is no App Store Connect record and no Play app to submit to, and
the first Android upload has to be made by hand in the Console before
`eas submit` works at all. `docs/release/CLOSED_TEST_TRACKS.md` has the full
list of what a person with the accounts has to do first. Rows are written after
a submission, from `eas build:list`; nothing here is filled in ahead of time.

### Before a build reaches anyone

```bash
npm run check:no-credentials                 # nothing signing-related is tracked by git
npm run verify:release-android -- path/to/app.aab
```

`verify:release-android` reads the AAB itself rather than the config that was
meant to produce it, and checks the four things that have shipped wrong in
real projects: a debug-signed release, a missing `INTERNET` permission in the
*merged* manifest, backup left on, and no `dataExtractionRules`. It also
prints the signing certificate so the EAS upload key can be told apart from a
debug key at a glance.

The config-level equivalents run in CI as
`src/config/__tests__/appConfig.test.ts`, which asserts against
`expo config --type introspect` — what the plugins actually produce — rather
than against this file's source. That is how the
`NSAllowsArbitraryLoads: true` that Expo SDK 57 puts in *every* profile's
Info.plist was found.

### Credentials

Nothing signing-related lives in this repository, and
`npm run check:no-credentials` fails CI if it ever does.

| What | Where it lives |
|---|---|
| Android upload keystore | generated and held by EAS (`eas credentials -p android`); the owner keeps one downloaded backup in their password manager |
| Android app signing key | held by Google (Play App Signing); its SHA-1 must be added to Firebase after the first upload |
| iOS distribution certificate and provisioning profile | created and held by EAS (`eas credentials -p ios`) |
| Play service-account key | uploaded to EAS, never a path in the repo |
| `ascAppId` | a public numeric id the owner fills into `eas.json` `submit.production.ios` |

### Per-profile public configuration

Set with `eas env:create --visibility plaintext`. All of these are public
identifiers; a secret must never go into an `EXPO_PUBLIC_*` name, because
every one of them is compiled into the JavaScript bundle.

| Variable | Notes |
|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | the Cloud Run URL for that profile; must be https and not a private host, or the build stops (CFG-1) |
| `EXPO_PUBLIC_PRIVACY_URL`, `EXPO_PUBLIC_TERMS_URL` | when unset, the sign-in screen renders no legal links rather than dead ones |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | normally unset — read from the committed `google-services.json` |
| `EXPO_PUBLIC_DEV_BEARER_TOKEN` | must never be set outside development; the build fails if it is |
| `EXPO_PUBLIC_API_MODE` | must never be `mock` outside development; the build fails if it is |
