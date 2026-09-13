# Crash reporting, and what it is allowed to know (UC-4.4, #180)

## What a report contains

A stack trace, and four facts about the build: `app_env`, `api_mode`, `locale`,
`platform`. Nothing about the person.

`mobile/src/lib/crash.ts` is the only module that talks to Crashlytics, and it
is the enforcement point rather than a convenience wrapper:

- **`setUserId` is never called.** A test greps every `.ts`/`.tsx` file in the
  app for a call to it. Crash data is declared *not linked to you* in the App
  Store label (#178, #179), and that is a legal statement, not a preference.
- **Attributes go through an allowlist of four keys.** Anything else is
  dropped. The failure this prevents is somebody adding `user_id` or
  `last_capture` while debugging, reviewed by nobody.
- **Breadcrumbs are names of moments, not free text.** `capture_opened`, not
  "the user typed …". A free-text breadcrumb is where a commitment title ends
  up six months from now.
- **Nothing is collected in development.** A developer's own crashes are noise
  in a dashboard measuring a closed test.

## Symbols

Both uploads happen inside EAS Build, not by hand:

- **iOS dSYMs** — the `@react-native-firebase/crashlytics` config plugin adds
  the upload build phase. Confirm it ran in the EAS log, and that Crashlytics →
  Missing dSYMs is empty for the build.
- **Android mapping** — the same plugin adds the Gradle plugin, and
  `expo-build-properties` now sets `enableMinifyInReleaseBuilds`. R8 has to be
  on for a mapping file to exist at all; without it Android crashes arrive as
  obfuscated class names.

### If a dSYM is missing anyway

Download it from the EAS build page or App Store Connect, then:

```
Pods/FirebaseCrashlytics/upload-symbols \
  -gsp ios/MaybeSitter/GoogleService-Info.plist -p ios <path-to-dSYMs>
```

### JavaScript frames

Hermes frames arrive minified. `scripts/export-sourcemap.sh` writes the map for
the bundle that build embedded into `build/sourcemaps/`, which `eas.json`
collects as a **private** build artifact.

```
npx metro-symbolicate build/sourcemaps/ios.jsbundle.map < stack.txt
```

The map is per-build and is not committed. The same source at a different
commit produces a different map, and symbolicating with the wrong one gives
wrong line numbers — which is worse than none, because it looks like an answer.
Check the build number before using a map.

## Crash-free sessions

    crash_free_sessions = 1 − (fatal crashes ÷ app sessions)

per platform, per day.

- **Numerator:** Crashlytics → Crashes, filtered by platform and date.
- **Denominator:** a Cloud Logging log-based metric counting requests carrying
  `X-App-Platform`, which `mobile/src/api/client.ts` sets on every call. There
  is deliberately no analytics SDK: a header the backend already receives is
  enough, and it carries no user id, no device id, and nothing to join on —
  which is what keeps the Data safety story short.

Cross-check against Play Console → Android vitals and App Store Connect →
Crashes. Targets: **≥ 99.0%** to promote a build, **≥ 99.5%** at launch.

## What is not verified in the repository

A real crash, symbolicated, in the Crashlytics console. That needs a release
build on TestFlight or a Play closed track, which needs the store accounts
(#158). Until then the wrapper's rules are tested and the upload paths are
configured, and neither of those is evidence that a crash arrives.
