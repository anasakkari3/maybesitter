/**
 * The deterministic bounded sweep and manifest reproducibility
 * (Sprint 05, issue #22).
 *
 * The sweep is an exhaustive walk of a fixed grid whose *visit order* is
 * seeded. That is not a stochastic optimiser: every candidate on the grid is
 * evaluated on every run, nothing is sampled away, and no result depends on the
 * wall clock or on unseeded randomness. The seed decides only the order — which
 * is what breaks ties between equally-scoring candidates, and therefore what
 * makes the seed a load-bearing part of the manifest rather than decoration.
 *
 * Reproducibility is tested by **round trip**, not by assertion: run, serialise
 * the manifest, re-run from that manifest, compare the bytes. An assertion that
 * two runs "should" match can pass while the thing a replay actually needs —
 * that the manifest carries enough to rebuild the run — is missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PRIORITY_POLICY } from '../../lib/priority/priorityPolicy.ts';
import {
  SWEEP_AXES,
  SWEEP_MULTIPLIERS,
  canonicalSweepGrid,
  enumerateSweepCandidates,
} from '../../lib/priority/calibration/sweep.ts';
import {
  CalibrationManifestMismatchError,
  runCalibration,
  runCalibrationFromManifest,
  serializeCalibrationReport,
} from '../../lib/priority/calibration/calibrate.ts';
import { judgmentOf, pairOf, syntheticCorpus } from './calibrationFixtures.ts';

const BASE = DEFAULT_PRIORITY_POLICY;
const GENERATED_AT = '2026-08-19T00:00:00.000Z';

/**
 * Two pairs whose judged ordering the shipped weights get wrong, and which
 * several different weight moves can fix — so the sweep finds a tie and the
 * seed has something to break.
 */
function tieCorpus() {
  const p1 = pairOf({
    pairId: 'p1',
    slice: 'heavy',
    left: { id: 'p1-a', snoozes: 1 },
    right: { id: 'p1-b', level: 'high' },
  });
  const p2 = pairOf({
    pairId: 'p2',
    slice: 'light',
    left: { id: 'p2-a', snoozes: 1 },
    right: { id: 'p2-b', level: 'high' },
  });
  return syntheticCorpus({
    pairs: [p1, p2],
    judgments: [
      judgmentOf({ pairId: 'p1', pair: p1, verdict: 'left' }),
      judgmentOf({ pairId: 'p2', pair: p2, verdict: 'left' }),
    ],
  });
}

/* ── The grid ────────────────────────────────────────────────────── */

test('sweep: the axis list is explicit and sorted, not read off the policy object', () => {
  assert.deepEqual(SWEEP_AXES, [
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
  ]);
  // Every weight is swept, so adding one to the policy without adding it here
  // is a red test rather than a silently unexplored dimension.
  assert.deepEqual(SWEEP_AXES.slice().sort(), Object.keys(BASE.weights).sort());
  // And the order is NOT the policy's declaration order, so a sweep that read
  // Object.keys instead of this list would visit a different sequence.
  assert.notDeepEqual(SWEEP_AXES, Object.keys(BASE.weights));
});

test('sweep: the grid is bounded and its size is a stated number', () => {
  const grid = canonicalSweepGrid(BASE);
  assert.equal(SWEEP_MULTIPLIERS.length, 4);
  assert.equal(grid.length, SWEEP_AXES.length * SWEEP_MULTIPLIERS.length);
  assert.equal(grid.length, 44);
});

test('sweep: every candidate carries a version that is not the shipped one', () => {
  const versions = canonicalSweepGrid(BASE).map((policy) => policy.version);
  assert.equal(new Set(versions).size, versions.length);
  assert.equal(versions.includes(BASE.version), false);
  for (const version of versions) assert.ok(version.startsWith(`${BASE.version}+`), version);
});

test('sweep: a candidate differs from the base on exactly one axis', () => {
  for (const candidate of canonicalSweepGrid(BASE)) {
    const changed = SWEEP_AXES.filter((axis) => candidate.weights[axis] !== BASE.weights[axis]);
    assert.equal(changed.length, 1, `${candidate.version} changed ${changed.join(', ')}`);
    assert.equal(candidate.bandCap, BASE.bandCap);
    assert.equal(candidate.totalCap, BASE.totalCap);
    assert.deepEqual(candidate.reasonBase, BASE.reasonBase);
  }
});

