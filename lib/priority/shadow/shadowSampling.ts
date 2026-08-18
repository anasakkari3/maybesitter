/**
 * Deterministic seeded sampling for the shadow comparison (Sprint 05, #23).
 *
 * The acceptance criterion is that sampling be *configurable*, and the word
 * doing the work is "seeded": a sampled run has to be reproducible rather than
 * merely cheap. A comparison that reports three disagreements over a 10% sample
 * is only actionable if a second run over the same corpus looks at the same
 * 10%; otherwise the difference between two runs mixes a real change in the
 * data with a change in who was looked at, and neither can be recovered.
 *
 * ## Per-key, not per-position
 *
 * The decision for one commitment is a pure function of `(seed, commitmentId)`.
 * Nothing about the corpus's size, order, or contents enters into it. Three
 * consequences, each of which a counter-based or shuffle-based sampler loses:
 *
 *  - **Order independence.** The same corpus assembled in a different order
 *    samples identically, so a report cannot depend on how its input was built.
 *  - **Stability under growth.** Adding a commitment changes whether *that*
 *    commitment is sampled and nothing else. A sampler that took the first
 *    `rate x n` of a seeded shuffle would resample the whole corpus every time
 *    a row was added, and two consecutive weeks of reports would be
 *    incomparable for a reason nobody would think to look for.
 *  - **Nesting.** Because the threshold moves and the per-key fraction does
 *    not, a sample at a lower rate is a strict subset of one at a higher rate.
 *    A 30% run and a 70% run are therefore the same experiment at two
 *    resolutions, not two unrelated corpora.
 *
 * ## No randomness
 *
 * `Math.random()` appears nowhere, and a boundary test forbids it. It would
 * satisfy every count-based property below — the sample would be about the
 * right size, and roughly uniform — while destroying the only property that
 * makes sampling worth configuring.
 */
import type { ShadowSamplingConfig } from '../../../src/contracts/v1/calibrationContracts';

const UINT32 = 4_294_967_296;

/**
 * FNV-1a, 32-bit. Chosen because it is short enough to read and verify in
 * place, has no dependencies, and — unlike any hash reached through a runtime
 * library — cannot change its output between Node versions and silently
 * invalidate every stored report's reproducibility claim.
 */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The key's position in [0, 1). Strictly below 1, which is what makes `rate: 1`
 * mean *everything* rather than *almost everything*: with a `<` threshold, a
 * fraction that could equal 1 would drop a row from a run the caller asked to
 * be exhaustive, and the omission would be invisible in the counts.
 */
export function sampleFraction(seed: number, key: string): number {
  return fnv1a32(`${seed}:${key}`) / UINT32;
}

/**
 * Validates and returns the config unchanged, so a caller can echo exactly what
 * was validated into the report.
 *
 * Refuses rather than clamps. A rate of 1.5 or -1 is a configuration mistake,
 * and clamping would let the author of that mistake read the resulting report
 * as if it answered the question they asked.
 */
export function validateSamplingConfig(config: ShadowSamplingConfig): ShadowSamplingConfig {
  const { rate, seed } = config;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new TypeError(`shadow sampling: rate must be a finite number in 0..1, received ${JSON.stringify(rate)}`);
  }
  if (!Number.isInteger(seed)) {
    throw new TypeError(`shadow sampling: seed must be a finite integer, received ${JSON.stringify(seed)}`);
  }
  return { rate, seed };
}

/**
 * Whether one key is in the sample.
 *
 * The comparison is strict, so `rate: 0` selects nothing (no fraction is below
 * zero) and `rate: 1` selects everything (every fraction is below one). Both
 * endpoints are exact rather than approximate, which is what lets a rate-1 run
 * stand in for "no sampling at all".
 */
export function isSampled(config: ShadowSamplingConfig, key: string): boolean {
  const { rate, seed } = validateSamplingConfig(config);
  return sampleFraction(seed, key) < rate;
}

/**
 * The sampled subset, in the input's own order. Order is preserved rather than
 * sorted here because the caller — not the sampler — owns what a stable order
 * means for its items.
 */
export function selectSample<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  config: ShadowSamplingConfig,
): readonly T[] {
  const { rate, seed } = validateSamplingConfig(config);
  return items.filter((item) => sampleFraction(seed, keyOf(item)) < rate);
}
