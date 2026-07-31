import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { validateDatasetRegistry } from '../../lib/evaluation/registry/validateRegistry.ts';
import { validateLockedArtifactLedger } from '../../lib/evaluation/registry/validateLockLedger.ts';
import { validateEvaluationReport } from '../../lib/evaluation/registry/validateEvaluationReport.ts';
import { computeChain } from '../../lib/evaluation/registry/lockChain.ts';
import { canonicalJson, checksumOf } from '../../lib/evaluation/registry/fingerprint.ts';
import type {
  DatasetRegistry,
  LockedArtifactLedger,
} from '../../lib/evaluation/registry/contracts.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const REGISTRY_DIR = path.join(repoRoot, 'data/registry');

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(REGISTRY_DIR, relativePath), 'utf8')) as T;
}

const shippedRegistry = readJson<DatasetRegistry>('dataset-registry.json');
const shippedLedger = readJson<LockedArtifactLedger>('locked-artifacts.ledger.json');

/**
 * Every dataset-side artifact the Gemma pipeline currently produces. If a new
 * artifact appears in the pipeline, add it here and to the registry together —
 * this list is what makes "the registry represents everything" checkable rather
 * than a claim.
 *
 * Evaluation outputs (evaluation-reports/**) are deliberately absent: they are
 * represented by the EvaluationReport contract, asserted separately below.
 */
const CURRENT_GEMMA_DATASET_PATHS: readonly string[] = [
  'config/pilot-v4-training.yaml',
  'data/DATASET_CARD.md',
  'data/DATASET_MANIFEST.json',
  'data/EXCLUSIONS_REPORT.md',
  'data/LICENSES.md',
  'data/TRANSFORMATION_REPORT.md',
  'data/review/PILOT_V4_REVIEW_COVERAGE.json',
  'data/review/PILOT_V4_REVIEW_PROGRESS.json',
  'data/review/calibration/consistency-10-manifest.json',
  'data/review/calibration/consistency-second-pass.jsonl',
  'data/review/calibration/first-50-coverage.json',
  'data/review/calibration/first-50-manifest.json',
  'data/review/calibration/reviewer-metadata.jsonl',
  'data/review/calibration/reviewer-metadata.schema.json',
  'data/review/gold-decisions.jsonl',
  'data/review/gold-queue.jsonl',
  'data/review/per-item-gold.jsonl',
  'data/review/per-item-gold.schema.json',
  'data/review/pilot-v4-review-queue.jsonl',
  'evaluation-data/LOCKED_AUTOMATED_V4_REPORT.json',
  'evaluation-data/cases.jsonl',
  'evaluation-data/locked-automated-v4.jsonl',
  'evaluation-data/locked-test.jsonl',
  'evaluation-data/production-extraction-schema-v4.json',
  'evaluation-data/remediation-development.json',
  'training-data/pilot-v4-staged/compile-report.json',
  'training-data/pilot-v4-staged/locked_test.jsonl',
  'training-data/pilot-v4-staged/pilot_train.jsonl',
  'training-data/pilot-v4-staged/pilot_valid.jsonl',
  'training-data/pilot-v4/TRAINING_CONFIG.json',
  'training-data/test.jsonl',
  'training-data/train.jsonl',
  'training-data/valid.jsonl',
  // maybesitter-gemma-runtime-benchmark
  'benchmark-data/runtime-smoke-v1.jsonl',
  'benchmark-reports/runtime/raw-results.jsonl',
  'benchmark-reports/runtime/summary.json',
];

/** Repositories holding the Gemma pipeline artifacts this inventory covers. */
const GEMMA_REPOSITORIES = ['maybesitter-gemma', 'maybesitter-gemma-runtime-benchmark'];

function registeredPaths(): readonly string[] {
  return shippedRegistry.entries.flatMap((entry) =>
    entry.artifacts
      .filter((artifact) => GEMMA_REPOSITORIES.includes(artifact.location.repository))
      .map((artifact) => artifact.location.path),
  );
}

