# Expansion privacy and store declaration delta

Updated: 2026-09-17

This document records the declaration changes implied by the expansion
program. It supplements `STORE_PRIVACY_DECLARATIONS.md`; Git and the cited
implementation files remain authoritative.

Nothing in this document means that an App Store, Play Console, Google OAuth,
Microsoft Entra, provider, or RevenueCat console form has been submitted.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `MERGED` | The repository behavior is on `main` and covered by automated tests. |
| `WIRING PENDING` | The provider-independent or native module exists, but shared app configuration is still owned by another active lane. |
| `OWNER ACTION` | A console, legal, billing, domain, or credential action cannot be completed from this repository. |
| `DEVICE VERIFY` | A physical-device permission, purchase, restore, or revocation flow remains to be exercised. |
| `CREDENTIAL VERIFY` | The adapter is implemented, but a real provider account and approved OAuth application are required for a live smoke test. |

## Implemented data inventory

| Provider or feature | Data accessed | Repository handling boundary | Current status | External follow-up |
| --- | --- | --- | --- | --- |
| HealthKit | Sleep analysis, resting heart rate, heart-rate variability (SDNN), and step totals | The local Expo module reads a bounded window and returns summaries. Raw `HKSample` objects are not persisted. The backend stores only the normalized readiness projection and provenance. | Native bridge and adapter `MERGED`; app entitlement and usage-description wiring `WIRING PENDING` while PR #460 owns `mobile/app.config.ts`. | `OWNER ACTION`: Apple health-data privacy answers and review notes. `DEVICE VERIFY`: permission, read, denial, stale data, and Settings-based revocation. |
| Health Connect | Sleep sessions, resting heart rate, heart-rate variability (RMSSD), and step totals | The local module returns bounded aggregates/latest values and keeps no local cursor, token, or sample cache. Only normalized readiness and provenance cross the backend boundary. | Native bridge, permissions manifest, and adapter `MERGED`; shared app configuration `WIRING PENDING` while PR #460 and mobile package owners are active. | `OWNER ACTION`: Play Health Connect declaration and data-access justification. `DEVICE VERIFY`: install, permission, read, revoke, and reconnect. |
| WHOOP | Profile identity, recovery, sleep, and cycle/strain context | OAuth scopes are limited to `read:profile`, `read:recovery`, `read:sleep`, and `read:cycles`. Provider readings normalize into the canonical readiness model; explicit current user energy remains authoritative. | Backend lifecycle, sync planning, normalization, provenance, and disconnect behavior `MERGED`. | `OWNER ACTION`: WHOOP application credentials and redirect configuration. `CREDENTIAL VERIFY`: token refresh, revoke, and live sync. |
| Gmail | Message sender, subject, text, timestamps, thread/message identifiers, and Gmail history cursor when mail context is enabled | Mail is untrusted external content. A mailbox mirror is forbidden; only derived proposals and provenance may persist. Message content cannot execute actions. Read, compose, and send scopes are capability-selected rather than requested together. | Adapter, incremental sync, cursor handling, prompt-injection boundary, dedupe, and disconnect request `MERGED`. | `OWNER ACTION`: Google OAuth consent screen, sensitive-scope verification if required, credentials, and privacy-policy URLs. `CREDENTIAL VERIFY`: incremental sync and revocation. |
| Microsoft Graph | Outlook mail context, calendar busy intervals, and Microsoft To Do task fields for enabled capabilities | Mail is untrusted external content. Calendar titles are dropped from planning context. Tasks normalize into the canonical external-task model. Delta cursors remain opaque to the adapter. | Scope selection, normalization, cursor handling, and disconnect request `MERGED`. | `OWNER ACTION`: Entra app registration, redirect URIs, publisher/consent configuration, and credentials. `CREDENTIAL VERIFY`: mail/calendar/task delta sync and revocation. |
| Todoist | Task title, description, due/completion state, provider IDs/URL, update time, and sync token | Tasks normalize into the canonical external-task model. Provider writes require the canonical action gateway; ambiguous objects are not silently merged. | Adapter, sync normalization, dedupe, mutation planning, and disconnect request `MERGED`. | `OWNER ACTION`: Todoist application credentials. `CREDENTIAL VERIFY`: full/incremental sync, mutation, revoke, and reconnect. |
| Notion | Only user-selected page/database task fields: title, notes, due/completion state, IDs/URL, and update time | Whole-workspace crawling is forbidden. Reads and writes are constrained to the explicit selection; writes require the action gateway. | Selected-target adapter, normalization, mutation planning, and disconnect request `MERGED`. | `OWNER ACTION`: Notion integration credentials and user-visible selection setup. `CREDENTIAL VERIFY`: selected database/page sync and revocation. |
| RescueTime | Aggregate productive/distracting/neutral minutes for a bounded window | Raw application history and URL history are rejected. No medical or emotional inference is allowed. The planner receives only provider-independent focus context. | Aggregate adapter, data guard, UserState projection, and disconnect request `MERGED`. | `OWNER ACTION`: RescueTime credentials. `CREDENTIAL VERIFY`: aggregate sync and revocation. |
| Meeting intelligence | Transcript segments supplied by an enabled meeting adapter | A transcript is untrusted context, is not persisted by this boundary, and can create only a proposal. Canonical commitment creation requires explicit confirmation. | Provider-independent transcript normalization and proposal boundary `MERGED`. | `OWNER ACTION`: select and configure a meeting provider. `CREDENTIAL VERIFY`: provider fetch and deletion behavior. |
| RevenueCat | Entitlement state only; no receipt or transaction-history persistence in the planned projection | Entitlements gate features without deleting user data when access lapses. Raw purchase material stays behind the provider boundary. | Domain implementation is in PR #452; SDK, native configuration, restore, and server verification are not on `main`. | `OWNER ACTION`: products, offerings, webhook/server credentials, App Store and Play billing setup. `DEVICE VERIFY`: purchase, restore, grace/offline, expiration, and account transfer. |

