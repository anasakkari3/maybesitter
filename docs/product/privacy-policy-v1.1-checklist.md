# Privacy policy v1.1 — factual draft checklist (#177, #333)

**DRAFT — not owner/legal approval or publication evidence.** Reconciled on
2026-09-25 against the implementation at `3f64a8ca`. The site policy and deletion
pages are v1.1 drafts with `{{EFFECTIVE_DATE}}` unresolved. Arabic and Hebrew
changes in this draft require review; native Hebrew approval is still pending.
The earlier permission-copy approval does not approve these policy drafts.

Repository implementation, enabled release configuration and deployed evidence
are distinct. Do not describe an installed dependency or implemented adapter as
proof that its provider connection is enabled or verified for production.

## Current implementation facts

| Area | Source-backed fact | Evidence / publication boundary |
| --- | --- | --- |
| Authentication | Firebase email/password, Google and Apple sign-in are implemented. Auth identity includes provider identifiers and Firebase UID. | `mobile/src/auth/`; `lib/auth/mobileAuth.ts`. Verify actual provider configuration for the release. |
| Capture and sharing | Capture proposals are stored before confirmation, with expiry metadata. Confirmation creates the commitment; it is not the first persistence of any data. | `lib/services/captureBoundary/proposalStore.ts`; `mobile/src/features/share/shareIntentBridge.tsx`. Do not promise “nothing is saved until confirmation.” |
| Cloud AI | Production deployment configuration sets the model provider to `none`; staging selects Gemini. Model requests are consent-gated. Deterministic capture fallback runs on the server, not exclusively on the phone. | `infra/cloudrun/flags.sh`; `lib/llm/captureProvider.ts`. Configuration is not proof of the current deployed revision. Reconcile enabled features and payloads before publication; do not claim consent withdrawal makes all processing on-device. |
| Speech | Native speech recognition is implemented, initiated through the capture voice flow. The OS recognition service may process speech online. | `expo-speech-recognition` in `mobile/package.json`; `mobile/src/features/capture/voice/expoSpeechCaptureService.ts`. Do not promise exclusively on-device recognition. |
| Device calendar | Native calendar read/write and busy-time sync are implemented. Native events enter local memory; titles/details are filtered out before busy intervals are uploaded. | `mobile/src/features/calendar/deviceCalendar.ts`; `busyBlocks.ts`; `lib/calendar/busyBlocks.ts`. Say what leaves the device, not that the app never reads event objects. |
| Google Calendar | A development verification demo exists; its scopes and reachability must not be generalized to every production calendar connection. | `mobile/src/features/calendarDemo/README.md`, `scopes.ts`. Reconcile the selected release's provider route and enabled integrations separately. |
| Push notifications | FCM messaging is installed. Device registration sends a token, installation ID and permission state under the signed-in account. | `mobile/src/notifications/pushRegistration.ts`; `src/app/api/mobile/devices/route.ts`. Registration also reports denied permission. |
| Widgets | Native widget code exists; it is not merely a reserved analytics event. | `mobile/targets/widget/`; `react-native-android-widget` in `mobile/package.json`. Native release verification remains separate. |
| Crash reporting | Crashlytics is installed; native auto-collection is configured, and JS collection is disabled in development and enabled otherwise. The app wrapper does not call `setUserId`. | `mobile/firebase.json`; `mobile/src/lib/crash.ts`. Absence of `setUserId` does not prove anonymity or establish SDK linkage/retention. See the owner review boundary in `docs/release/STORE_PRIVACY_DECLARATIONS.md`. |
| Analytics | Product analytics consent is separate from replay consent; content is excluded by the fixed event contract. | `lib/analytics/`; `mobile/src/clarity/`. Do not describe account-linked events as anonymous. |
| Other implemented flows | Health/readiness, imported context and provider adapters must be reconciled against the actual enabled release, not omitted because an old checklist called them future work. | `docs/release/EXPANSION_PRIVACY_STORE_DELTA.md` is a dated inventory, not proof that every adapter is live. Confirm native permissions, credentials, payloads and reachability for the release. |

## Microsoft Clarity — production remains disabled