/* ── Determinism ─────────────────────────────────────────────────── */

test('sweep: the same seed visits the same candidate sequence', () => {
  const first = enumerateSweepCandidates(BASE, 4_242).map((policy) => policy.version);
  const second = enumerateSweepCandidates(BASE, 4_242).map((policy) => policy.version);
  assert.deepEqual(second, first);
});

test('sweep: a different seed visits the same candidates in a different order', () => {
  const first = enumerateSweepCandidates(BASE, 1).map((policy) => policy.version);
  const second = enumerateSweepCandidates(BASE, 2).map((policy) => policy.version);

  assert.notDeepEqual(second, first);
  assert.deepEqual(second.slice().sort(), first.slice().sort());
});

test('sweep: enumerating candidates does not touch the base policy', () => {
  const before = JSON.stringify(BASE);
  enumerateSweepCandidates(BASE, 9);
  canonicalSweepGrid(BASE);
  assert.equal(JSON.stringify(BASE), before);
  assert.equal(Object.isFrozen(BASE), true);
});

/* ── The report ──────────────────────────────────────────────────── */

test('calibration: the manifest states the seed, the digest and the grid size it used', () => {
  const report = runCalibration({
    corpus: tieCorpus(),
    basePolicy: BASE,
    generatedAt: GENERATED_AT,
    searchSeed: 7,
  });

  assert.equal(report.manifest.searchSeed, 7);
  assert.equal(report.manifest.generatedAt, GENERATED_AT);
  assert.equal(report.manifest.corpusProvenance, 'synthetic_pipeline_proof');
  assert.equal(report.manifest.basePolicyVersion, BASE.version);
  assert.equal(report.manifest.candidatesEvaluated, canonicalSweepGrid(BASE).length + 1);
  assert.match(report.manifest.corpusDigest, /^[0-9a-f]{64}$/);
  assert.equal(report.policyUnchanged, true);
});

test('calibration: the run reports a candidate but never returns the shipped policy changed', () => {
  const before = JSON.stringify(DEFAULT_PRIORITY_POLICY);
  const report = runCalibration({
    corpus: tieCorpus(),
    basePolicy: BASE,
    generatedAt: GENERATED_AT,
    searchSeed: 7,
  });

  assert.equal(JSON.stringify(DEFAULT_PRIORITY_POLICY), before);
  assert.equal(report.baseline.policy.version, BASE.version);
  assert.notEqual(report.best, null);
  assert.notEqual(report.best?.policy.version, BASE.version);
});

test('calibration: the seed decides which of two equally-scoring candidates wins', () => {
  const corpus = tieCorpus();
  const winners = new Set<string>();
  for (let seed = 1; seed <= 20; seed += 1) {
    const report = runCalibration({ corpus, basePolicy: BASE, generatedAt: GENERATED_AT, searchSeed: seed });
    assert.notEqual(report.best, null);
    winners.add(report.best!.policy.version);
  }
  assert.ok(winners.size > 1, `expected the seed to break ties, saw only ${[...winners].join(', ')}`);
});

test('calibration: best is null when no candidate beats the baseline', () => {
  const p1 = pairOf({ pairId: 'p1', left: { id: 'a', level: 'high' }, right: { id: 'b' } });
  const report = runCalibration({
    corpus: syntheticCorpus({ pairs: [p1], judgments: [judgmentOf({ pairId: 'p1', pair: p1, verdict: 'left' })] }),
    basePolicy: BASE,
    generatedAt: GENERATED_AT,
    searchSeed: 3,
  });

  assert.equal(report.baseline.overall.rate, 1);
  assert.equal(report.best, null);
  assert.equal(report.status, 'NO IMPROVEMENT');
});

