# Sprint 03 — Feedback Events: Design

Date: 2026-08-18
Issues: [#13](https://github.com/anasakkari3/maybesitter/issues/13), [#14](https://github.com/anasakkari3/maybesitter/issues/14), [#15](https://github.com/anasakkari3/maybesitter/issues/15)

## Context

Sprint 03 turns behavioural outcomes into an append-only event log, derives explainable aggregates
from it, and gives the user a way to see and correct what the system learned.

Unlike Sprint 02, this sprint is **not greenfield**. `lib/services/behaviorFeedbackService.ts`
already records outcomes today, six modules consume it, and its data is live. The design is shaped
more by that constraint than by anything else.

### What already exists

- `lib/services/behaviorFeedbackService.ts` — five counters per scope
  (`ignoredSuggestions`, `completedActions`, `delayedActions`, `clarificationSuccesses`,
  `clarificationFailures`) plus a single scope-level `updatedAt`. **There are no per-event
  timestamps**, which is why Sprint 02 derived `recentOutcomes` from `DomainState` instead.
- `lib/services/agendaActionService.ts:101-107` — the live emission point. `done`, `postpone`, and
  `skip` call `recordBehaviorFeedback` at the moment the action is applied.
- Consumers of the counters: `adaptiveService`, `pressureService`, `agendaService`,
  `agendaActionService`, `captureService`, and their tests.
- `lib/services/mobile/participantState.ts:163` — `replayOrRecordParticipantDecision`, the
  established idempotency pattern (key + fingerprint, replay rather than re-apply).
- Sprint 02: `projectLifeState` (pure, explicit `now`, digest-verified replay) and the runtime
  memory store (revocation distinct from deletion). Both are precedents this sprint follows.
- `mobile/lib/features/settings/privacy_screen.dart` — the natural host for a history view. Two of
  its switches are wired to `onChanged: (_) {}` and its "Delete all data" button shows a
  confirmation without deleting anything.

### Scope decisions (agreed 2026-08-18)

1. **Migration keeps the old counters as a frozen historical baseline.** They are never converted
   into synthetic events. A counter carries no timestamps, so manufacturing per-event times would
   invent history that did not happen and would place every fabricated event at one instant,
   corrupting exactly the windowed aggregates this sprint exists to produce.
2. **`undo` and `revoke` are different things.** `undo` is a behaviour the user performed;
   `revoke` is the user correcting our record of them.
3. **New events are dual-written** alongside the existing `recordBehaviorFeedback` calls. The six
   current consumers are not migrated in this sprint.
4. **The inert privacy controls are in scope.** A button that reports "data cleared" without
   clearing data is a false claim, and #15's "no dark-pattern confirmation" criterion covers it.

## Architecture

| Component | Path | Owner |
|---|---|---|
| Shared contract | `src/contracts/v1/feedbackContracts.ts` | written first, before parallel work |
| Event store | `lib/feedback/feedbackEventStore.ts` | #13 |
| Migration baseline | `lib/feedback/baselineMigration.ts` | #13 |
| Aggregation | `lib/feedback/feedbackAggregation.ts` | #14 |
| Backfill/replay CLI | `scripts/feedback-replay.ts` | #14 |
| History + revoke API | `src/app/api/mobile/feedback/**` | #15 |
| History + undo UI | `mobile/lib/features/settings/**` | #15 |

## Component 1 — Feedback events (#13)

```ts
export type FeedbackOutcome =
  | 'accept' | 'edit' | 'reject' | 'defer' | 'complete' | 'ignore' | 'undo';

export type FeedbackActor = 'user' | 'system';

export type FeedbackSource =
  | 'mobile_action'        // the user acted in the app
  | 'scheduler'            // a deadline passed without action
  | 'migration_baseline';  // pre-event-log history; see below

export interface FeedbackEvent {
  readonly version: typeof FEEDBACK_EVENT_SCHEMA_VERSION;
  readonly id: string;
  readonly scopeId: string;
  readonly outcome: FeedbackOutcome;
  /** The commitment or proposal this outcome concerns. */
  readonly subjectId: string;
  readonly actor: FeedbackActor;
  readonly source: FeedbackSource;
  /** When the behaviour happened. Aggregation windows key off this. */
  readonly occurredAt: string;
  /** When we stored it. Later than occurredAt for a late-arriving event. */
  readonly recordedAt: string;
  /** Deterministic; a repeat append with the same key is a no-op. */
  readonly idempotencyKey: string;
  /**
   * Set when the user revokes the event as mistaken. The event is never
   * deleted or rewritten — it leaves future aggregates but stays visible in
   * history, so the user can see what was corrected.
   */
  readonly revokedAt?: string;
}
```

### Acceptance criteria → mechanisms

| Criterion | Mechanism |
|---|---|
| Repeated submissions do not double count | `idempotencyKey`, derived deterministically from `scopeId + subjectId + outcome + occurredAt`. `append()` returns the existing event unchanged when the key is already present, following `replayOrRecordParticipantDecision`. A test appends the same event twice and asserts one record and one aggregate contribution. |
| Events never silently edit commitments | The store imports no writer (`commandService`, `deterministicStateGateway`, `src/server/dataStore`), enforced by a boundary test over the transitive import closure, as in `tests/lifeState/lifeStateBoundaries.test.ts`. |
| Actor, source, and timestamp are present | Non-optional on the type; validated at append; a record missing any of them cannot be constructed. |

Append-only means the log is never rewritten in place: `revoke` stamps `revokedAt`, and a reversal
of behaviour is a **new** `undo` event. Nothing is deleted except by a scope-level user deletion.

### Migration baseline

One record per scope, holding the five legacy counters verbatim:

```ts
export interface FeedbackBaseline {
  readonly version: typeof FEEDBACK_EVENT_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly counters: Readonly<Record<LegacyCounterName, number>>;
  /** The legacy scope-level updatedAt, the only time information that exists. */
  readonly lastUpdatedAt: string | null;
  /**
   * Always true. Stated in the data, not only in prose, so no consumer can
   * mistake the baseline for something that can be placed in a time window.
   */
  readonly timestampsUnavailable: true;
}
```

The baseline contributes to **lifetime totals only** and is excluded from every windowed view. It is
written once, never updated, and never expanded into events.

### Dual-write

`agendaActionService.ts:101-107` gains a `FeedbackEvent` append beside each existing
`recordBehaviorFeedback` call — `done → complete`, `postpone → defer`, `skip → ignore`. The counter
calls stay. No existing consumer changes behaviour in this sprint, so the event log can be verified
against a working system before anything depends on it.

## Component 2 — Aggregation (#14)

```ts
export function aggregateFeedback(input: FeedbackAggregationInput): FeedbackAggregates;

export interface FeedbackAggregationInput {
  readonly events: readonly FeedbackEvent[];
  readonly baseline: FeedbackBaseline | null;
  readonly scopeId: string;
  readonly now: string;        // explicit; the function never reads the clock
  readonly windowDays?: number;
}
```

A pure function, matching `projectLifeState`: deterministic, replayable, digest-verifiable.

| Criterion | Mechanism |
|---|---|
| Aggregates replay deterministically | Pure function over a sorted event list; an `inputDigest` over the canonicalized input (reusing `lib/evaluation/registry/fingerprint`) lets a replay prove input equality. Same-input-twice and key-reshuffle tests, as in Sprint 02. |
| Late events are handled | Windows key off `occurredAt`, never `recordedAt`, so an event that arrives late still lands in the window where it belongs. Both timestamps are retained, so lateness is measurable rather than silently absorbed. |
| Raw history remains authoritative | Aggregates are recomputed from events on every call and never persisted as a source of truth, so they cannot drift from the log. The backfill CLI writes a **reconciliation report**, not a cached aggregate. |

Revoked events (`revokedAt` set) are excluded from every aggregate. This is the coupling to #15, and
it is the one behaviour a cross-track integration test must cover.

`windowDays` defaults to **14**, matching `DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS` from Sprint 02, and
is exported as a named constant so the two windows stay visibly aligned rather than coincidentally
equal.

Per-user and global views share one implementation; the global view is the per-user one over an
unfiltered event set, so the two cannot diverge in their windowing or revocation rules. The global
view returns **counts only, never `subjectId`, `scopeId`, or any per-event row** — an aggregate
across users must not become a way to read one user's history. A test asserts the global result
carries no scope-identifying field.

## Component 3 — Transparency and undo (#15)

### `undo` versus `revoke`

These are deliberately different operations, and conflating them is the central risk in this issue:

- **`undo`** — the user reversed a real action (un-completed a task). It is a genuine behavioural
  outcome, so it appends a new `undo` event and the original stays.
- **`revoke`** — the user is correcting our record ("you misread me; do not learn from this"). It
  stamps `revokedAt` on the original event, which then leaves all future aggregates while remaining
  visible in history.

Implementing `revoke` as an appended `undo` would record the user's correction of our mistake as a
behaviour we then learn from — the opposite of what they asked for.

### Deliverables

- **Feedback history view/API** — `GET /api/mobile/feedback/history` returns the scope's events
  newest-first with their revocation state; a Flutter screen renders it.
- **Undo/revoke interaction** — `POST /api/mobile/feedback/{id}/revoke`, surfaced per row.
- **Copy distinguishing observation from saved preference** — rows read as *"we observed you
  deferred this"*, never *"you prefer deferring"*. An observation is a fact about one moment; a
  preference is a claim about the person, and the product must not silently promote one to the
  other.

### Acceptance criteria

| Criterion | Mechanism |
|---|---|
| Revocation affects future aggregates | Enforced by the cross-track integration test: revoke through the real API, then recompute the real aggregate and assert the contribution is gone. |
| No dark-pattern confirmation | Revoke is single-step with a plain-language label and an undoable snackbar; no pre-checked boxes, no asymmetric styling pushing the user to keep data. Also, the existing inert controls in `privacy_screen.dart` are fixed: the two switches become functional, and "Delete all data" either deletes or stops claiming it did. |
| Accessibility and localization | Localized in `app_ar` / `app_en` / `app_he`; semantics labels on interactive rows; RTL verified on simulator, not only in widget tests. |

## Testing

Repo conventions: `node:test` + `node:assert/strict`, flat `test(...)`, `.ts` extensions in test
imports, and **new test files must be registered in `package.json`** — handled centrally at merge
time, not by the parallel agents.

Two verification steps are explicitly not delegated to the per-track agents:

1. **Cross-track integration test.** In Sprint 02, 91 tests passed while three modules disagreed,
   because one track's fixtures were never executed against another track's implementation. #15's
   revoke and #14's aggregation are coupled by an acceptance criterion, so that pairing is tested
   directly.
2. **Simulator verification.** Sprint 02 had no UI. Lane A found four defects on the simulator that
   the widget tests did not catch, so #15's screens are driven on a real simulator with screenshots,
   including RTL.

## Execution plan

1. Write and commit `src/contracts/v1/feedbackContracts.ts` — the shared surface all three issues
   coordinate through.
2. Three parallel agents in isolated worktrees on disjoint directories: #13 → `lib/feedback/` (store
   + baseline), #14 → aggregation + CLI, #15 → API + mobile UI.