`mobile/eas.json` sets `EXPO_PUBLIC_CLARITY_ENABLED=false` for production.
Enabled builds require a **separate, session-only opt-in**; analytics consent
never grants replay consent. Cold launch, sign-out and account change reset the
choice. SDK device/session identifiers still exist; do not promise anonymity.

The masking policy is Strict, all text/images masked, with WebView capture off.
The runtime pauses excluded routes and stops future capture on revocation.
Account deletion does **not** invoke deletion of previously uploaded Clarity
recordings. See `docs/operations/CLARITY.md` and `mobile/src/clarity/`.

**Before any enabled production release:** the owner must decide and publish
Clarity retention and the deletion-request process, reconcile store declarations,
and attach applicable native replay evidence. This draft invents neither a
retention period nor an operator SLA. Historical notes in the operating document
are SHA-scoped and are not a current pass or failure for every later build.

## Deletion and retention

The in-app account-delete flow and a static, no-install deletion-instructions
page exist. The web page explains an email request; it is not a web deletion
API. Publishing, mailbox availability and request handling need separate evidence.

`lib/account/accountDeletion.ts` deletes the account tree and Auth account and
records external revocation outcomes. A failed external revocation is recorded;
it must not be described as guaranteed success merely because account deletion
completed. `docs/operations/ACCOUNT_DELETION.md` describes operator recovery.

Two retained records must be disclosed alongside backup/crash handling:

- Deletion receipt: **configured expiry after 400 days**; contains a keyed
  subject hash and receipt/step metadata, not raw UID/email/content.
- Deletion job: **configured expiry after 30 days**; the raw UID is removed
  from the completed record; the keyed subject hash remains.

These are expiry settings (`RECEIPT_RETENTION_MS`, `JOB_RETENTION_MS`), not proof
of an exact runtime purge deadline. `infra/firestore-ttl.sh` declares TTL setup;
verify deployed policies before making a purge-time promise. Read-only production
inspection on 2026-09-25 found receipt TTL active but **no accountDeletions TTL
policy**. The owner must resolve that operational gap before publication; this
draft does not authorize enabling a TTL policy. The same inspection found a
seven-day PITR window, no configured backup schedules and 30-day retention for
the default log bucket. Firebase’s [published retention information](https://firebase.google.com/support/privacy), checked on 2026-09-25, states that Crashlytics retains crash data and associated identifiers for 90 days **before removal begins** from live and backup systems. This is not a guarantee of completed removal by day 90. The account-deletion implementation does not delete Crashlytics reports; store linkage declarations still require release-specific review.
Incomplete/stuck deletion jobs can retain the UID for resumption. Early-access
website registrations are separate records, not automatically removed by an
app-account deletion.
Do not equate a pseudonymous receipt with “no data retained.”

## Links, version and remaining owner decisions

- Sign-in, Settings legal links and Trust privacy link are implemented;
  `mobile/src/features/settings/TrustScreen.tsx` renders the Trust link when
  a valid configured legal URL exists. The deletion-instructions HTML exists
  in all three locales. Their deployment must be checked separately.
- Domain and contact tokens were filled in #648. Both aliases passed internal
  delivery checks in Workspace recipient logs. On 2026-09-25 the owner explicitly
  accepted human responsibility for monitoring both addresses and handling support,
  privacy and account/data deletion requests. This is an operational commitment,
  not automated handling or a newly agreed response deadline. The effective date
  remains unresolved, and publication still needs separate approval.
- Approve final enabled-release disclosures and v1.1 effective date; determine
  the notice process for policy/terms changes. Do not promise an automatic
  in-app notice or next-sign-in notice without implementing/operating it.
- Verify SDK retention/linkage, backup/log retention and deployed TTL policies.
- Finish Clarity retention/deletion decisions before enabling production replay.
- Obtain legal/owner review and native Hebrew review, and reconcile the store
  console forms. This checklist supplies implementation facts, not legal advice
  or an approval of any data category, purpose, linkage flag or console answer.

The older future-flow table was removed because its absence claims for speech,
device calendar, share, FCM, widgets and Crashlytics no longer match the code.
