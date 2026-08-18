/**
 * Seeded sampling for the shadow comparison (Sprint 05, #23).
 *
 * The acceptance criterion is not "sampling exists" but "a sampled run is
 * reproducible rather than merely cheap". A sampler built on `Math.random`
 * would satisfy every count-based assertion below and fail the only one that
 * matters — that the same seed over the same input picks the same rows — so the
 * reproduction tests come first and the distribution tests after.
 *
 * Selection is per-key rather than per-position: the decision for a commitment
 * depends on `(seed, commitmentId)` and on nothing else, so adding a commitment
 * to the corpus cannot change whether an unrelated one was sampled, and two
 * runs over the same corpus in different orders sample identically.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSampled,
  sampleFraction,
  selectSample,
  validateSamplingConfig,
} from '../../lib/priority/shadow/shadowSampling.ts';
import { syntheticIds } from './shadowFixtures.ts';

const IDS = syntheticIds(200);

function selectedIds(rate: number, seed: number, ids: readonly string[] = IDS): readonly string[] {
  return selectSample(ids, (id) => id, { rate, seed });
}

/* ── Reproducibility: the point of seeding ────────────────────────── */

test('sampling: the same seed over the same input selects exactly the same rows', () => {
  assert.deepEqual(selectedIds(0.5, 42), selectedIds(0.5, 42));
  assert.deepEqual(selectedIds(0.13, 7), selectedIds(0.13, 7));
});

test('sampling: selection depends on the id, not on the position in the input', () => {
  const reversed = IDS.slice().reverse();
  const forward = selectedIds(0.5, 42);
  const backward = selectedIds(0.5, 42, reversed);

  assert.deepEqual(backward.slice().sort(), forward.slice().sort());
});

test('sampling: adding an unrelated commitment does not change who else was sampled', () => {
  const before = selectedIds(0.5, 42);
  const after = selectedIds(0.5, 42, IDS.concat(['cmt_newcomer']));

  assert.deepEqual(after.filter((id) => id !== 'cmt_newcomer'), before);
});

test('sampling: a different seed selects a different subset at the same rate', () => {
  const first = selectedIds(0.5, 1);
  const second = selectedIds(0.5, 2);

  assert.notDeepEqual(first, second);
});

/* ── The two rate endpoints ───────────────────────────────────────── */

test('sampling: rate 0 selects nothing', () => {
  assert.deepEqual(selectedIds(0, 42), []);
  assert.deepEqual(selectedIds(0, 999), []);
});

test('sampling: rate 1 selects everything, in input order', () => {
  assert.deepEqual(selectedIds(1, 42), IDS);
  assert.deepEqual(selectedIds(1, 0), IDS);
});

test('sampling: a rate between the endpoints selects a proportional subset', () => {
  const half = selectedIds(0.5, 42);
  assert.ok(half.length > 0 && half.length < IDS.length, `expected a proper subset, got ${half.length}`);
  assert.ok(Math.abs(half.length - 100) <= 30, `expected roughly half of 200, got ${half.length}`);
});

test('sampling: raising the rate only ever adds rows, never swaps them', () => {
  // Nested samples. Without this, comparing a 30% run against a 70% run would
  // be comparing two unrelated corpora, and a difference between the reports
  // would say nothing about the rate.
  const narrow = selectedIds(0.3, 42);
  const wide = selectedIds(0.7, 42);

  for (const id of narrow) {
    assert.ok(wide.includes(id), `${id} was sampled at 0.3 but dropped at 0.7`);
  }
});

/* ── The fraction itself ──────────────────────────────────────────── */

test('sampling: the per-key fraction is in [0, 1) and stable across calls', () => {
  for (const id of IDS.slice(0, 25)) {
    const fraction = sampleFraction(42, id);
    assert.ok(fraction >= 0 && fraction < 1, `${id} produced ${fraction}, outside [0, 1)`);
    assert.equal(sampleFraction(42, id), fraction);
  }
});

test('sampling: isSampled agrees with selectSample', () => {
  const config = { rate: 0.5, seed: 42 };
  const selected = selectedIds(config.rate, config.seed);

  for (const id of IDS) {
    assert.equal(isSampled(config, id), selected.includes(id), `disagreement on ${id}`);
  }
});

/* ── Refusals ─────────────────────────────────────────────────────── */

test('sampling: a rate outside 0..1 is refused rather than clamped', () => {
  // Clamping would let a caller who asked for 150% believe they compared
  // everything twice, and a caller who asked for -1 believe they compared
  // nothing on purpose. Both are configuration mistakes worth surfacing.
  for (const rate of [-0.0001, -1, 1.0001, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validateSamplingConfig({ rate, seed: 1 }), /rate/, `rate ${rate} must be refused`);
  }
});

test('sampling: a non-integer or non-finite seed is refused', () => {
  for (const seed of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(() => validateSamplingConfig({ rate: 1, seed }), /seed/, `seed ${seed} must be refused`);
  }
});

test('sampling: a valid config is returned unchanged, so callers can echo it into a report', () => {
  assert.deepEqual(validateSamplingConfig({ rate: 0.25, seed: -3 }), { rate: 0.25, seed: -3 });
  assert.deepEqual(validateSamplingConfig({ rate: 1, seed: 0 }), { rate: 1, seed: 0 });
});
