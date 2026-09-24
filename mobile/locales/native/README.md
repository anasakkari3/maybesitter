# iOS system strings, in the languages the app speaks (UC-4.1, #176)

Expo's top-level `locales` config writes an `InfoPlist.strings` file per
language at prebuild. iOS then shows the permission prompt in the device's
language rather than in English.

## Why the name is not translated

`CFBundleDisplayName` is `MaybeSitter` in all three. The brand is one word in
Latin script everywhere — #176 step 1 — and a home-screen label that changes
with the device language is a different app to the person looking for it.
Localized descriptors belong in the store subtitle, not under the icon.

## Why every string names the concrete use

Apple rejects vague purpose strings, and more to the point a vague one is the
only sentence most people will ever read about what the microphone is for.
Each says exactly when the thing happens and what leaves the device — the
speech string distinguishes system speech processing (which may use the
internet) from MaybeSitter servers, which do not receive the audio.

English stays in `ios.infoPlist` and in the `expo-speech-recognition` plugin
options; these two files override it per language.

## Adding one

A new `NS*UsageDescription` anywhere in the config has to appear in both files.
`appConfig.test.ts` asserts it: a permission prompt that falls back to English
is the kind of thing nobody notices until a reviewer in Tel Aviv does.

## Approval status (#325)

- **Arabic: approved by the owner on 2026-09-25.** The owner explicitly accepted
  the exact Arabic microphone, speech recognition, HealthKit and both calendar
  usage descriptions. These describe tap-to-dictate, possible online system
  recognition, a stored readiness summary and no calendar-title upload when
  reading busy time. No runtime behavior or permission scope changed.
- **Hebrew: draft, awaiting native-speaker review and owner approval.** The
  revised draft mirrors those facts and avoids a gendered instruction to the
  reader. Do not treat automated validation as linguistic approval.
- English is the factual reference aligned with the approved Arabic meaning.

The outstanding Hebrew approval must be recorded before a store build is
submitted. Do not remove this remaining gate until the review actually occurs.