3. Merge; wire `package.json`, the `moduleContracts.ts` `feedback` entry, and the
   `agendaActionService` dual-write centrally.
4. Cross-track integration test; simulator run for the UI.
5. Security review (revocation, deletion, scope isolation) and code review.
6. Full verification, then PR.

## Non-goals

- Migrating the six existing counter consumers to read from the new aggregates (deliberately
  deferred; dual-write keeps both alive).
- Expanding baseline counters into synthetic events.
- Using feedback to change ranking or recommendations — Sprints 04-05 own that.
- Any model or LLM involvement; every outcome here is deterministic.
- Direct model writes to canonical user state.

## Risks

- **Dual-write divergence.** Two records of the same outcome can drift if one write fails.
  Mitigation: both writes happen at the same call site with the event append last, so a failure
  leaves the legacy counter authoritative and the event log short — recoverable by replay — rather
  than the reverse.
- **`clarificationSucceeded`/`clarificationFailed` have no `FeedbackOutcome` counterpart.** They are
  capture-quality signals, not commitment outcomes. Mitigation: they stay in the baseline counters
  and are not forced into the new vocabulary; if they need events later, that is a contract change
  with its own review.
- **Fixing `privacy_screen.dart` touches a file outside the feedback feature.** Mitigation: the
  change is confined to making existing controls honest, adds no new product surface, and ships with
  widget tests plus simulator verification.
