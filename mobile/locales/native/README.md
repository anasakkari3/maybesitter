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
speech string in particular says the audio never reaches us, because that is
the fact somebody granting the permission is actually deciding about.

English stays in `ios.infoPlist` and in the `expo-speech-recognition` plugin
options; these two files override it per language.

## Adding one

A new `NS*UsageDescription` anywhere in the config has to appear in both files.
`appConfig.test.ts` asserts it: a permission prompt that falls back to English
is the kind of thing nobody notices until a reviewer in Tel Aviv does.

The Arabic and Hebrew here are drafts. The owner approves them before a build
goes to a store — a permission string is a promise, and a machine translation
of a promise is not one.
