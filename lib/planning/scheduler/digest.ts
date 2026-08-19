/**
 * `Plan.inputDigest` — the canonical serialisation of a planning request, and
 * the hash of it.
 *
 * The digest is what turns issue #30's replay criterion from a claim into an
 * assertion. "The same inputs produced the same plan" is only checkable if two
 * requests can be compared for structural equality after the fact, and a plan
 * carries no copy of the request that produced it — it carries this hash.
 *
 * Three properties are structural, and each has a failure mode that is silent:
 *
 *  1. **Key order is fixed by construction, not by insertion.** Nothing here
 *     calls `JSON.stringify` on a record. `JSON.stringify` emits keys in the
 *     object's own insertion order, so two structurally identical requests
 *     built by two call sites — one that set `deadlineAt` before `priority`,
 *     one after — would hash differently. Nothing would fail; `sameInputDigest`
 *     would simply read false forever, and every replay check built on it would
 *     pass vacuously by never comparing anything. The `record()` helper below
 *     takes an ordered list of pairs, so the order is in the code.
 *
 *  2. **Arrays are ordered by their own encoded content, not by position.** The
 *     scheduler's plan does not depend on the order items arrive in — that is
 *     the whole point of `PLAN_ORDERING_KEYS` — so a digest that did depend on
 *     it would report "different inputs" for two requests that must produce the
 *     same plan. Sorting the *encodings* rather than by an id field also keeps
 *     the order total when two rows share an id.
 *
 *  3. **No raw user text survives into the canonical string.** `PlanningItem`
 *     carries `title`, which is the user's own words. The digest must be
 *     sensitive to it — a changed title is a changed input — but the
 *     intermediate string is a value a caller can log, and the audit policy
 *     (`PLANNING_PERSISTENCE_POLICY.rawInputInAudit: false`, matching Sprint
 *     06's rule for `DecompositionViolation.detail`) says user text does not
 *     travel. So titles enter as their own SHA-256, which is sensitive without
 *     being readable.
 *
 * Sorting goes through `compareByCodePoint`, never `localeCompare`: the
 * latter's result depends on the runtime's ICU data and default locale, which
 * would make the digest differ between two machines running identical code.
 */

import { createHash } from 'node:crypto';

import { compareByCodePoint } from '../shared/compare';

import type {
  Effort,
  FixedEvent,
  PlanningConfig,
  PlanningConstraints,
  PlanningDependency,
  PlanningHorizon,
  PlanningItem,
  TimeInterval,
  WorkingWindow,
} from '../../../src/contracts/v1/planningContracts';

/**
 * The version of the canonical encoding itself.
 *
 * Prefixed into every digest so that changing the encoding — adding a field,
 * changing how titles are folded in — cannot make an old plan and a new plan
 * collide on a digest while having been produced by different rules.
 */
export const PLAN_INPUT_DIGEST_VERSION = 'plan-digest-v1' as const;

function scalar(value: string | number | boolean | null): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    // A NaN or Infinity would serialise as `null` and make two different
    // requests hash identically, which is exactly the collision the digest
    // exists to rule out.
    throw new TypeError(`cannot digest a non-finite number: ${String(value)}`);
  }
  return JSON.stringify(value);
}

/** A record whose key order is the argument order. See property 1. */
function record(entries: readonly (readonly [string, string])[]): string {
  return `{${entries.map(([key, encoded]) => `${JSON.stringify(key)}:${encoded}`).join(',')}}`;
}

/** A list sorted by encoded content, so input order cannot leak in. */
function sortedList(encodings: readonly string[]): string {
  return `[${encodings.slice().sort(compareByCodePoint).join(',')}]`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** User text enters the digest only as a hash. See property 3. */
function opaqueText(value: string): string {
  return scalar(sha256Hex(value));
}

function encodeInterval(interval: TimeInterval): string {
  return record([
    ['startsAt', scalar(interval.startsAt)],
    ['endsAt', scalar(interval.endsAt)],
  ]);
}

function encodeHorizon(horizon: PlanningHorizon): string {
  return record([
    ['startsAt', scalar(horizon.startsAt)],
    ['endsAt', scalar(horizon.endsAt)],
  ]);
}

function encodeEffort(effort: Effort): string {
  // The variant tag is encoded even though it is implied by the presence of
  // `minutes`, so that `unknown` and a future third variant cannot encode the
  // same way.
  return effort.kind === 'known'
    ? record([['kind', scalar('known')], ['minutes', scalar(effort.minutes)]])
    : record([['kind', scalar('unknown')]]);
}

function encodeDependency(dependency: PlanningDependency): string {
  return record([
    ['dependsOnItemId', scalar(dependency.dependsOnItemId)],
    ['kind', scalar(dependency.kind)],
  ]);
}

function encodeItem(item: PlanningItem): string {
  return record([
    ['itemId', scalar(item.itemId)],
    ['titleHash', opaqueText(item.title)],
    ['effort', encodeEffort(item.effort)],
    ['earliestStartAt', scalar(item.earliestStartAt)],
    ['deadlineAt', scalar(item.deadlineAt)],
    ['priority', scalar(item.priority)],
    ['dependsOn', sortedList(item.dependsOn.map(encodeDependency))],
    ['bufferBeforeMinutes', scalar(item.bufferBeforeMinutes)],
    ['bufferAfterMinutes', scalar(item.bufferAfterMinutes)],
  ]);
}

function encodeWindow(window: WorkingWindow): string {
  return record([
    ['windowId', scalar(window.windowId)],
    ['weekday', scalar(window.weekday)],
    ['startMinute', scalar(window.startMinute)],
    ['endMinute', scalar(window.endMinute)],
    ['timezone', scalar(window.timezone)],
  ]);
}

function encodeFixedEvent(event: FixedEvent): string {
  return record([
    ['eventId', scalar(event.eventId)],
    ['interval', encodeInterval(event.interval)],
    ['sourceCommitmentId', scalar(event.sourceCommitmentId)],
    ['blocking', scalar(event.blocking)],
  ]);
}

function encodeConfig(config: PlanningConfig): string {
  return record([
    ['slotMinutes', scalar(config.slotMinutes)],
    ['foldPolicy', scalar(config.foldPolicy)],
    ['resourceDependenciesOrder', scalar(config.resourceDependenciesOrder)],
  ]);
}

/**
 * The canonical string a digest is taken over. Exported for tests, which assert
 * on it directly — a hash tells you two inputs differ but never where, so a
 * failing digest test that could only print two hex strings would be unusable.
 */
export function canonicalPlanningInput(
  constraints: PlanningConstraints,
  config: PlanningConfig,
): string {
  return record([
    ['digestVersion', scalar(PLAN_INPUT_DIGEST_VERSION)],
    ['scopeId', scalar(constraints.scopeId)],
    ['timezone', scalar(constraints.timezone)],
    ['horizon', encodeHorizon(constraints.horizon)],
    ['workingWindows', sortedList(constraints.workingWindows.map(encodeWindow))],
    ['fixedEvents', sortedList(constraints.fixedEvents.map(encodeFixedEvent))],
    ['items', sortedList(constraints.items.map(encodeItem))],
    ['config', encodeConfig(config)],
  ]);
}

/** SHA-256 of `canonicalPlanningInput`, hex. This is `Plan.inputDigest`. */
export function planningInputDigest(
  constraints: PlanningConstraints,
  config: PlanningConfig,
): string {
  return sha256Hex(canonicalPlanningInput(constraints, config));
}