test('shipped registry: validates against the registry contract', () => {
  const result = validateDatasetRegistry(shippedRegistry);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('shipped registry: warnings are limited to the known in-progress splits', () => {
  const result = validateDatasetRegistry(shippedRegistry);
  const warned = result.issues
    .filter((issue) => issue.severity === 'warning')
    .map((issue) => `${issue.code} ${issue.path}`)
    .sort();

  assert.deepEqual(warned, [
    'SPL006 entries[0].artifacts.gemma3-corpus-test',
    'SPL006 entries[4].artifacts.gemma3-pilot-v4-test',
  ]);
});

test('shipped ledger: validates against the shipped registry', () => {
  const result = validateLockedArtifactLedger(shippedLedger, shippedRegistry);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('shipped ledger: is sealed, so scripts/seal-lock-ledger.mjs --check would pass', () => {
  const expected = computeChain(shippedLedger.records);
  shippedLedger.records.forEach((record, index) => {
    assert.deepEqual(record.chainChecksum, expected[index], `record ${record.artifactId}`);
  });
});

test('shipped ledger: covers exactly the locked artifacts in the registry', () => {
  const lockedInRegistry = shippedRegistry.entries
    .flatMap((entry) => entry.artifacts)
    .filter((artifact) => artifact.mutability === 'locked')
    .map((artifact) => artifact.id)
    .sort();

  const activeInLedger = shippedLedger.records
    .filter((record) => record.state === 'active')
    .map((record) => record.artifactId)
    .sort();

  assert.deepEqual(activeInLedger, lockedInRegistry);
  assert.deepEqual(lockedInRegistry, [
    // Sprint 01, issue #5: the frozen Capture Gold and the gate that authorized it.
    'capture-gold-consistency-gate-v2',
    'capture-gold-freeze-v1-manifest',
    'gemma3-locked-automated-v4-cases',
    'gemma3-locked-test-cases',
    'production-extraction-schema-v4-json',
  ]);
});

test('coverage: every current Gemma dataset artifact is registered exactly once', () => {
  const registered = registeredPaths();
  const counts = new Map<string, number>();
  for (const artifactPath of registered) {
    counts.set(artifactPath, (counts.get(artifactPath) ?? 0) + 1);
  }

  const missing = CURRENT_GEMMA_DATASET_PATHS.filter((artifactPath) => !counts.has(artifactPath));
  assert.deepEqual(missing, [], 'unregistered Gemma artifacts');

  const duplicated: string[] = [];
  counts.forEach((count, artifactPath) => {
    if (count > 1) duplicated.push(artifactPath);
  });
  assert.deepEqual(duplicated, [], 'artifacts registered more than once');
});

test('coverage: the registry declares nothing beyond the known Gemma inventory', () => {
  const unexpected = registeredPaths()
    .filter((artifactPath) => !CURRENT_GEMMA_DATASET_PATHS.includes(artifactPath))
    .sort();

  assert.deepEqual(unexpected, [], 'registry declares artifacts not in the known inventory');
});

test('coverage: train, valid, and test ownership is explicit for every training dataset', () => {
  const trainingEntries = shippedRegistry.entries.filter((entry) => entry.purpose === 'training');
  assert.ok(trainingEntries.length >= 2);

  for (const entry of trainingEntries) {
    for (const role of ['train', 'valid', 'test'] as const) {
      const owners = entry.artifacts.filter((artifact) => artifact.role === role);
      assert.equal(owners.length, 1, `${entry.id} must have exactly one ${role} artifact`);
    }
  }
});

test('coverage: every source carries a license and a reviewed consent record', () => {
  for (const entry of shippedRegistry.entries) {
    assert.ok(entry.sources.length > 0, `${entry.id} has no sources`);
    for (const source of entry.sources) {
      assert.ok(source.license.trim().length > 0, `${entry.id}/${source.name} has no license`);
      assert.ok(source.consent.reviewedBy.trim().length > 0, `${entry.id}/${source.name} consent unreviewed`);
      if (source.consent.containsPersonalData) {
        assert.notEqual(source.consent.personalDataHandling, 'raw');
        assert.equal(source.consent.redistribution, 'internal_only');
      }
    }
  }
});

test('coverage: the reviewer-identifying artifacts are marked internal-only', () => {
  const calibration = shippedRegistry.entries.find((entry) => entry.id === 'gemma3-gold-calibration');
  assert.ok(calibration, 'gemma3-gold-calibration must be registered');
  assert.ok(
    calibration.sources.every((source) => source.consent.containsPersonalData),
    'calibration records carry reviewerId and must be flagged as personal data',
  );

  const goldReview = shippedRegistry.entries.find((entry) => entry.id === 'gemma3-gold-review');
  assert.ok(goldReview);
  assert.ok(
    goldReview.sources.some((source) => source.consent.containsPersonalData),
    'gold decisions carry reviewer_id and must be flagged as personal data',
  );
});

const reportFiles = readdirSync(path.join(REGISTRY_DIR, 'reports'))
  .filter((name) => name.endsWith('.report.json'))
  .sort();

test('coverage: the migrated Gemma evaluation reports validate against the registry', () => {
  assert.deepEqual(reportFiles, [
    'gemma3-baseline-expanded-v4.report.json',
    'gemma3-pilot-v3-expanded-v4.report.json',
  ]);

  for (const name of reportFiles) {
    const report = readJson<Record<string, unknown>>(path.join('reports', name));
    const result = validateEvaluationReport(report, {
      registry: shippedRegistry,
      ledger: shippedLedger,
    });
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.issues, null, 2)}`);
  }
});

test('coverage: model and adapter artifacts are represented as report fingerprints', () => {
  const withAdapter = readJson<any>('reports/gemma3-pilot-v3-expanded-v4.report.json');
  assert.equal(withAdapter.model.id, 'models/mlx/gemma-3-4b-it-4bit');
  assert.equal(withAdapter.model.runtime, 'mlx');
  assert.equal(withAdapter.model.adapter.id, 'adapters/maybesitter-gemma3-pilot-v3');
  assert.match(withAdapter.model.adapter.checksum.value, /^[0-9a-f]{64}$/);

  const withoutAdapter = readJson<any>('reports/gemma3-baseline-expanded-v4.report.json');
  assert.equal(withoutAdapter.model.adapter, null, 'the baseline run had no adapter');
});

test('coverage: migrated report config fingerprints are reproducible', () => {
  for (const name of reportFiles) {
    const report = readJson<any>(path.join('reports', name));
    const recomputed = checksumOf(
      canonicalJson({
        evaluatorVersion: 'expanded-structured-evaluator-v4',
        seed: report.config.seed,
        maxTokens: report.config.maxTokens,
        repairEnabled: report.config.repairEnabled,
        limit: report.config.limit,
        decoding: report.config.decoding,
      }),
    );

    assert.deepEqual(report.config.checksum, recomputed, name);
  }
});
