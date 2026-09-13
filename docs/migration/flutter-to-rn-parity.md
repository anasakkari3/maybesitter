# Flutter → React Native parity (UC-2.R5, #175)

The Flutter client is retired. Its last complete state is the tag
`archive/flutter-final`; `docs/migration/flutter-archived-commits.md` maps the
*commits* that were archived rather than merged. This file maps the *surface* —
every route the Flutter app had and every native piece it shipped — to where
that behaviour lives now, or to the issue that owns it.

It exists so that "did anything get lost in the switch?" is a question with a
written answer rather than a memory.

## How to read the status column

- **Shipped** — the behaviour exists in `mobile/` on `main` today.
- **In flight (#n)** — an S2 issue owns it and is not closed.
- **S3** — deliberately deferred; the issue is named.
- **Dropped** — deliberately not carried over, with the reason.

Nothing is unaccounted for. A row with no issue and no reason would be the
defect this table is for.

## Routes

`archive/flutter-final:mobile/lib/app/router.dart`

| Flutter route | React Native | Status |
|---|---|---|
| `/onboarding` | `src/features/onboarding/` (welcome · consent · routine · notifications), composed into `AuthGate`'s `onboarding` slot | Shipped (#171, merged #286) |
| `/today` | `src/screens/TodayScreen.tsx` | Shipped (#173, merged #303 · #308 · #313 · #318) |
| `/upcoming` | Upcoming list | Shipped (#173, merged #303) |
| `/activity` | — | **Dropped.** The activity log was a pilot-era debugging surface. Its user-facing half is feedback history under Settings (#174); the rest was operator telemetry that belongs in the console, not the app. |
| `/settings` | `src/screens/SettingsScreen.tsx` | Shipped (#174, merged #297 · #318) |
| `/settings/appearance` | Settings → Appearance (theme); the choice is kept in device storage | Shipped (#155; persistence added in S2 closure) |
| `/settings/pilot-feedback` | — | **Dropped.** The closed pilot's feedback form. The launch equivalent is the alpha-feedback flag (`src/api/endpoints/feedback.ts`) plus feedback history (#174). |
| `/settings/privacy` | Settings → Privacy | Shipped (#174, merged #297). The legal links render only once a domain exists (#177) |
| `/settings/privacy/feedback-history` | Feedback history + revoke | Shipped (#174, merged #297 · #318) |
| `/settings/notifications` | Notification education row (deep-link to OS settings only) | Shipped (#174, merged #297); the permission request itself is S3 reminders |
| `/settings/routine` | `src/features/settings/RoutineSettingsScreen.tsx`, reusing `RoutineStep` — the same five questions as onboarding | Shipped (#171 built it, merged #286; #174 mounted it, merged #297) |
| `/settings/trust` | `src/features/settings/TrustScreen.tsx` | Shipped (#174, merged #297) |
| `/settings/trust/knows` | `src/features/settings/KnowsScreen.tsx`, incl. the Memory section | Shipped (#174 screen, merged #297; #167 memory) |
| `/capture` | `src/screens/CaptureScreen.tsx` | Shipped (#172, merged #315) |
| `/capture/review` | `src/screens/ReviewScreen.tsx` | Shipped (#172, merged #315; edits #164) |
| `/capture/clarification` | Clarification sheet | Shipped (#172, merged #315; the question builder is #165) |
| `/capture/success` | `src/screens/SavedScreen.tsx` (with undo) | Shipped (#172, merged #315) |
| `/commitments/:id` | `src/screens/DetailsScreen.tsx` | Shipped (#173, merged #305) |

The pilot-token gate (`pilot_access_screen.dart`) has no RN route on purpose:
Firebase sign-in replaced it in UC-1.1–1.3 (#145–#147). Only its 403 state
messages carried over, for the revoked / deleted / not-allowlisted cases.

## Native pieces

| Flutter | React Native | Status |
|---|---|---|
| `ios/MaybeSitterWidgets/MaybeSitterWidgets.swift` — home-screen widget | — | **S3.** No S2 issue; the widget analytics events (`widget_impression`, `widget_tap`, `widget_snapshot_published`) are still in the contract awaiting it. |
| `ios/Runner/AppDelegate.swift:36` — calendar bridge | `src/features/calendarDemo/` is a dev-only verification demo (#152); the real integration is **S3**. | S3 |
| `ios/Runner/PilotDeepLinkPlugin.swift` | `src/links.ts` + Expo Linking (`maybesitter://`) | Shipped |
| `ios/Runner/PilotPresenceSharedStorePlugin.swift` — app-group shared store for the widget | — | **S3**, with the widget. |
| `android/.../AndroidManifest.xml:15` — `PROCESS_TEXT` share intent | — | **S3.** Sharing selected text into capture; no S2 issue. |
| `android/.../AndroidManifest.xml:12` — `RecognitionService` query for dictation | Voice capture; `expo-speech-recognition` adds `RECORD_AUDIO` and the `<queries>` entry (`mobile/app.config.ts:339`) | Shipped (#163, merged #317) |
| `android/.../MainActivity.kt` — deep links | Expo Linking | Shipped |
| `macos/**` | — | **Dropped.** The macOS target was Flutter scaffolding that was never built or shipped. |

## What guards this

`scripts/check-no-flutter.sh`, run by `tests/meta/noFlutter.test.ts` in
`npm test`, fails if any Flutter artefact is tracked under `mobile/`, if
`mobile/` stops being the Expo app, or if a second client appears at
`mobile-rn/`. That is the invariant #175 exists to protect, and it is checked on
every run rather than remembered.
