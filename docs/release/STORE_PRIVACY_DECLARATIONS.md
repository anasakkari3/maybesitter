# Store privacy declarations — drafts and the consistency matrix (UC-4.3b, #179)

> Historical baseline: 2026-09-13. Device ID and Crash data facts were
> reconciled on 2026-09-24 against `main` at `4424aa83` for #327. Other baseline
> rows and console answers below are historical drafts, **not a current,
> complete submission checklist**.

Read [the expansion delta](EXPANSION_PRIVACY_STORE_DELTA.md) and
[Clarity's operating policy](../operations/CLARITY.md), then reconcile the
actual release binary and enabled configuration before answering either store.
Those documents also have dated evidence; code and final release evidence take
precedence. Production Clarity remains disabled in `mobile/eas.json`; the SDK
is installed and its disclosure must be considered before enabling replay.

The owner approved Privacy Policy v1.1 on 2026-09-25 as the description of the
current product behavior and data practices. That policy names the FCM device
token and the unlinked Crashlytics installation record. #327 therefore keeps
both implemented types and pins the exact store declarations below. This does
not establish console availability or submission; #331 carries these answers
into the two store forms when the developer accounts exist.

---

## 1. Baseline inventory (historical except the two reconciled rows)

The non-device/non-crash rows retain the September 13 baseline. Their “no”
answers must not be reused as current answers for features added since then.

| Data | September 13 baseline / stated update | Where | Evidence |
|---|---|---|---|
| Email address | **yes** | Firebase Auth | `mobile/src/auth/` |
| Name | **yes, when the provider gives one** | Firebase Auth | Apple private relay supported; nothing is copied into Firestore |
| User ID | **yes** | Firebase Auth uid; every Firestore path | `lib/storage/paths.ts` |
| Other user content (captures, commitments, memory) | **yes** | Firestore, under the uid | `lib/storage/paths.ts` |
| Product interaction | **yes, consent-gated** | Firestore `analyticsEvents` | `lib/analytics/` |
| Approximate location | **no** | — | no location permission requested |
| Photos | **no** | — | share extension is S3 (#183) |
| Files and docs | **no** | — | S3 (#183) |
| Calendar events | **no** | — | dev-only demo (#152); real integration is S3 (#185/#186) |
| Audio | **no** | — | no speech dependency; #163 in flight |
| Device ID (FCM token and installation ID) | **yes — September 24 code reconciliation** | Account-scoped device registration | `mobile/src/notifications/pushRegistration.ts`; `src/app/api/mobile/devices/route.ts` |
| Crash data | **yes — September 24 code reconciliation** | Firebase Crashlytics | `mobile/package.json`; `mobile/firebase.json`; `mobile/src/lib/crash.ts` |

---

## 2. Device ID and Crash data reconciliation (#327)

The old “dependencies missing” premise is superseded. No collection or
manifest behavior is changed by this reconciliation.

| Type | Current code and SDK evidence | Owner-approved iOS declaration | Store follow-up |
|---|---|---|---|
| Device ID | `@react-native-firebase/messaging` is installed and configured. In API mode, `registerDeviceForPush` sends the FCM token and persistent installation ID to `/api/mobile/devices`, under the authenticated account. FirebaseMessaging's bundled privacy manifest also declares Device ID for App Functionality. Because MaybeSitter stores the registration under the signed-in uid, the app-level answer is linked even though the SDK's own manifest is not linked. | **Keep:** `DeviceID`, linked, App Functionality, tracking false | Enter the same answer in App Store Connect and “Device or other IDs” in Play Data safety under #331. |
| Crash data | Crashlytics is installed and configured. `firebase.json` enables native auto-collection; the JS initializer sets collection off in development and on otherwise. The wrapper allowlists attributes and breadcrumbs and never supplies a user id or account data. FirebaseCrashlytics' bundled privacy manifest declares Crash Data not linked, for App Functionality, with tracking false. | **Keep:** `CrashData`, not linked, App Functionality, tracking false | Enter the same answer in App Store Connect and “Crash logs” in Play Data safety under #331. |

The Crashlytics answer does not claim that the SDK creates no identifiers. It
creates Crashlytics and Firebase installation identifiers, retains associated
crash data for 90 days, and uses them to group reports. “Not linked” here means
neither the app nor the SDK attaches those reports to the MaybeSitter account
or another real-world identity. `recordError` still forwards the supplied
Error; the wrapper's content controls remain part of the release review.

Source checks: `mobile/package.json`, `mobile/app.config.ts`,
`mobile/firebase.json`, `mobile/src/lib/crash.ts`,
`mobile/src/lib/installationId.ts`,
`mobile/src/notifications/pushRegistration.ts`, and
`src/app/api/mobile/devices/route.ts`. Focused tests are
`mobile/src/lib/__tests__/crash.test.ts`,
`mobile/src/notifications/__tests__/pushRegistration.test.ts`, and
`mobile/src/config/__tests__/appConfig.test.ts`.

---

## 3. Historical Play Console draft → Data safety

**September 13 draft only.** Do not paste these answers into a console without
reconciling §2, the expansion delta, Clarity, and the release binary.

- Does your app collect or share any of the required user data types? **Yes**
- Is all of the user data collected by your app encrypted in transit? **Yes**
- Do you provide a way for users to request that their data is deleted?
  **Yes** — `https://<domain>/en/delete-account` (drafted in `site/`, §6)

| Category | Type | Collected | Required | Purpose | Shared |
|---|---|---|---|---|---|
| Personal info | Email address | yes | required | Account management | no |
| Personal info | Name | yes | optional | Account management | no |
| Personal info | User IDs | yes | required | App functionality | no |
| App activity | Other user-generated content | yes | required | App functionality | no |
| App activity | App interactions | yes | optional | Analytics | no |

**Shared with third parties: No.** Google Cloud (Firebase, Vertex AI) is a
service provider processing on our instructions, which Play excludes from
"sharing". Worth stating plainly in the review notes rather than leaving to be
inferred.

**Audio is not collected**, and will not be even after #163: the OS recognizer
processes the audio and the app receives only text.

**Current Device ID / Crash data correction:** the relevant Play types are
Device or other IDs and Crash logs. Both have implemented collection paths
(§2); they are no longer waiting for missing dependencies. Final required,
purpose, sharing, and other console answers remain for the release review.
The older Photos/Files/Calendar deferrals are not current implementation
status; consult the expansion delta and source.

## Historical Play Console draft → App content, the rest

| Item | Answer |
|---|---|
| Privacy policy URL | `https://<domain>/en/privacy` (#177) |
| App access | All or some functionality is restricted — demo credentials **in the console field only**, never in this repository |
| Ads | No |
| Content rating (IARC) | no violence, no user-to-user interaction, no location sharing |
| Target audience | 18+ |
| News app | No |
| Health, Financial, Government | none / No |
| Data deletion URL | `https://<domain>/en/delete-account` |

---

## 4. Historical App Store Connect draft → App Privacy

| Category | Type | Linked | Tracking | Purpose |
|---|---|---|---|---|
| Contact Info | Email Address | yes | no | App Functionality |
| Contact Info | Name | yes | no | App Functionality |
| Identifiers | User ID | yes | no | App Functionality |
| User Content | Other User Content | yes | no | App Functionality |
| Usage Data | Product Interaction | yes | no | App Functionality, Analytics |

**Tracking: No**, for every type. There is no ATT prompt and no tracking
domain, which the manifest already states.

Approved additions (§2): Identifiers → Device ID (linked, App Functionality)
and Diagnostics → Crash Data (not linked, App Functionality). Neither is used
for tracking.

---

## 5. Baseline consistency matrix (#179 step 7; §2 rows updated)

| Data | iOS manifest (#178) | App Store privacy label | Play Data safety | Baseline code status / stated update |
|---|---|---|---|---|
| Email | `EmailAddress`, linked | Contact Info → Email | Personal info → Email | **yes** |
| Name | `Name`, linked | Contact Info → Name | Personal info → Name | **yes** |
| User id | `UserID`, linked | Identifiers → User ID | Personal info → User IDs | **yes** |
| Captures and commitments | `OtherUserContent`, linked | User Content → Other | App activity → Other UGC | **yes** |
| Product interaction | `ProductInteraction`, linked, analytics | Usage Data → Product Interaction | App activity → App interactions | **yes, consent-gated** |
| Device id (FCM / installation) | `DeviceID`, linked, App Functionality | Identifiers → Device ID, linked, App Functionality | Device or other IDs, collected for App functionality, not shared | **yes — September 24**, §2 |
| Crash data | `CrashData`, **not linked**, App Functionality | Diagnostics → Crash Data, not linked, App Functionality | Crash logs, collected for App functionality, not shared | **yes — September 24**, §2 |
| Photos / Files | absent | absent | absent | no — S3 #183 |
| Calendar | absent | absent | absent | no — S3 #185/#186 |
| Audio | absent | absent | absent | no, and not after #163 |
| Location | absent | absent | absent | no |

This is not a complete current-binary matrix: all other rows retain the dated
baseline, including its absent/“no” entries. §2 satisfies #327's two owner
decisions; console entry and final-binary reconciliation remain under #331.

---

## 6. Historical deletion-page preparation

Drafted in `site/{en,ar,he}/delete-account.html`, with the same `{{DOMAIN}}` /
`{{SUPPORT_EMAIL}}` / `{{PRIVACY_EMAIL}}` / `{{LEGAL_NAME}}` /
`{{EFFECTIVE_DATE}}` placeholders the rest of `site/` uses, so
`site/PLACEHOLDERS.md`'s one-command replacement covers them.

It states the in-app path, the email fallback from the signed-in address within
30 days, exactly what is deleted, and — deliberately — what is **not**:
encrypted backups for up to 30 days and crash reports for up to 90 once crash
reporting exists. A deletion page that says "everything is gone" while backups
exist is the kind of accurate-sounding sentence nobody can check.

The app links to it through `accountDeletionPageUrl` (#177), which renders
nothing until a domain is configured.

---

## 7. Historical permission preparation

`android.blockedPermissions` now blocks `USE_EXACT_ALARM` and
`USE_FULL_SCREEN_INTENT` alongside `SYSTEM_ALERT_WINDOW` and the two storage
permissions. Nothing requests them, which is exactly when to block them: a
library added later can pull one into the merged manifest without a line of our
code changing, and the first anyone would hear of it is a Play policy warning
on a release build.

`SCHEDULE_EXACT_ALARM` is deliberately **not** blocked. The difference is who
decides: it asks the user and can be refused, where `USE_EXACT_ALARM` takes the
permission without asking and Play restricts it to alarm-clock and calendar
apps. If Play asks, the answer is: *"Core functionality: user-created
time-bound reminders for commitments the user confirmed."*

`src/config/__tests__/appConfig.test.ts` asserts both the block list and the
absence of every forbidden permission by name, so the failure says which one
appeared.

**Still to run:** the release-AAB audit,
`bundletool dump manifest --bundle app.aab`, which needs an EAS build and
therefore #158. The config test is the part that can run today; it checks what
*we* declare, not what the merged manifest ends up containing.

---

## 8. Remaining release gates (no console state asserted)

| Item | Required evidence / dependency |
|---|---|
| #327 decision | Complete: keep Device ID linked and Crash Data not linked; both App Functionality, tracking false. #331 owns matching console entry. |
| Submitting either declaration | Authenticated store access and completed account prerequisites (#158), current release inventory and owner-approved answers; repository text is not submission evidence |
| Public deletion/privacy URLs | Domain and published legal pages (#137 / #333); verify actual URLs, not placeholders |
| Expansion and replay declarations | Reconcile the expansion delta, Clarity policy, enabled release configuration, and archived binary; do not reuse historical feature deferrals above |
| Release permission audit | Inspect the actual release AAB and archived iOS app; source tests do not prove the final native manifests |
| Reminder device acceptance | Native behavior evidence tracked by #197; this factual document update supplies none |
