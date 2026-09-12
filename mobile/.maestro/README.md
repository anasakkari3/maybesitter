# Maestro flows

`smoke.yaml` is the "does the app actually start" check. It launches the app,
asserts the Arabic Today and capture labels are on screen, switches to the
calendar tab and back.

## Run it

Maestro drives an installed build, not the Metro bundler, so install a build
first:

```bash
# iOS simulator or Android emulator with a development build installed
maestro test .maestro/smoke.yaml
```

With a development build, start Metro in another terminal (`npm start`) so the
JS bundle is served.

## Why the assertions are Arabic

Arabic is the default language (`src/i18n/strings.ts`), so a fresh install shows
Arabic labels. If the build is misconfigured, the CFG-1 screen appears instead
of the app and these assertions fail — which is the point.

## `auth-gate.yaml`

UC-1.7 (#151)'s claim, on a device: a fresh install lands on sign-in, and
`openLink maybesitter://today` while signed out still lands on sign-in rather
than the app. It then opens the email flow and comes back.

Run it against a build with `EXPO_PUBLIC_DEV_BEARER_TOKEN` **unset**. With the
local override active the app starts signed in, which is correct behaviour and
not what this flow is testing.

```bash
maestro test .maestro/auth-gate.yaml
```
