# ADR 0004 — Context Connections architecture

## Status

Accepted as an architectural constraint.

The feature it constrains — connecting external context sources (public
calendars, religious observances, prayer times, sports, school holidays, live
events, birthdays via an account, and the long tail of user-supplied feeds) —
is **deferred and evidence-gated**. This ADR grants no scope and schedules no
work. The expansion lane is recorded as deferred in
`docs/operations/EXPANSION_ORCHESTRATION_LEDGER.md`, and the follow-up
implementation issue (#594) is labelled `status: conditional` with no
milestone precisely so no lane or parallel agent picks it up. Like ADR-0002
and ADR-0003, this document must not be cited as approval to build.

## Context

MaybeSitter's value is that it plans against a person's real life. Today its
external context arrives through provider integrations
(`src/contracts/v1/integrationConnectionContracts.ts`), through user-supplied
ICS feeds (UC-3.4, #188, `lib/calendar/icsFeeds.ts`), and through one curated
sports source (the football fixtures MVP, `lib/football/`). The product
strategy wants a much wider class of temporal context — public holidays,
religious observances, prayer times, school holidays, live events, TV/film
releases, astronomy, economic events, birthdays — without writing a bespoke
pipeline per source.

That ambition has three failure modes worth fixing in a decision record
before any code exists:

1. **Category conflation.** A Google account, an ICS URL, a public holiday
   feed and an on-device sensor are four different *things*, and designs that
   start from "integrations" tend to weld each thing to one transport
   ("accounts are OAuth pulls", "devices push") and one lifecycle. Gmail alone
   falsifies the welding: it is a pull today and may become webhook/PubSub
   ingest tomorrow without becoming a different kind of connection.
2. **Truth inflation.** A Hijri holiday whose date depends on moon sighting,
   or a prayer time that is a calculation under a chosen method, is not the
   same kind of fact as a confirmed flight. Rendered without a certainty
   model, approximate and sighting-dependent dates present as absolute truth —
   in an Arabic-first product where these are often the sources that matter
   most.
3. **Commitment leakage.** The cheapest way to make a context source "useful"
   is to auto-create commitments from it. That is also the fastest way to fill
   a person's day with obligations they never made. The one place this
   codebase already does it (football fixtures → commitments, see below) is a
   deliberate, narrow product decision — not a pattern to inherit.

## Decision

### 1. Backing and transport are independent axes

Every Context Connection is described on two axes that never imply each
other:

```ts
type ContextBacking =
  | 'account'    // rides on a user-authenticated account (Google, Microsoft, …)
  | 'provider'   // a named external service needing no user account
  | 'feed'       // a user-supplied or curated URL (ICS, RSS-like)
  | 'device';    // the phone itself (sensors, on-device sources)

type ContextTransportMode =
  | 'pull'       // MaybeSitter asks on a schedule
  | 'ingest';    // the outside world pushes to us (webhook, PubSub, device callback)
```

No structural coupling is permitted: `account` does not mean "OAuth pull",
`device` does not mean "push". Gmail is the standing example — an
account-backed source that is pull today and may move to webhook/PubSub ingest
without changing its backing, its identity, or its lifecycle. A design that
bakes `account = oauth pull` into its types forces a connection-layer rewrite
the day that move happens.

### 2. Pull and ingest are separate adapter interfaces

```ts
interface PullContextAdapter {
  mode: 'pull';
  syncPolicy: SyncPolicy;
  fetch(...): Promise<NormalizedContext[]>;
}

interface IngestContextAdapter {
  mode: 'ingest';
  ingestPolicy: IngestPolicy;
  ingest(...): Promise<NormalizedContext[]>;
}
```

A fake strategy such as `device_push` inside a `syncPolicy` is forbidden: a
sync policy describes *when to ask*, and a source that is never asked has no
business inside one. Scheduling concerns live only in `SyncPolicy`; delivery,
dedup and replay concerns live only in `IngestPolicy`.

### 3. One normalized layer above both adapter kinds

```text
ContextConnection
    ↓
adapter (pull or ingest)
    ↓
NormalizedContext
    ├── TemporalOccurrence
    └── RecurringTemporalSignal
    ↓
provenance + certainty + validity
    ↓
decision/context layer
```

Consumers below the adapter boundary never see provider shapes. A
`TemporalOccurrence` is a dated thing (a holiday, a match, a release). A
`RecurringTemporalSignal` is a repeating rhythm (prayer times, a weekly
observance) whose meaning is defined by user policy, not by the source — see
clause 8.

The contracts for this layer do not exist yet and **must not be created now**.
Verified on `1f0bb01c`: nothing named `NormalizedContext`,
`TemporalOccurrence`, `RecurringTemporalSignal`, `ContextBacking` or
`ContextTransportMode` exists in the tree. When implementation opens, they
land versioned under `src/contracts/v1/`, following the existing convention.

### 4. Data validity is separate from source health

These are two different questions — *"is the data still true?"* and *"is the
pipe still working?"* — and conflating them is how fresh truth gets discarded
and stale truth gets trusted:

```ts
ContextFreshness {
  observedAt;
  validFrom?;
  validThrough?;
}

SourceHealth {
  lastAttemptAt?;
  lastSuccessAt?;
  maxSilenceMinutes?;
}
```

A failing sync must not invalidate good data, and a healthy sync must not
extend the validity of data past its nature. The standing example: a holiday
list fetched a month ago may remain valid for a year even though the last
sync is old — its validity comes from the calendar, not the pipe.

Because many providers supply no `validThrough`, the **source definition**
(not each record) must carry a default validity policy derived from the
nature of the source and its sync policy. Undefined validity is not an
acceptable steady state: it either pins data as fresh forever or makes it
vanish at the first sync gap, and both are wrong silently.

### 5. Disconnect semantics: grace never overrides a person

Operational failure degrades through:

```text
active → degraded → stale/unavailable
```

with grace, and during degradation the system may keep using the last known
context **only within its validity window** (clause 4). An expired holiday
list is dropped no matter how healthy it once was.

An explicit user disconnect is not an operational failure:

```text
→ disconnected immediately
→ context from that connection stops being active immediately
```

No grace period, no "keep showing the last data for a while". A retention
grace applied to an explicit disconnect says the system's convenience outranks
the person's instruction; that ordering is fixed here and is not negotiable.

Mapping onto today's contracts, stated exactly: `IntegrationConnectionState`
on `1f0bb01c` is `not_connected | connecting | connected | needs_reauth |
permission_limited | paused | revoked | error`. There is **no** `degraded`,
`stale` or `disconnected` member. The lifecycle above is the vocabulary the
context-connection contracts must express when they land; the existing enum
already separates operational states (`error`, `needs_reauth`,
`permission_limited` — the degraded flavors) from user-action states
(`paused`, `revoked`), which is the distinction this clause binds. This ADR
does not amend the existing enum; the reconciliation is implementation work,
not documentation.

### 6. Connections may depend on other connections

A Context Connection may be backed by an Account Connection:

```text
Google Contacts (account connection)
      ↓
Birthdays Context Connection
```

A temporary auth or provider failure on the account degrades the dependent
context source within its policy, exactly as clause 5 describes. An explicit
disconnect of the account stops the dependent source **immediately** —
birthdays derived from a contact list the person disconnected stop being
active the moment the account connection does.

Birthdays and anniversaries are **user-owned data reached through an account
dependency**, not an external public provider, and must never be modelled,
cached, re-fetched or retained as if they were a public feed. The dependency
edge is what carries that fact; a birthdays source that keeps working after
its account is gone has lost the provenance that made the data permissible.

### 7. Source types are an open set, not an enum

The design must accommodate at least:

- public holidays
- religious observances
- prayer / zmanim
- sports fixtures
- school holidays
- live events
- TV / film releases
- astronomy events
- economic events
- birthdays / anniversaries (via account dependency, clause 6)
- a user-supplied ICS URL for the long tail

This list is a starting set, and the architecture must not be an enum or a
provider registry closed to it. `ContextProviderKind` is already deliberately
open (`KnownContextProviderKind | (string & {})` in
`integrationConnectionContracts.ts`) for exactly this reason; Context
Connections inherit that openness. A source type is configuration plus an
adapter, never a schema migration.

The ICS long tail is not hypothetical: UC-3.4 (#188) already ships a
user-supplied calendar URL that is fetched every six hours through the
30-minute `ics-feed-refresh` Cloud Scheduler job, with per-feed `nextFetchAt`
due-checking, the URL stored only as a `fieldEncryption` blob, and fetches
guarded by `lib/net/safeFetch.ts`. That lane is the closest existing relative
of a Context Connection and the proof that the pull pattern below is real.

### 8. Prayer times are a RecurringTemporalSignal, not five commitments

Prayer / zmanim sources must not be modelled as five ordinary calendar items
per day, and must not become an automatic planner constraint. They enter as a
`RecurringTemporalSignal` (clause 3), and **user policy** decides what the
signal means:

- notify only
- show in context
- reserve a window
- ignore for planning

Enabling a prayer source expresses interest in the signal; it does not, by
itself, block planning around prayer times. The default for a newly enabled
source is the least invasive policy, and reserving a window is always an
explicit choice. A design in which connecting the source silently constrains
the planner turns a context feature into an imposed schedule — the exact
paternalism MaybeSitter exists to avoid.

### 9. Certainty is framework-level

Every normalized item carries:

```ts
certainty: {
  level: 'confirmed' | 'approximate' | 'subject_to_sighting';
  mayShiftByMinutes?: number;
  mayShiftByDays?: number;
  basis?: 'provider' | 'calculation_method' | 'local_authority' | 'observation';
}
```

Nothing in today's contracts expresses this (verified on `1f0bb01c`: no
`subject_to_sighting`, no certainty envelope on any context-bearing type).
Without it, a calculated Hijri date or a prayer time under one calculation
method is rendered identically to a confirmed fixture — a false claim the UI
cannot take back. `subject_to_sighting` exists because some dates are
genuinely unknowable in advance; the honest representation of such a date
includes its possible shift and the basis of the estimate. Providers that
cannot state a basis get `approximate` at best; nothing is `confirmed` by
default.

### 10. Pull scheduling rides the existing Cloud Scheduler ticks

```text
Cloud Scheduler tick
  ↓
list enabled pull connections
  ↓
isDue(syncPolicy, lastAttempt/lastSuccess)
  ↓
fetch due sources only
```

This is the deployment reality today, not a proposal: `infra/scheduler.sh`
creates OIDC-authenticated Cloud Scheduler jobs (one-minute floor) that POST
to `/api/internal/jobs/*` routes with a 60-second attempt deadline;
`lib/jobs/internalJobs.ts` runs due work inside a time budget
(`TICK_BUDGET_MS`, 45s); the ICS feed refresh (`*/30` tick, per-feed
`nextFetchAt`) and the football sync (nightly, per-club `lastSyncedAt`
least-recently-synced-first rotation inside `DEFAULT_SYNC_BUDGET_MS`) already
implement exactly the due-check and budget patterns above. Cloud Run scales
to zero and there is no worker process; **no new worker infrastructure may be
proposed for Context Connections**. A new cadence is a new `upsert_job` line
and a new internal route, in the established shape.

Ingest adapters never enter this loop. A webhook- or device-delivered source
has no `nextFetchAt` and must not acquire a synthetic one to make the
scheduler uniform — that is the clause-2 fake strategy arriving through the
back door.

### 11. Telemetry is content-free

Operational telemetry for Context Connections may carry only metadata:

- provider
- sourceType
- backing
- transport mode
- latency
- itemCount
- lastSuccessAt
- staleness
- reason / error code

and must never carry:

- occurrence titles or bodies
- event, person or merchant names
- raw provider payloads
- user-entered configuration text (a pasted ICS URL is a credential-shaped
  secret — `lib/calendar/icsFeeds.ts` already treats it as one)
- semantic provider identifiers

Any occurrence identifier in telemetry must be opaque — the same rule
ADR-0003 clause 2 sets for `WatcherSignal.subjectRef` (keyed hash or local
opaque id, never an unsalted correlatable digest). The precedent is already
mechanical there (`tests/watchers/watcherSafety.test.ts` fails if a content
field appears) and in cost attribution, which is content-free by contract;
Context Connections must ship the equivalent assertion **with** the feature,
not after it.

### 12. A Context Connection is never a Commitment; calendar is a sink

The permitted flow is:

```text
Connection
  → context
  → show / notify / constrain / propose
```

and never:

```text
Connection → auto Commitment
```

Context informs; the person commits. "Propose" means a proposal through the
existing confirmation boundary, as the ICS lane already does it (feed
deadlines become proposals the user accepts or dismisses, per-feed auto-accept
only by explicit opt-in — `lib/calendar/icsFeeds.ts`).

A calendar is an **optional sink/projection**, not a canonical store:

```text
Provider → MaybeSitter Context → optional calendar write
```

Provider → calendar → read-back is forbidden: it makes a third-party store
the source of truth for MaybeSitter's context, inverts provenance, and
couples correctness to a sync loop we do not control. ADR-0002 clause 9
applies unchanged: Context Connections ship behind `IntegrationConnectionRecord`
+ closed capability + the action gateway, and own no transport-to-write path
of their own.

**The one existing exception, recorded rather than hidden:** the football
fixtures MVP projects followed clubs' fixtures directly into commitments
(`lib/football/projectFixtures.ts`). That was a deliberate, reviewed product
decision for one curated source, with user dismissal and detach semantics
(`dismissFixtureCommitment`) and a linked-ref guard against resurrecting a
commitment the user dropped. It predates this ADR, stays as-is, and is **not
a precedent**: no Context Connection may auto-create commitments on its
strength.

### 13. Scope of this decision

This ADR is documentation only. It authorizes and accompanies:

- **no** new APIs, provider adapters, or contracts under `src/contracts/v1/`
- **no** DB collections, scheduler code, UI screens, or migrations
- **no** tests (there is nothing to test; enforcement arrives with the feature)

The only accompanying change is the deferred-lane record in
`docs/operations/EXPANSION_ORCHESTRATION_LEDGER.md` and the deferred
follow-up issue #594.

## Ownership

- Backend owns the future contracts, adapter interfaces, scheduler route and
  telemetry boundary, when and only when the lane opens.
- The orchestration ledger owns the lane's deferred status; reopening is an
  owner decision recorded there and on #594, never an inference from "the
  ADR is merged".
- ADR-0002 clause 9 and ADR-0001 rule 3 bind this feature exactly as they
  bind every other integration; nothing here relaxes them.

## Consequences

### What is already in our favour

The pull scheduler, due-check, budget, OIDC guard and 60-second deadline are
deployed and proven (`infra/scheduler.sh`, `lib/jobs/internalJobs.ts`). The
ICS lane is a working prototype of a user-supplied feed with encrypted-URL
storage, SSRF-guarded fetch, proposal-not-commitment semantics and per-feed
auto-accept opt-in. The connection record, open provider kind and provenance
shapes already exist. ADR-0002 and ADR-0003 established the "constraint now,
build later" posture this ADR continues, and ADR-0003's gate 2 (one provider
proven end to end) binds this feature too: as of `1f0bb01c` only Gmail has a
production transport, it is read-only, and it still has no OAuth callback
route — see the provider status table in the ledger.

### Non-goals, deferred rather than designed away

No provider adapters, no normalized-context contracts, no webhook receiver,
no settings UI, no source catalogue, no prayer-time or holiday source. None
of these are designed away; all are gated.

### Enforcement, stated honestly

Today every clause is enforced by review — deliberately, because the only
code this ADR permits is none. When the lane opens, the following must become
mechanical with the feature, on the source-scanning precedent of
`tests/contract/intelligenceModuleBoundaries.test.ts` and the literal-allowlist
precedent of `tests/watchers/watcherSafety.test.ts`:

1. a contract test that no normalized-context type carries content fields into
   telemetry types (clause 11);
2. a test that no pull-scheduled source lacks a real `SyncPolicy` and no
   ingest source appears in the pull loop (clauses 2 and 10);
3. a test that disconnect of an account connection immediately deactivates
   dependent context sources (clauses 5 and 6).

Writing these tests before the feature would test nothing; skipping them
after it would leave the binding clauses as prose.

## Migration and rollback

Documentation only. No contract change, no stored state, no data migration,
nothing to roll back. Superseding this decision means writing ADR-0005, not
deleting this file.
