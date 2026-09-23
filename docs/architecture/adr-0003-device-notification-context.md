# ADR 0003 — Device notification signals enter as a watcher source, content-free, Android only

## Status

Accepted as an architectural constraint.

The feature it constrains — reading Android notifications as life context — is
**deferred and gated**. This ADR grants no scope and schedules no work. It
exists so that when the feature is eventually built it is one observer plus one
native module, rather than a new top-level concept with its own privacy story.
Like ADR-0002, it must not be cited as approval to build.

## Context

The proposal: on Android, `NotificationListenerService` lets an app receive
callbacks for notifications posted by *other* apps once the person grants
"Notification access" in system settings. That is the fastest contextual signal
that exists on a phone — a gate change, a cancelled class, a delivery shift
starting in thirty minutes, a package arriving today — and it covers dozens of
services MaybeSitter will never write an adapter for.

iOS has no equivalent and this ADR does not pretend otherwise.
`UNNotificationServiceExtension` processes *your own* app's notifications; the
accessory-notification APIs are for companion hardware. The platforms are
asymmetric and the product must say so rather than inventing parity.

The architectural question is not "can we read them". It is: notifications
carry OTPs, bank balances, private messages, health results and people's names.
Where does that data stop?

## Decision

### 1. It is a watcher source, not a new concept

A device notification enters through `WatcherSignalObserver`
(`lib/watchers/signals.ts`), alongside `readinessObserver` and
`fixtureObserver`. It is not a new pipeline, not a new scheduler, and not a new
storage lane. `runWatcherSweep` already runs every minute, already dedupes by
`docIdForKey(watcherId, signalId)`, and already gates every effect through
`evaluateActionPolicy`.

Provider identity reuses what exists: `ContextProviderKind` is deliberately
open, and `IntegrationConnectionProvenance` already allows
`{ source: 'native', connectedBy: 'user' }` — the same shape Health Connect
uses. One new member of the closed `IntegrationCapability` union
(`device_notification_read`) is required; nothing else in the contracts moves.

### 2. The signal is content-free. This is not negotiable

`WatcherSignal` carries `signalId`, `provider`, `signalKind`, `subjectRef`,
`observedAt`, `stateDigest`, `provenanceRef` and `measures[]`, and nothing
else. `tests/watchers/watcherSafety.test.ts` asserts the contract never grows
`payload`, `rawBody`, `providerResponse`, `title` or `body`.

A `summary: string` on the signal — a short human-readable line describing what
the notification said — is exactly the field that test forbids, and the
original proposal contained one. It does not ship. Classification happens on
the device; what crosses the boundary is a kind and a digest.

`signalKind` is drawn from a closed vocabulary: `schedule_change`, `deadline`,
`delivery`, `travel`, `event_update`. There is no `other` — an unclassifiable
notification produces no signal at all, because "other" is how raw content
eventually finds a way across.

`subjectRef` must be an **opaque per-user identifier**: a keyed hash/HMAC under
a per-user secret, or a locally generated opaque id. It must not be a globally
stable unsalted hash of package name plus notification key. An unsalted digest
is correlatable across accounts and leaks which apps a person has installed,
which is precisely the inference this design exists to prevent.

### 3. Two lanes, and a source picks one

- **Content-free signal** → the watcher lane above. Background, no
  confirmation, no text.
- **Text the person confirms** → a proposal through
  `lib/services/captureBoundary/captureBoundaryService.ts`, mirroring
  `src/app/api/mobile/capture/share/route.ts`, with
  `lib/integrations/providers/untrustedExternalContent.ts` applied.

There is no third lane in which background-harvested text becomes a commitment
without a person reading it. If a notification's *words* are ever needed, a
human sees them and says yes.

### 4. A notification is an observation, never truth

"Your flight may be delayed" is not a `Commitment` and not a memory fact. It is
an observation whose only permitted effect is the watcher effect set
(`notify`, `replan_if_impacted`, `propose_commitment`, `update_context`).
`WATCHER_POLICY.directPlannerCallsAllowed` stays `false` and
`providerWriteCapabilitiesAllowed` stays `false`.

Observations expire. The proposal's `{confidence, expiresAt}` semantics do not
exist on any current type — `confidence` lives on readiness, `expiresAt` on
recommendations and proposals — so whichever record holds a pending
notification observation must carry its own expiry and be swept, on the
`lib/recommendation` expiry precedent. A stale signal is worse than no signal.

### 5. Allow-list by default-deny, and never `QUERY_ALL_PACKAGES`

The person chooses which apps may be read, per app. Messaging, banking,
authenticator/password-manager and health categories are **off by default** and
must be turned on explicitly, one at a time.

