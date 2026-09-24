# Mobile session replay

Project: [MaybeSitter / ymeq5r7uc6](https://clarity.microsoft.com/projects/view/ymeq5r7uc6/settings).
React Native SDK pinned to **4.9.1** (iOS Clarity **4.1.1**). The app already
targets iOS 16.4. Native autolinking is sufficient; do not add a second native
initialization or a web tracking script. Expo Go does not support this SDK.

## Consent and lifetime

`EXPO_PUBLIC_CLARITY_ENABLED=true` exposes a separate, optional replay switch in
onboarding and Settings → Trust. Existing analytics consent does **not** grant
replay consent. The native SDK is loaded/initialized only after replay opt-in,
in a signed-in foreground app on iOS/Android.

Consent is **session-only**, held in memory for the current account. A cold
launch, sign-out, account deletion or account change starts off. This choice
avoids reviving a grant from stale storage after a failed revocation write.
Backgrounding pauses capture; returning to the foreground retains that
session's answer. Granting again starts a new Clarity session. Withdrawal calls
both `pause()` and `consent(false, false)` immediately, and late startup/resume
callbacks re-check the current decision. Advertising consent is never granted.

The switch stops future collection; it does not delete recordings already
uploaded. The app does not retain session URLs or send Firebase IDs, names,
emails, entity IDs, free text, tokens, query strings or API payloads to Clarity.
Clarity still creates its own SDK identifiers and device/session metadata;
this is pseudonymous telemetry, not a promise of anonymity. Deleting the
MaybeSitter account does not invoke a Clarity deletion API. Operator handling
of replay deletion/retention belongs in the published privacy notice.

## Masking matrix — strict-v1

The dashboard is part of the integration. `testID` alone does **not** mask
anything. React Native has no Clarity `maskView` API or screen masking rule;
the native SDK applies project-level Strict and element-ID rules.

| Surface / content | Policy |
| --- | --- |
| Navigation, controls, onboarding structure, settings structure | Record layout and taps after opt-in; even static text stays masked |
| Goal/commitment titles, routine answers, learned facts | Mask all text and images |
| Capture, AI Context Import, assistant, email/calendar/PDF context | Mask all text and images, including inputs, reviews, dialogs and toasts |
| Account, deletion/reauthentication, readiness, financial context, dev calendar demo | Pause capture; Strict remains the fallback during native transitions |
| Signed-out/auth/loading state | No opt-in can apply; pause on account boundary |
| In-app browser / WebView | Dashboard WebView capture disabled |
| New/unknown route | Deny until added to the typed route policy |

Dashboard settings applied and visibly verified on 2026-09-24:

- Masking mode: **Strict**.
- Native element `#clarity-private-root`: **Mask**, with no unmask exceptions.
  This non-collapsible ID is on the gesture root; Strict also covers native
  modals outside that subtree.
- WebView capture: **Off**.
- Upload network: Wi-Fi (existing default retained).

Masking changes may take up to an hour to propagate and are not retroactive.
Never relax masking to make recordings easier to read. Use stable screen names
instead. Do not add unmask rules to general `Txt`, card, button or list
components: these also render user content.

## Screen names and events

All routes come from `src/clarity/policy.ts`. Nested stages distinguish
`capture_input/review/saved`, `goal_list/detail/generating/review/confirming/saved`,
`ai_import_pick/handoff/paste/reading/review/saving/done`, and onboarding steps.
No title, date, ID or free-form parameter becomes a screen name.

Seven custom tags: `flow`, `locale` (`ar/en/he`), `theme`, `environment`,
`platform`, `privacy=strict-v1`, `client=react_native`. No inferred diagnosis or
unverified `pilot=true` label. Five fixed success events: `capture_saved`,
`goal_confirmed`, `ai_import_confirmed`, `daily_plan_accepted`,
`onboarding_completed`. These have no properties and use replay consent.

## Builds and verification

Staging enables the replay **offer**. Production remains build-disabled until
native replay QA is complete; then set its EAS profile's
`EXPO_PUBLIC_CLARITY_ENABLED` to `true`. The user must still opt in individually.
For a local development build, set the same flag before starting Metro/building.
An OTA update cannot add the missing native SDK: rebuild the binary.

Before enabling production, use synthetic data on iOS and Android to verify:

1. Cold launch and declined consent: no SDK initialization or recording.
2. Opt in; navigate Capture → Review → Confirm, goals, plan and AI import.
3. Inspect the uploaded replay: synthetic sentinel text, images, accessibility
   labels and keyboard content must not be readable. Check sheets/dialogs too.
4. Revoke, background, sign out, change account and relaunch; verify no recording
   without the applicable current-session opt-in. Re-grant creates a new session.
5. Check screen/stage names and success events; no dynamic identifiers or text.

Unit tests cover consent/startup/resume races, metadata allowlists, native
failure, account isolation, nested stage selection and the accessible toggle.
They cannot prove native masking or uploaded replays. Record device evidence
against the exact commit/build, following `evidence/UAT-EVIDENCE-INDEX.md`.

Implementation verification on 2026-09-24:

- Mobile Jest: 223 suites / 2,938 tests passed, including the replay tests.
  The suite reported a worker teardown/open-timer warning after passing.
- Mobile TypeScript, changed-code ESLint, `git diff --check`, and the privacy
  manifest check passed.
- iOS prebuild, CocoaPods and Xcode Debug simulator build passed with Clarity
  4.1.1 linked. On a dedicated iOS 26.5 simulator with synthetic development
  identity, the Arabic switch was off initially, accepted an explicit opt-in,
  and was off after terminating/relaunching the app. No real account was used.
- This is a **limited native smoke check**, not a replay privacy PASS. The
  local fixture backend did not complete the onboarding consent fetch. No
  uploaded replay was available in Clarity during the check, and no Android
  device run was performed. Production remains disabled for those reasons.
- UI review used the existing Card/Txt tokens and native accessible switch;
  RTL copy and checked state were inspected on the simulator. Full scrolled
  visual/large-text and VoiceOver checks remain part of device QA.

The iOS app manifest adds Other Usage Data / Analytics (not linked), matching
the installed Clarity 4.1.1 manifest. Its required-reason APIs are already
covered by the app. Product Interaction / Analytics already exists. Update
published privacy disclosures and store data declarations for optional
Microsoft session replay before shipping an enabled production build.

Sources: [RN installation](https://learn.microsoft.com/en-us/clarity/mobile-sdk/react-native-sdk),
[masking](https://learn.microsoft.com/en-us/clarity/mobile-sdk/clarity-sdk-masking),
[iOS consent API](https://learn.microsoft.com/en-us/clarity/mobile-sdk/ios-sdk#consent),
and the installed SDK source and privacy manifest.
