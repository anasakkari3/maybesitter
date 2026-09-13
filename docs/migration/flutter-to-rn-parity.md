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
| `/onboarding` | `src/features/onboarding/` (welcome · consent · routine · notifications), composed into `AuthGate`'s `onboarding` slot | In flight (#171) |
| `/today` | `src/screens/TodayScreen.tsx` | In flight (#173) — screen exists, on seed data |
| `/upcoming` | Upcoming list | In flight (#173) |
| `/activity` | — | **Dropped.** The activity log was a pilot-era debugging surface. Its user-facing half is feedback history under Settings (#174); the rest was operator telemetry that belongs in the console, not the app. |
| `/settings` | `src/screens/SettingsScreen.tsx` | In flight (#174) |
| `/settings/appearance` | Settings → Appearance (theme), already wired | Shipped |
| `/settings/pilot-feedback` | — | **Dropped.** The closed pilot's feedback form. The launch equivalent is the alpha-feedback flag (`src/api/endpoints/feedback.ts`) plus feedback history (#174). |
| `/settings/privacy` | Settings → Privacy | In flight (#174), links in #177 |
| `/settings/privacy/feedback-history` | Feedback history + revoke | In flight (#174) |
| `/settings/notifications` | Notification education row (deep-link to OS settings only) | In flight (#174); the permission request itself is S3 reminders |
| `/settings/routine` | `RoutineStep` in `mode='settings'` — the same five questions as onboarding | In flight (#171 builds it, #174 mounts it) |
| `/settings/trust` | Trust centre | In flight (#174) |
| `/settings/trust/knows` | "What MaybeSitter knows", incl. the Memory section | In flight (#174 screen, #167 memory) |
| `/capture` | `src/screens/CaptureScreen.tsx` | In flight (#172) |
| `/capture/review` | `src/screens/ReviewScreen.tsx` | In flight (#172, #164) |
| `/capture/clarification` | Clarification sheet | In flight (#172) |
| `/capture/success` | `src/screens/SavedScreen.tsx` (with undo) | In flight (#172) |
| `/commitments/:id` | `src/screens/DetailsScreen.tsx` | In flight (#173) |

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
| `android/.../AndroidManifest.xml:12` — `RecognitionService` query for dictation | Voice capture | In flight (#163) |
| `android/.../MainActivity.kt` — deep links | Expo Linking | Shipped |
| `macos/**` | — | **Dropped.** The macOS target was Flutter scaffolding that was never built or shipped. |

## What guards this

`scripts/check-no-flutter.sh`, run by `tests/meta/noFlutter.test.ts` in
`npm test`, fails if any Flutter artefact is tracked under `mobile/`, if
`mobile/` stops being the Expo app, or if a second client appears at
`mobile-rn/`. That is the invariant #175 exists to protect, and it is checked on
every run rather than remembered.
