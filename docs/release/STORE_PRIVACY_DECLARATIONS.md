# Store privacy declarations — drafts and the consistency matrix (UC-4.3b, #179)

**Neither console exists** (#158 is owner/paid-deferred), so nothing here has
been submitted. These are the answers to give, worked out against what the code
actually does, plus the comparison #179 step 7 asks for.

Verified against `main` on 2026-09-13. Every "not implemented" below was
checked, not assumed.

---

## 1. What the app actually collects today

The only honest starting point. A declaration is a claim about the code, and
these are the claims the code supports right now.

| Data | Collected today? | Where | Evidence |
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
| Device ID (FCM token) | **no** | — | **no messaging dependency in `mobile/package.json`** |
| Crash data | **no** | — | **no Crashlytics dependency; #180 open** |

---

## 2. A discrepancy with the iOS privacy manifest (#178)

`mobile/app.config.ts` currently declares two `NSPrivacyCollectedDataTypes`
that the app does not collect:

- `NSPrivacyCollectedDataTypeDeviceID`, commented "The FCM registration token"
- `NSPrivacyCollectedDataTypeCrashData`, for Crashlytics

Neither dependency is installed, and #180 is open.

This is worth naming rather than working around, because **#178's own file
makes the argument**: it deliberately omits the `1C8F.1` App-Group reason on
the grounds that *"declaring a reason the app does not use would be
over-declaring, which is the same kind of inaccuracy as under-declaring."* The
same reasoning applies to a collected-data type for a dependency that is not
there.

It is not urgent and it is not a rejection risk. It matters because #179's
labels must equal the manifest, and #177's policy checklist says these flows do
not exist — so as things stand the three documents cannot all be true.

**Two ways to make them agree, and this is Agent A's call, not ours:**

1. Remove both types from the manifest now, and add each back in the PR that
   adds its dependency (#180 for crash data, S3 #194 for the FCM token). This
   is what the `1C8F.1` decision implies.
2. Keep them, on the grounds that the manifest ships with the binary and both
   land before the store submission — and say so in the file, so the next
   reader does not take it for an error.

The matrix in section 5 marks both rows **pending reconciliation** and must be
re-read once #180 merges. Nothing here changes `app.config.ts`'s manifest:
#178 owns it.

---

## 3. Play Console → App content → Data safety

**Only the rows that are true today.** Rows for S3 features are listed at the
end, to be added with the feature and not before — a Data safety form that
over-declares invites questions nobody can answer yet.

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

**To add with their features, not before:** Photos and Files (S3 #183,
*processed ephemerally*) · Calendar events (S3 #185/#186) · Device or other IDs
(S3 #194, the FCM token) · Crash logs and diagnostics (#180, not linked).

## Play Console → App content, the rest

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

## 4. App Store Connect → App Privacy

| Category | Type | Linked | Tracking | Purpose |
|---|---|---|---|---|
| Contact Info | Email Address | yes | no | App Functionality |
| Contact Info | Name | yes | no | App Functionality |
| Identifiers | User ID | yes | no | App Functionality |
| User Content | Other User Content | yes | no | App Functionality |
| Usage Data | Product Interaction | yes | no | App Functionality, Analytics |

**Tracking: No**, for every type. There is no ATT prompt and no tracking
domain, which the manifest already states.

Pending reconciliation (§2): Identifiers → Device ID, and Diagnostics → Crash
Data (**not linked**).

---

## 5. The consistency matrix (#179 step 7)

| Data | iOS manifest (#178) | App Store privacy label | Play Data safety | In the code today |
|---|---|---|---|---|
| Email | `EmailAddress`, linked | Contact Info → Email | Personal info → Email | **yes** |
| Name | `Name`, linked | Contact Info → Name | Personal info → Name | **yes** |
| User id | `UserID`, linked | Identifiers → User ID | Personal info → User IDs | **yes** |
| Captures and commitments | `OtherUserContent`, linked | User Content → Other | App activity → Other UGC | **yes** |
| Product interaction | `ProductInteraction`, linked, analytics | Usage Data → Product Interaction | App activity → App interactions | **yes, consent-gated** |
| Device id (FCM) | `DeviceID`, linked | *pending* | *pending* | **no** — pending reconciliation, §2 |
| Crash data | `CrashData`, **not linked** | *pending* | *pending* | **no** — pending reconciliation, §2 |
| Photos / Files | absent | absent | absent | no — S3 #183 |
| Calendar | absent | absent | absent | no — S3 #185/#186 |
| Audio | absent | absent | absent | no, and not after #163 |
| Location | absent | absent | absent | no |

The five implemented rows agree across all three columns today. The two pending
rows are the whole of §2.

---

## 6. The deletion page

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

## 7. Permissions

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

## 8. What is blocked, and on what

| Item | Blocker |
|---|---|
| Submitting either declaration | **#158** — neither console exists |
| The deletion URL returning 200 | **#137** — no domain |
| Device ID and Crash data rows | **#180** — and §2's reconciliation |
| Photos, Files, Calendar rows | **S3** #183, #185, #186 |
| Release-AAB permission audit | **#158** — needs an EAS build |
| Android 14 exact-alarm-denied acceptance | **S3 #197** |