test('calibration: an empty corpus produces a report that says so rather than a rate', () => {
  const report = runCalibration({
    corpus: syntheticCorpus({ pairs: [], judgments: [] }),
    basePolicy: BASE,
    generatedAt: GENERATED_AT,
    searchSeed: 3,
  });

  assert.equal(report.baseline.overall.rate, null);
  assert.equal(report.best, null);
  assert.equal(report.status, 'CORPUS EMPTY');
  assert.deepEqual(report.regressions, []);
});

test('calibration: a slice whose rate drops under the chosen candidate is reported as a regression', () => {
  // 'heavy' is fixed by moving lateness up; 'light' is broken by the same move.
  const heavy1 = pairOf({ pairId: 'h1', slice: 'heavy', left: { id: 'h1a', snoozes: 1 }, right: { id: 'h1b', level: 'high' } });
  const heavy2 = pairOf({ pairId: 'h2', slice: 'heavy', left: { id: 'h2a', snoozes: 1 }, right: { id: 'h2b', level: 'high' } });
  const light = pairOf({ pairId: 'l1', slice: 'light', left: { id: 'l1a', snoozes: 1 }, right: { id: 'l1b', level: 'high' } });

  const report = runCalibration({
    corpus: syntheticCorpus({
      pairs: [heavy1, heavy2, light],
      judgments: [
        judgmentOf({ pairId: 'h1', pair: heavy1, verdict: 'left' }),
        judgmentOf({ pairId: 'h2', pair: heavy2, verdict: 'left' }),
        judgmentOf({ pairId: 'l1', pair: light, verdict: 'right' }),
      ],
    }),
    basePolicy: BASE,
    generatedAt: GENERATED_AT,
    searchSeed: 5,
  });

  assert.notEqual(report.best, null);
  const regressed = report.regressions.map((slice) => slice.slice);
  assert.deepEqual(regressed, ['light']);
  const light1 = report.regressions[0];
  assert.equal(light1.before.rate, 1);
  assert.equal(light1.after.rate, 0);
  assert.deepEqual(report.regressedPairs.map((pair) => pair.pairId), ['l1']);
});

/* ── Reproducible from the manifest, by round trip ───────────────── */

test('reproducibility: re-running from a serialised manifest produces byte-identical output', () => {
  const corpus = tieCorpus();
  const first = runCalibration({ corpus, basePolicy: BASE, generatedAt: GENERATED_AT, searchSeed: 7 });
  const firstBytes = serializeCalibrationReport(first);

  // Round trip through text, so the replay reads only what a stored manifest
  // would actually carry.
  const stored = JSON.parse(firstBytes) as { manifest: unknown };
  const replayed = runCalibrationFromManifest(stored.manifest as never, { corpus, basePolicy: BASE });

  assert.equal(serializeCalibrationReport(replayed), firstBytes);
});

test('reproducibility: a replay against a different corpus is refused, not silently rerun', () => {
  const first = runCalibration({ corpus: tieCorpus(), basePolicy: BASE, generatedAt: GENERATED_AT, searchSeed: 7 });
  const other = syntheticCorpus({ pairs: [], judgments: [] });

  assert.throws(
    () => runCalibrationFromManifest(first.manifest, { corpus: other, basePolicy: BASE }),
    CalibrationManifestMismatchError,
  );
});

test('reproducibility: a replay under a different base policy version is refused', () => {
  const corpus = tieCorpus();
  const first = runCalibration({ corpus, basePolicy: BASE, generatedAt: GENERATED_AT, searchSeed: 7 });

  assert.throws(
    () => runCalibrationFromManifest(first.manifest, { corpus, basePolicy: { ...BASE, version: 'priority-policy-v2' } }),
    CalibrationManifestMismatchError,
  );
});

test('reproducibility: a manifest missing its seed cannot be replayed', () => {
  const corpus = tieCorpus();
  const first = runCalibration({ corpus, basePolicy: BASE, generatedAt: GENERATED_AT, searchSeed: 7 });
  const { searchSeed: _dropped, ...seedless } = first.manifest;

  assert.throws(
    () => runCalibrationFromManifest(seedless as never, { corpus, basePolicy: BASE }),
    CalibrationManifestMismatchError,
  );
});