## OAuth and credential boundary

All connected providers use the canonical connection model. Connection records
may contain provider identity, scopes, status, sync cursor, timestamps, and an
encrypted credential reference. Access and refresh tokens cross only the
`ProviderCredentialVault` port and must not enter connection records, logs,
analytics, sync results, exports, or error messages.

Disconnect operations must revoke the provider credential where supported,
delete the vault credential, mark the connection revoked, and stop future
sync. A provider-side revocation that cannot be completed must fail closed and
surface reauthentication rather than continuing with stale authority.

Evidence:

- `lib/integrations/providers/providerRuntime.ts`
- `src/contracts/v1/integrationConnectionContracts.ts`
- `lib/integrations/connections/connectionRegistry.ts`

## Export and deletion delta

| Data class | Export requirement | Deletion/disconnect requirement |
| --- | --- | --- |
| Connection metadata | Include provider, status, granted scopes, connected/last-sync timestamps, and non-secret provenance. Never export token material or vault references. | Revoke provider access where available, delete the vault secret, delete or tombstone the connection according to the canonical account-deletion path, and stop sync. |
| Readiness | Export the user-visible normalized readiness/energy projection and source/freshness metadata, not raw native health samples. | Delete stored readiness projections with the account. HealthKit permission is revoked by the user in iOS Settings; Health Connect supports app-initiated permission revocation. |
| Mail and meetings | Export persisted proposals/provenance only if present in canonical user data. Do not imply that an external mailbox or meeting-provider copy is deleted. | Delete derived MaybeSitter context and the connection. Provider-owned source content remains subject to that provider's controls. |
| External tasks | Export canonical links, provider identity, external ID, sync/link state, and user-owned canonical task data. | Disconnecting removes MaybeSitter credentials and sync authority; deleting a MaybeSitter account must not silently delete provider-owned tasks unless the user separately confirms that external action. |
| RescueTime | Export only the aggregate context retained by MaybeSitter. | Delete aggregates and connection metadata; no raw app/URL history should exist in MaybeSitter storage. |
| Entitlements | Export current entitlement status and timestamps if retained. Exclude receipts and transaction payloads. | A lapse or disconnect removes access, not user data. Account deletion removes the MaybeSitter projection; provider/store records follow their legal retention rules. |

## Analytics and observability declaration

Generic analytics and tracing may contain provider, feature, operation, model,
latency, token counts, estimated cost, result class, safe error category, sync
counts, and pseudonymous scope identifiers.

They must not contain mail subject/body, transcript text, raw HealthKit or
Health Connect values, WHOOP payloads, task/note titles, OAuth tokens, purchase
receipts, private memory text, or provider response bodies. Any new telemetry
sink must have an allowlist or explicit redaction tests before release.

## App Store owner checklist

- Add the HealthKit entitlement and the final user-facing read usage
  description only after the `mobile/app.config.ts` ownership boundary clears.
- Declare health data types actually read by the shipped binary. Do not claim
  medical diagnosis, treatment, or that a wearable overrides the user.
- Reconcile App Privacy labels with the final binary for calendar, connected
  mail/task context, health, identifiers, diagnostics, and purchases.
- Configure subscription products and RevenueCat only after pricing, legal
  entity, agreements, tax, and banking details are owner-approved.
- Provide review notes and a test account that do not expose credentials in the
  repository.

## Play Console owner checklist

- Complete the Health Connect declaration with the exact read permissions in
  the shipped manifest and a readiness/planning purpose explanation.
- Reconcile Data Safety answers with the final binary for calendar, connected
  mail/task context, health, identifiers, diagnostics, and purchases.
- Complete subscription products and RevenueCat setup after the owner approves
  pricing and merchant configuration.
- Audit the release AAB with `bundletool dump manifest`; source manifests and
  TypeScript tests do not prove the final merged manifest.

## Provider-console owner checklist

- Google: consent screen, approved Gmail scopes, redirect URIs, domain and
  privacy-policy verification, test/production publishing status, and client
  credentials.
- Microsoft: Entra registration, redirect URIs, delegated permissions,
  publisher verification where required, tenant policy, and client
  credentials.
- WHOOP, Todoist, Notion, RescueTime, and the selected meeting provider:
  application registration, least-privilege scopes, redirect URIs, production
  access, and credentials.
- Rotate or revoke every credential used for manual verification after a test
  account is retired.

## Release evidence still required

The repository can verify type safety, policy boundaries, redaction, provider
normalization, native compilation, and generated configuration. It cannot
truthfully claim the following without external state:

- App Store, Play Console, OAuth, provider, or RevenueCat form submission.
- HealthKit or Health Connect permission/read/revocation on a physical device.
- Live provider token refresh, rate-limit, stale-cursor, revoke, and reconnect.
- RevenueCat purchase, restore, grace/offline, lapse, and cross-device refresh.
- Final release-AAB and archived-iOS-app privacy/permission inspection.
