import test from 'node:test';
import assert from 'node:assert/strict';

import { validateEvaluationReport } from '../../lib/evaluation/registry/validateEvaluationReport.ts';
import { hasIssue } from '../../lib/evaluation/registry/validationPrimitives.ts';
import {
  artifact,
  checksum,
  clone,
  entry,
  evaluationReport,
  ledger,
  registry,
} from './registryFixtures.ts';

test('report: a well-formed report validates against its registry and ledger', () => {
  const result = validateEvaluationReport(evaluationReport(), {
    registry: registry(),
    ledger: ledger(),
  });
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('report: the three fingerprints are all required', () => {
  const stripped = clone(evaluationReport()) as unknown as Record<string, unknown>;
  delete stripped.model;
  delete stripped.config;
  delete stripped.dataset;

  const result = validateEvaluationReport(stripped);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'EVR010'), 'data fingerprint');
  assert.ok(hasIssue(result, 'EVR020'), 'model fingerprint');
  assert.ok(hasIssue(result, 'EVR030'), 'config fingerprint');
});

test('report: the prompt is part of the model fingerprint', () => {
  const report = clone(evaluationReport()) as Record<string, any>;
  delete report.model.promptChecksum;

  const result = validateEvaluationReport(report);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'EVR024'));
});

test('report: an absent adapter must be stated as null, not omitted', () => {
  const report = clone(evaluationReport()) as Record<string, any>;
  delete report.model.adapter;

  const result = validateEvaluationReport(report);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'EVR025'));
});

test('report: an unseeded run is rejected', () => {
  const report = clone(evaluationReport()) as Record<string, any>;
  report.config.seed = null;

  const result = validateEvaluationReport(report);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'EVR032'));
});

test('report: evaluating bytes that differ from the registered artifact fails', () => {
  const report = clone(evaluationReport());
  report.dataset.checksum = checksum('dead');

  const result = validateEvaluationReport(report, { registry: registry(), ledger: ledger() });
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'EVR053'));
});

test('report: a locked test artifact whose ledger checksum differs fails', () => {
  const drifted = clone(ledger());
  drifted.records[0].checksum = checksum('beef');

  const result = validateEvaluationReport(evaluationReport(), {
    registry: registry(),
    ledger: drifted,
  });

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'EVR062'));
});

test('report: an unregistered artifact cannot back a report', () => {
  const report = clone(evaluationReport());
  report.dataset.artifactId = 'nowhere-artifact';

  const result = validateEvaluationReport(report, { registry: registry() });
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'EVR050'));
});

test('report: a stale dataset version is rejected', () => {
  const report = clone(evaluationReport());
  report.dataset.datasetVersion = '0.9.0';

  const result = validateEvaluationReport(report, { registry: registry() });
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'EVR052'));
});

test('report: an unlocked test artifact cannot back a gate report', () => {
  const unlocked = registry({
    entries: [entry({ status: 'draft', artifacts: [artifact({ mutability: 'append_only' })] })],
  });

  const result = validateEvaluationReport(evaluationReport(), { registry: unlocked });
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'EVR060'));
});

test('report: a test artifact with no active lock record fails', () => {
  const result = validateEvaluationReport(evaluationReport(), {
    registry: registry(),
    ledger: ledger({ records: [] }),
  });

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'EVR061'));
});

test('report: contractSnapshot must resolve to a registered schema snapshot', () => {
  const withSnapshot = registry({
    entries: [
      entry({
        artifacts: [
          artifact(),
          artifact({
            id: 'schema-snapshot',
            role: 'schema_snapshot',
            mutability: 'locked',
            checksum: checksum('5c'),
            location: { repository: 'fixture-repo', revision: 'abc123', path: 'data/schema.json' },
          }),
        ],
      }),
    ],
  });

  const matching = clone(evaluationReport());
  matching.contractSnapshot = { artifactId: 'schema-snapshot', checksum: checksum('5c') };
  assert.equal(
    validateEvaluationReport(matching, { registry: withSnapshot, ledger: ledger() }).valid,
    true,
  );

  const drifted = clone(matching);
  drifted.contractSnapshot = { artifactId: 'schema-snapshot', checksum: checksum('dead') };
  const driftResult = validateEvaluationReport(drifted, { registry: withSnapshot, ledger: ledger() });
  assert.equal(driftResult.valid, false);
  assert.ok(hasIssue(driftResult, 'EVR076'));

  const wrongRole = clone(matching);
  wrongRole.contractSnapshot = { artifactId: 'sample-artifact', checksum: checksum('sample-artifact') };
  const roleResult = validateEvaluationReport(wrongRole, { registry: withSnapshot, ledger: ledger() });
  assert.equal(roleResult.valid, false);
  assert.ok(hasIssue(roleResult, 'EVR075'));
});

test('report: metric values must be finite numbers or an explicit null', () => {
  const report = clone(evaluationReport()) as Record<string, any>;
  report.metrics.brokenMetric = 'n/a';

  const result = validateEvaluationReport(report);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'EVR041'));
});

test('report: slice metrics are validated like top-level metrics', () => {
  const report = clone(evaluationReport()) as Record<string, any>;
  report.slices = { languageExactPercent: { ar: 0, he: Number.NaN } };

  const result = validateEvaluationReport(report);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path === 'report.slices.languageExactPercent.he'));
});