Enumerating installed apps to populate that list would require package
visibility, and `QUERY_ALL_PACKAGES` *is* on Play's restricted-permission list
and needs a declaration. So it is never requested. The allow-list is populated
only from packages that have actually posted a notification since access was
granted. A person sees the apps that are talking, not an inventory of their
phone.

### 6. Data safety wording, stated exactly

Notification access is **not** itself a Play restricted permission — there is
no declaration form, unlike SMS/Call Log, package visibility or the
Accessibility API. It falls under the general User Data policy: prominent
disclosure, consent, and use limited to the purpose the person agreed to.

The Data safety entry and the in-app disclosure must say this, and only this:

> Raw notification content — title, body, and any text — is classified on the
> device and never leaves it. Derived, content-free signal metadata may be
> transmitted, solely for the declared MaybeSitter feature purpose.

Nobody may write, in this repo or in a store listing, that nothing
notification-derived is transmitted. That would be false the moment a signal
reaches the watcher sweep, and a false privacy claim is worse than an honest
uncomfortable one.

### 7. It is never part of onboarding

The entry point is `Settings → Sources`
(`mobile/src/features/settings/SourcesScreen.tsx` — "the things that can put
commitments into a day on their own"), behind an explicit explanation shown
*before* the system settings screen opens. It is never requested during
onboarding and never bundled into another permission prompt.

## Ownership

Mobile owns the native module and the disclosure surface. Backend owns the
observer, the capability entry and the expiry sweep. Neither may widen the
signal shape without amending clause 2 here and the assertion in
`tests/watchers/watcherSafety.test.ts` that backs it.

## The gate

This feature does not start until **all three** conditions hold:

1. **A real consumer of `PlanningStateChange`.** — **Already satisfied** as of
   `3082bf0d`. `lib/planning/replan/impactEvaluator.ts` and
   `continuousReplanPipeline.ts` consume normalized changes;
   `lib/services/dailyPlan/continuousReplanService.ts` lists the
   `PLANNING_STATE_CHANGES` collection and is wired through
   `lib/jobs/internalJobs.ts` to `/api/internal/jobs/replan`, scheduled every
   five minutes by `infra/scheduler.sh:142`. Recorded here because an earlier
   reading of a stale branch concluded the opposite, and the correction matters:
   a notification signal would now land somewhere that reads it.
2. **One provider proven end to end.** Gmail is the only integration with real
   transport (`lib/integrations/gmail/production/gmailTransport.ts`); every
   other adapter under `lib/integrations/*/adapter.ts` is a normalizer with no
   way to fetch anything. Until one external source demonstrably moves a
   person's day, a second source adds supply to a pipeline with no proven
   demand — and most of what notifications carry (flights, deliveries, banking)
   also arrives by email, which Gmail can already reach.
3. **An Android device or emulator verification capability.** There is no
   Android job in CI — the `mobile` job in `.github/workflows/ci.yml` runs
   `tsc`, `expo lint` and Jest only — and both Android scripts
   (`mobile/scripts/check-android-manifest-merge.sh`,
   `verify-release-android.sh`) are run by hand. Health Connect's own Android
   device permission verification is still outstanding in this ledger. A
   `NotificationListenerService` is invisible to Jest: it can only be proven on
   a running Android device. Shipping it without that capability would mean
   "merged" carries no evidence at all.

Condition 1 holds. Conditions 2 and 3 do not. The feature stays blocked.

## Consequences

### What is already in our favour

The native pattern exists and compiles today:
`mobile/modules/health-connect-readiness/` is an Android-only Kotlin Expo
module for a sensitive, opt-in, user-granted source with its own manifest and
permission flow; `mobile/modules/exact-alarm/` deep-links into a system
settings page; `mobile/plugins/withAndroidFixups.js` and
`withDataExtractionRules.js` write manifest and resource entries, which is the
only way to add native Android surface given that `mobile/android` is CNG
output and untracked. `lib/integrations/readiness/nativeAdapterContracts.ts`
already declares `rawPayloadPersisted: false` for a device-local source.

### Non-goals, deferred rather than designed away

Nothing on iOS. No cross-platform abstraction pretending the two agree. No raw
notification persistence, on device or server. No `other` signal kind. No
marketplace of notification rules.

### Enforcement, stated honestly

Clause 2 is mechanical: `tests/watchers/watcherSafety.test.ts` already fails if
a text field appears on `WatcherSignal`, and its literal `ALLOWED` import array
means a new observer cannot even be added without a reviewer seeing the import.
The rest — default-off categories, the disclosure wording, never requesting
package visibility — is enforced by review, and must become a test with the
feature rather than after it.

## Migration and rollback

Documentation only. No contract change, no stored state, no data migration,
nothing to roll back.
