/**
 * What a shadow run starts from, and the canonical form its payload digests are
 * taken over.
 *
 * ── Why the pipeline receives its starting material rather than fetching it ──
 *
 * `ShadowRunSeed` is the whole of what enters the chain, and every field of it
 * is supplied by the caller. That is the single most load-bearing decision in
 * this module and it is worth stating plainly: **the shadow pipeline reads no
 * store.** It does not open the data directory, project a `LifeState`, or query
 * a commitment. The application already has those things at the point where a
 * shadow run is triggered; it hands them over.
 *
 * Three consequences, all of them the point:
 *
 *  1. The read-only guarantee becomes checkable by walking imports. A module
 *     that fetches its own inputs reaches a repository, and a repository is one
 *     refactor away from a writer — `createFileRuntimeMemoryStore` is in this
 *     repo, is the registry's named memory entry point, and calls
 *     `writeFileSync`. `tests/shadowPipeline/shadowPipelineBoundaries.test.ts`
 *     can only assert what it can see in the import closure, so the design has
 *     to put the fetching outside the closure.
 *  2. A run is reproducible from its seed. Every instant, every snapshot and
 *     every configuration knob is an input, so two runs over one seed produce
 *     one bundle — which is what makes the replay bundle mean anything.
 *  3. The awkward module becomes honest. `memory` is the one stage whose real
 *     work is a *read*, and it takes a `ShadowMemoryReader` — `retrieve` and
 *     nothing else, typed against `memoryContracts` rather than against
 *     `lib/runtimeMemory/runtimeMemoryStore`. The narrowing is the mechanism:
 *     an adapter holding a full `RuntimeMemoryStore` could call `deleteScope`,
 *     and no type in the contract would notice.
 */

import { compareByCodePoint } from '../planning/shared/compare';
import type { Instant } from '../../src/contracts/v1/shadowPipelineContracts';
import type { LifeState } from '../../src/contracts/v1/lifeStateContracts';
import type { MemoryQuery, RuntimeMemoryRecord } from '../../src/contracts/v1/memoryContracts';
import type { PriorityScore } from '../../src/contracts/v1/priorityContracts';
import type {
  FixedEvent,
  PlanningConfig,
  PlanningHorizon,
  PlanningItem,
  WorkingWindow,
} from '../../src/contracts/v1/planningContracts';
import type { RecommendationDecision } from '../../src/contracts/v1/recommendationContracts';
import type { PressureBudget, SensitivityClass } from '../../src/contracts/v1/safetyContracts';
import type { CommitmentSnapshot } from '../recommendation/selector/candidates';

/**
 * The read half of a runtime memory store, and nothing else.
 *
 * `Pick<RuntimeMemoryStore, 'retrieve'>` would say the same thing in fewer
 * characters and would say it about a type whose other nine members are
 * `put`, `supersede`, `revoke`, `deleteById`, `deleteScope` and `prune`.
 * Spelling the one permitted method out means the shadow adapter's declared
 * dependency is visibly a reader — a reviewer sees the whole surface without
 * following a type alias to a file full of writers.
 */
export interface ShadowMemoryReader {
  retrieve(query: MemoryQuery): readonly RuntimeMemoryRecord[];
}

/**
 * Everything a shadow run starts from.
 *
 * `captureText` is the one untrusted free-text field in the whole module, and
 * it never leaves it: the contract-visible `ShadowPipelineInput` carries
 * `inputDigest` instead, and no artifact the pipeline emits has a field this
 * string could travel in.
 */
export interface ShadowRunSeed {
  readonly scopeId: string;
  /** Every instant in the chain is derived from this one. Never a clock read. */
  readonly now: Instant;
  readonly timezone: string;
  /** The untrusted capture text. Digested into the bundle, never carried into it. */
  readonly captureText: string;
  readonly lifeState: LifeState;
  readonly commitments: readonly CommitmentSnapshot[];
  readonly priorityScores: readonly PriorityScore[];
  readonly horizon: PlanningHorizon;
  readonly workingWindows: readonly WorkingWindow[];
  readonly fixedEvents: readonly FixedEvent[];
  readonly planningItems: readonly PlanningItem[];
  readonly planningConfig: PlanningConfig;
  readonly pressureBudget: PressureBudget;
  readonly permittedSensitivity: SensitivityClass;
  /** User acts the caller attests happened. Trusted state, per `SafetyRequest`. */
  readonly attestedDecisions: readonly RecommendationDecision[];
}

/**
 * A stable string for any value, for hashing.
 *
 * Object keys are emitted in `compareByCodePoint` order — the repo's one string
 * ordering, imported rather than respelled, and never `localeCompare`, whose
 * answer moves with `LANG` and would make two machines running identical code
 * disagree about a digest. `JSON.stringify` alone is not enough: it emits keys
 * in insertion order, so two structurally identical payloads built by two code
 * paths would hash differently and every replay would report a divergence that
 * was really an object-literal ordering.
 *
 * Arrays keep their order, because an array's order is data.
 *
 * `undefined` collapses to `null` rather than disappearing, so a key that is
 * present-and-undefined and a key that is absent cannot hash the same — the
 * distinction several of these module inputs actually use, since most of them
 * spell optional fields with `?`.
 */
export function canonicalize(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : '"__nonfinite__"';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  // A function reaching a digest would mean a live handle reached a payload.
  // Hashing its source would silently make that fine; a fixed token makes two
  // different functions collide, which is the direction that gets noticed.
  if (typeof value === 'function' || typeof value === 'symbol') return '"__uncanonicalizable__"';
  if (typeof value !== 'object') return '"__uncanonicalizable__"';

  // Cycle-safe: a payload with a cycle is a producer bug, and throwing here
  // would turn it into an exception out of the middle of a shadow run.
  if (seen.has(value as object)) return '"__cycle__"';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry, seen)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).slice().sort(compareByCodePoint);
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`);
  return `{${parts.join(',')}}`;
}
