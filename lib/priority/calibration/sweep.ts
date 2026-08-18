/**
 * The deterministic bounded sweep over the weight space
 * (Sprint 05, issue #22).
 *
 * ── Why a sweep and not an optimiser ───────────────────────────────
 *
 * The acceptance criterion is "configuration is reproducible from manifest".
 * A stochastic optimiser cannot satisfy it: its result depends on a random
 * stream, and once that stream is seeded well enough to be replayable it has
 * become a deterministic enumeration with extra steps. So this is a plain
 * exhaustive walk of a fixed grid. Every candidate is evaluated on every run;
 * nothing is sampled away; no branch reads the clock.
 *
 * ── What the seed does, and why it is not decoration ───────────────
 *
 * The seed permutes the **visit order** of the grid. That is the only thing it
 * touches, and it matters for exactly one reason: candidates tie. When two
 * weight moves reproduce the judged orderings equally well, something has to
 * choose, and "the first one visited" is the only tie-break that does not
 * secretly encode a preference about which weight ought to move. Making the
 * order a function of the seed means the choice is recorded in the manifest
 * rather than falling out of the order somebody happened to declare the axes
 * in — and it makes `searchSeed` load-bearing, so a manifest that lost it
 * cannot replay the run it claims to describe.
 *
 * ── What is swept, and what deliberately is not ────────────────────
 *
 * Swept: the eleven entries of `PriorityPolicy.weights`, one axis at a time,
 * against a fixed multiplier set. Coordinate-wise rather than combinatorial —
 * 11 axes at 4 multipliers is 44 candidates, where the full cross product is
 * 4^11, and a search that large would be fitting noise on any corpus small
 * enough for humans to have judged.
 *
 * Not swept: `reasonBase` and the two caps. Bands sit 2000 points apart against
 * a band cap of 999 precisely so a band can never overtake the one above it —
 * ordering *between* bands is structural rather than tuned. Sweeping those
 * numbers would not be calibrating the ranking, it would be redesigning it, and
 * it would do so invisibly inside a search.
 *
 * ── The axis list ──────────────────────────────────────────────────
 *
 * `SWEEP_AXES` is an explicit, sorted literal, not `Object.keys(policy.weights)`.
 * Deriving it would make the sweep's visit order — and therefore its tie-breaks,
 * and therefore its result — depend on the order fields happen to be declared in
 * a policy literal, so reordering two lines in `priorityPolicy.ts` would change
 * a calibration result without changing a single weight.
 */
import type { PriorityPolicy } from '../../../src/contracts/v1/priorityContracts';

export type SweepAxis = keyof PriorityPolicy['weights'];

/** Sorted and explicit. See the header. */
export const SWEEP_AXES: readonly SweepAxis[] = Object.freeze([
  'importanceHigh',
  'importanceNormal',
  'latenessDeferred',
  'latenessPerSnooze',
  'latenessPostponed',
  'latenessSnoozeMax',
  'urgencyDueSoonMax',
  'urgencyOverdueMax',
  'urgencyOverduePerHour',
  'userPressureRecent',
  'userPressureStale',
] as const);

/**
 * Bracketing multipliers, without 1.0 — the identity is the baseline and is
 * evaluated separately, so including it here would double-count it.
 */
export const SWEEP_MULTIPLIERS: readonly number[] = Object.freeze([0.5, 0.75, 1.25, 1.5]);

/**
 * Weights are point values that the scorer adds without rounding, so candidates
 * are rounded to integers here. A sweep that emitted 112.5 would produce totals
 * no hand-check could reproduce, for no gain in resolution.
 */
function candidateWeight(base: number, multiplier: number): number {
  return Math.round(base * multiplier);
}

function candidateFor(base: PriorityPolicy, axis: SweepAxis, multiplier: number): PriorityPolicy {
  return {
    ...base,
    version: `${base.version}+${axis}*${multiplier}`,
    reasonBase: { ...base.reasonBase },
    weights: { ...base.weights, [axis]: candidateWeight(base.weights[axis], multiplier) },
  };
}

/**
 * The grid in canonical order: axes as listed, multipliers as listed.
 *
 * Deduplicated *before* any permutation is applied, so the candidate **set** is
 * a function of the base policy alone and only the order depends on the seed. A
 * dedupe applied after shuffling would let the seed decide which of two
 * identical policies survived, which is a difference the manifest could not
 * explain.
 */
export function canonicalSweepGrid(base: PriorityPolicy): readonly PriorityPolicy[] {
  const grid: PriorityPolicy[] = [];
  const seen = new Set<string>();

  for (const axis of SWEEP_AXES) {
    for (const multiplier of SWEEP_MULTIPLIERS) {
      const value = candidateWeight(base.weights[axis], multiplier);
      // A multiplier that rounds back onto the base is not a candidate; it is
      // the baseline under a different name.
      if (value === base.weights[axis]) continue;
      const candidate = candidateFor(base, axis, multiplier);
      const key = SWEEP_AXES.map((name) => `${name}=${candidate.weights[name]}`).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      grid.push(candidate);
    }
  }

  return grid;
}

/**
 * A small linear congruential generator (Numerical Recipes constants).
 *
 * Deliberately not `Math.random`: the point of the seed is that the same seed
 * produces the same walk on any host, any day.
 */
function seededRandom(seed: number): () => number {
  let state = ((seed >>> 0) ^ 0x9e37_79b9) >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

export function assertUsableSeed(seed: unknown): asserts seed is number {
  if (typeof seed !== 'number' || !Number.isInteger(seed) || !Number.isFinite(seed)) {
    throw new TypeError(`calibration sweep: searchSeed must be an integer, received ${JSON.stringify(seed)}`);
  }
}

/**
 * The grid in the order this run visits it. A seeded Fisher-Yates over the
 * canonical grid: same members, seed-determined sequence.
 */
export function enumerateSweepCandidates(base: PriorityPolicy, seed: number): readonly PriorityPolicy[] {
  assertUsableSeed(seed);
  const order = canonicalSweepGrid(base).slice();
  const next = seededRandom(seed);

  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    const held = order[index];
    order[index] = order[swap];
    order[swap] = held;
  }

  return order;
}
