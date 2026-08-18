# Sprint 02 — Life-State & Memory: Design

Date: 2026-08-18
Issues: [#9](https://github.com/anasakkari3/maybesitter/issues/9), [#10](https://github.com/anasakkari3/maybesitter/issues/10), [#11](https://github.com/anasakkari3/maybesitter/issues/11)

## Context

Sprint 02 is the first module of the Core Intelligence roadmap. `src/contracts/v1/moduleContracts.ts`
already declares `lifeState` and `memory` modules with non-operative placeholders
(`status: 'not_implemented_in_sprint_00'`) explicitly awaiting this sprint. This design replaces
those placeholders with real implementations.

The three issues are designed to run in parallel and state: "Coordinate only through the contracts
named in this issue." The contracts are therefore written and committed first, before any parallel
work begins.

### What already exists (do not duplicate)

- `src/domain/stateMachine.ts` — `DomainState { commitments, reminders, escalationStates }`, the
  canonical reducer. Written **only** through `lib/services/commandService.ts`, reached by
  intelligence modules via `lib/services/deterministicStateGateway.ts`.
- `lib/services/domainAppSnapshotAdapter.ts` — the one existing projection, `DomainState` → legacy
  `AppSnapshot`. Serves the legacy web UI; unrelated to LifeState.
- `lib/services/adaptiveService.ts` — `deriveAdaptiveSignals(state, opts)`, a pure mini-projection
  computing completion rate, delay frequency, ignored counts. **LifeState subsumes this** rather
  than duplicating it.
- `lib/services/agendaService.ts` + `lib/utils/agendaScoring.ts` — urgency scoring over commitments.
  The closest existing source for a "load" signal.
- `src/domain/memory/` — canonical `CommitmentMemory` and `Observation` stores. `MemoryKind` already
  declares `fact | preference | hypothesis`, but `EnabledMemoryKind` restricts runtime use to
  `observation | commitment`. **Sprint 02's memory store covers the three disabled kinds** and does
  not modify these existing stores.
- `lib/alphaTrace/alphaTraceStore.ts`, `lib/alphaFeedback/alphaFeedbackStore.ts` — the newest store
  convention: `createFileX({ dataDir, retentionTtlMs })` + `createInMemoryX()`, one file per record,
  `prune()`, `deleteParticipant()`. The memory store follows this.
- `tests/quality/scenarios/alphaQualityScenarios.ts` + `lib/quality/alphaQualityHarness.ts` — the
  established multilingual fixture-corpus format and report generator. Fixtures follow this.
- `lib/evaluation/registry/validationPrimitives.ts` — `IssueCollector`, `isIsoTimestamp`,
  `isNonEmptyString`, etc. The fixture validator reuses these.

### Scope decisions (agreed 2026-08-18)

1. **Availability** derives from existing commitments only. There is no inbound calendar ingestion in
   the repo (the calendar is outbound-only ICS), and building one is out of scope.
2. **Recent outcomes** derive from `DomainState` only. `lib/services/behaviorFeedbackService.ts`
   stores counters without per-event timestamps, so it cannot support a time window; upgrading it
   belongs to Sprint 03 (#13).
3. **Memory store is new and separate**, covering `fact | preference | hypothesis`. Existing
   canonical stores are untouched.
4. **Fine-tuning exclusion is a tagging + guard-function mechanism**, not a speculative exporter. No
   export pipeline exists in the repo today.

## Architecture

| Component | Path | Owner issue |
|---|---|---|
| LifeState contract | `src/contracts/v1/lifeStateContracts.ts` | shared (written first) |
| Memory contract | `src/contracts/v1/memoryContracts.ts` | shared (written first) |
| LifeState projection | `lib/lifeState/**` | #9 |
| Runtime memory store | `lib/runtimeMemory/**` | #10 |
| Fixtures + validator + coverage | `tests/fixtures/**`, `lib/lifeState/fixtureValidator.ts` | #11 |

`lib/runtimeMemory/` is deliberately **not** named `lib/memory/`, to stay clearly distinct from the
existing canonical `src/domain/memory/`.

## Component 1 — LifeState projection (#9)

### Unknown as a first-class value

Acceptance criterion: "Unknown is distinct from false or empty." Every projected field is wrapped:

```ts
export type UnknownReason =
  | 'NO_DATA'             // nothing in DomainState to derive from
  | 'INSUFFICIENT_DATA'   // data exists but is below a meaningful threshold
  | 'NOT_IMPLEMENTED';    // deliberately deferred to a later sprint

export interface FieldProvenance {
  source: 'domain_state' | 'deterministic_rule' | 'absent';
  derivedFrom: string | null;   // ISO timestamp of the newest contributing input
  computedAt: string;           // ISO timestamp of this projection run
}

export type Field<T> =
  | { known: true;  value: T;               provenance: FieldProvenance }
  | { known: false; reason: UnknownReason;  provenance: FieldProvenance };
```

Zero open commitments is `{ known: true, value: 0 }`. Nothing to project from is
`{ known: false, reason: 'NO_DATA' }`. The two are unconfusable by construction. This wrapper also
satisfies deliverable "Freshness and source metadata on every field" — provenance is not optional.

### Shape

```ts
export const LIFE_STATE_SCHEMA_VERSION = 'v1' as const;

export interface LifeState {
  version: typeof LIFE_STATE_SCHEMA_VERSION;
  scopeId: string;
  computedAt: string;
  inputDigest: string;
  commitments: Field<CommitmentsView>;
  availability: Field<AvailabilityView>;
  load: Field<LoadView>;
  recentOutcomes: Field<RecentOutcomesView>;
}
```

- `CommitmentsView` — counts by status, open items with due info, overdue set.
- `AvailabilityView` — busy windows derived from scheduled commitments' `timeSpec`. Per scope
  decision 1, absence of a commitment means "no known commitment", **not** "free"; the view models
  busy windows only and never asserts free time.
- `LoadView` — derived from agenda urgency scores plus open/overdue counts.
- `RecentOutcomesView` — completion/ignore/postpone outcomes within a window, derived from ack states
  and reminder statuses (both timestamped in `DomainState`).

### Determinism and replayability

```ts
export interface LifeStateInput {
  state: DomainState;
  now: string;          // ISO; the projection never calls Date.now()
  scopeId: string;
  windowDays?: number;  // recentOutcomes lookback; defaults to 14
}

export function projectLifeState(input: LifeStateInput): LifeState;
```

`windowDays` defaults to **14**. The default is exported as a named constant
(`DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS`) from the contract so it is visible to consumers and testable,
rather than being an inline literal.

A pure function. `computedAt` is taken from `input.now`, never from the system clock, so identical
input yields byte-identical output. `inputDigest` is a sha256 over the canonicalized input, letting a
replay prove it matched the original inputs.

"No model-generated value becomes canonical state" holds by construction: the projection reads
`DomainState` (itself writable only through the deterministic command path) and writes nothing. A
boundary test asserts `lib/lifeState/**` imports no writer module (`commandService`,
`deterministicStateGateway`, `src/server/dataStore`).

## Component 2 — Runtime memory store (#10)

### Record shape

```ts
export const MEMORY_RECORD_SCHEMA_VERSION = 'v1' as const;

export type RuntimeMemoryKind = 'fact' | 'preference' | 'hypothesis';
export type MemorySource     = 'user_stated' | 'deterministic_rule' | 'model_inferred';
export type MemoryStatus     = 'active' | 'superseded' | 'revoked' | 'expired';
export type ExportPolicy     = 'personal_never_export' | 'shareable_aggregate';

export interface RuntimeMemoryRecord {
  version: typeof MEMORY_RECORD_SCHEMA_VERSION;
  id: string;
  scopeId: string;
  kind: RuntimeMemoryKind;
  content: string;
  language: 'ar' | 'he' | 'en' | 'mixed';
  source: MemorySource;
  confidence: number;             // 0..1
  exportPolicy: ExportPolicy;     // defaults to personal_never_export
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  observedAt: string;
  staleAfter: string;             // computed TTL boundary
  supersedesId?: string;
  supersededById?: string;
  revokedAt?: string;
  evidenceIds: string[];          // links to observations
}
```

### Store API

```ts
export interface RuntimeMemoryStore {
  put(input: CreateMemoryInput): RuntimeMemoryRecord;
  get(id: string): RuntimeMemoryRecord | null;
  retrieve(query: MemoryQuery): RuntimeMemoryRecord[];  // active only
  listAll(scopeId: string): RuntimeMemoryRecord[];      // everything, for inspection
  supersede(oldId: string, input: CreateMemoryInput): RuntimeMemoryRecord;
  revoke(id: string, at: string): boolean;
  deleteById(id: string): boolean;
  deleteScope(scopeId: string): number;
  export(scopeId: string): MemoryExport;
  prune(now: string): number;
}

export function createFileRuntimeMemoryStore(options?: { dataDir?: string; defaultTtlMs?: number }): RuntimeMemoryStore;
export function createInMemoryRuntimeMemoryStore(): RuntimeMemoryStore;
```

Supporting types, all defined in `src/contracts/v1/memoryContracts.ts`:

- `CreateMemoryInput` — `scopeId`, `kind`, `content`, `language`, `source`, `confidence`,
  `observedAt`, `evidenceIds`, optional `exportPolicy` (defaults to `personal_never_export`) and
  optional `ttlMs` (falls back to the store's `defaultTtlMs`). Server-assigned fields (`id`,
  `version`, `status`, `createdAt`, `updatedAt`, `staleAfter`, supersession links) are **not**
  accepted from callers.
- `MemoryQuery` — `scopeId` (required), optional `kind`, `minConfidence`, `language`, `limit`.
  Results are sorted newest-`observedAt` first. `retrieve()` always filters to
  `status === 'active'` and `staleAfter > now`.
- `MemoryExport` — `{ version, scopeId, exportedAt, records: RuntimeMemoryRecord[] }`, the
  user-facing data export for a single scope. It intentionally includes personal records (this is the
  user's own data-export right) and is a separate path from fine-tuning export, which is what
  `assertNoPersonalMemory` guards.

Storage follows the alpha convention: one file per record under
`.maybesitter/runtime-memory/<id>.memory.json`, written temp-then-rename, with a version-guarded
reader that skips corrupt files rather than throwing.

### Acceptance criteria → mechanisms

| Criterion | Mechanism |
|---|---|
| Conflicting memories remain inspectable | Two read paths. `retrieve()` filters out revoked/expired/superseded; `listAll()` returns the whole chain. `supersede()` never destroys the prior record — it links `supersedesId`/`supersededById` and marks the old one `superseded`. |
| Deletion removes memory from retrieval | `revoke()` (invisible to `retrieve`, still inspectable and auditable) is deliberately distinct from `deleteById()`/`deleteScope()` (unlinks the file). Tests assert that after deletion both `retrieve` **and** `get` miss, and that after revocation `retrieve` misses while `listAll` still shows it. |
| Personal memory excluded from fine-tuning exports | Every record carries `exportPolicy`, defaulting to `personal_never_export`. `lib/runtimeMemory/exportPolicy.ts` exports `assertNoPersonalMemory(records)`, which throws on any personal record. A test proves it throws. Any future exporter must call it. |

`prune(now)` sweeps records past `staleAfter`, marking them `expired` and removing them from
retrieval — mirroring `scripts/alpha-trace-prune.ts`, with a matching CLI entry point.

## Component 3 — Fixtures, validator, coverage (#11)

Fixtures follow the Lane C corpus convention rather than introducing a parallel format:

- `tests/fixtures/lifeStateMemoryFixtures.ts`, carrying the established
  `SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE` header and a fixed clock.
- Positive and negative sets across four context conditions — **missing**, **stale**, **conflicting**,
  **sensitive** — in each of `ar | he | en | mixed`.
- Each fixture declares its expected provenance/freshness decision, so the fixture set doubles as the
  spec for `Field<T>` behavior (e.g. a missing-context fixture must project
  `{ known: false, reason: 'NO_DATA' }`).
- `lib/lifeState/fixtureValidator.ts` validates fixture shape using the existing
  `lib/evaluation/registry/validationPrimitives.ts` helpers.
- Coverage report (greenfield — no per-language coverage reporting exists today) generated as
  markdown + JSON, mirroring `generateMarkdownReport` from the quality harness, reporting coverage
  across language × context-condition.

Criteria: Arabic/Hebrew logical text preservation is asserted by a round-trip test through the store
and projection (no bidi mangling, no reordering). Sensitive fields have explicit handling — a
sensitive fixture must be stored `personal_never_export` and must be rejected by
`assertNoPersonalMemory`. Fixtures contain no production user data by construction (synthetic, and
committed under the QA-only header).

## Module contract wiring

The `lifeState` and `memory` entries in `src/contracts/v1/moduleContracts.ts` replace their
`not_implemented_in_sprint_00` placeholders with real executors, keeping
`allowsDirectStateWrites: false` and the existing provenance envelope.
`tests/contract/intelligenceModuleBoundaries.test.ts` gains assertions that both modules now return
real shapes; the `planning` placeholder assertion stays as-is.

## Testing

Repo convention: `node:test` + `node:assert/strict`, flat top-level `test(...)`, TS imports in tests
carry explicit `.ts` extensions. **New test files must be added to the explicit list in
`package.json`'s `test` script or they never run** — handled at merge time, not by parallel agents.

Store tests use `createInMemoryRuntimeMemoryStore()` where possible; file-backed tests use the
`mkdtempSync` + env-override + `rmSync` cleanup idiom from `tests/pilot/participantIsolation.test.ts`.

Each component is developed test-first: a failing test that pins the acceptance criterion, then the
implementation.

## Execution plan

1. Write and commit both contract files (shared surface, sequential — done before any parallel work).
2. Three parallel agents on disjoint directories, branched from that commit:
   - #9 → `lib/lifeState/**` (excluding `fixtureValidator.ts`)
   - #10 → `lib/runtimeMemory/**`
   - #11 → `tests/fixtures/**` + `lib/lifeState/fixtureValidator.ts` + coverage report
3. Merge; wire the two `moduleContracts.ts` placeholders and the `package.json` test list centrally,
   since all three would otherwise collide there.
4. `/security-review` (real privacy surface: deletion, revocation, export exclusion), then
   `/code-review`.
5. Full verification (`npm test`, `flutter test` unaffected but confirmed), then PR.

## Non-goals

- Inbound calendar ingestion or any external availability source.
- Modifying `src/domain/memory/` canonical stores, or enabling `fact|preference|hypothesis` in
  `EnabledMemoryKind` for the canonical path.
- Upgrading `behaviorFeedbackService` to an event log (Sprint 03, #13).
- Building a fine-tuning export pipeline.
- Any mobile/Flutter UI surface for memory inspection (Sprint 10, #42).
- Direct model writes to canonical user state.

## Risks

- **Overlap with Sprint 03.** `recentOutcomes` reads outcome data that Sprint 03 will formalize as
  feedback events. Mitigation: project from `DomainState` only, so Sprint 03 can later supply a
  richer source behind the same `Field<RecentOutcomesView>` shape without breaking consumers.
- **`load` semantics are a judgment call.** No existing definition of "load" exists. Mitigation:
  define it explicitly in the contract as a documented deterministic formula over agenda urgency and
  open/overdue counts, versioned with the schema so it can be revised.
- **Parallel-agent collision on shared files.** Mitigation: contracts written first; `package.json`
  and `moduleContracts.ts` edited centrally at merge time.
