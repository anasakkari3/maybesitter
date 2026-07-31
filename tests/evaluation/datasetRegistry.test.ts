import test from 'node:test';
import assert from 'node:assert/strict';

import { validateDatasetRegistry } from '../../lib/evaluation/registry/validateRegistry.ts';
import { verifyRegistryArtifacts } from '../../lib/evaluation/registry/verifyArtifacts.ts';
import { canonicalJson, fingerprintConfig } from '../../lib/evaluation/registry/fingerprint.ts';
import { hasIssue } from '../../lib/evaluation/registry/validationPrimitives.ts';
import type { ArtifactReader } from '../../lib/evaluation/registry/verifyArtifacts.ts';
import { artifact, checksum, clone, entry, registry, source } from './registryFixtures.ts';

test('registry: a well-formed registry validates', () => {
  const result = validateDatasetRegistry(registry());
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('registry: an unsupported contract major version is rejected', () => {
  const result = validateDatasetRegistry(registry({ contractVersion: '2.0.0' }));
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'REG003'));
});

test('registry: duplicate dataset ids are rejected', () => {
  const result = validateDatasetRegistry(registry({ entries: [entry(), entry()] }));
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'REG010'));
});

test('registry: two artifacts may not own the same file', () => {
  const first = entry({
    id: 'first-dataset',
    artifacts: [artifact({ id: 'first-artifact' })],
  });
  const second = entry({
    id: 'second-dataset',
    artifacts: [
      artifact({
        id: 'second-artifact',
        location: { repository: 'fixture-repo', revision: 'abc123', path: 'data/first-artifact.jsonl' },
      }),
    ],
  });

  const result = validateDatasetRegistry(registry({ entries: [first, second] }));
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'ART021'));
});

test('registry: a split role may not be claimed by two artifacts in one dataset', () => {
  const result = validateDatasetRegistry(
    registry({
      entries: [
        entry({
          artifacts: [
            artifact({ id: 'test-a' }),
            artifact({
              id: 'test-b',
              location: { repository: 'fixture-repo', revision: 'abc123', path: 'data/test-b.jsonl' },
            }),
          ],
        }),
      ],
    }),
  );

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'SPL001'));
});

test('registry: a training dataset must declare train, valid, and test ownership', () => {
  const incomplete = entry({
    purpose: 'training',
    status: 'draft',
    artifacts: [artifact({ id: 'only-train', role: 'train', mutability: 'mutable' })],
  });

  const result = validateDatasetRegistry(registry({ entries: [incomplete] }));
  assert.equal(result.valid, false);

  const missing = result.issues.filter((issue) => issue.code === 'SPL002');
  assert.equal(missing.length, 2);
  assert.ok(missing.some((issue) => issue.message.includes('"valid"')));
  assert.ok(missing.some((issue) => issue.message.includes('"test"')));
});

test('registry: a training dataset that names all three splits validates', () => {
  const complete = entry({
    purpose: 'training',
    status: 'draft',
    artifacts: [
      artifact({ id: 'split-train', role: 'train', mutability: 'mutable' }),
      artifact({ id: 'split-valid', role: 'valid', mutability: 'mutable' }),
      artifact({ id: 'split-test', role: 'test', mutability: 'locked' }),
    ],
  });

  const result = validateDatasetRegistry(registry({ entries: [complete] }));
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('registry: a test artifact may never be mutable', () => {
  const result = validateDatasetRegistry(
    registry({ entries: [entry({ status: 'draft', artifacts: [artifact({ mutability: 'mutable' })] })] }),
  );

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'SPL003'));
});

test('registry: a validated dataset needs a locked test artifact, a draft one only gets a warning', () => {
  const draft = validateDatasetRegistry(
    registry({ entries: [entry({ status: 'draft', artifacts: [artifact({ mutability: 'append_only' })] })] }),
  );
  assert.equal(draft.valid, true);
  assert.ok(hasIssue(draft, 'SPL006'));

  const validated = validateDatasetRegistry(
    registry({
      entries: [entry({ status: 'validated', artifacts: [artifact({ mutability: 'append_only' })] })],
    }),
  );
  assert.equal(validated.valid, false);
  assert.ok(hasIssue(validated, 'SPL005'));
});

test('registry: a frozen dataset may not contain mutable artifacts', () => {
  const result = validateDatasetRegistry(
    registry({
      entries: [
        entry({
          status: 'frozen',
          artifacts: [
            artifact(),
            artifact({
              id: 'loose-notes',
              role: 'report',
              mutability: 'mutable',
              location: { repository: 'fixture-repo', revision: 'abc123', path: 'data/notes.json' },
            }),
          ],
        }),
      ],
    }),
  );

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'STA003'));
});

test('registry: retired datasets must name a registered successor', () => {
  const orphan = validateDatasetRegistry(
    registry({ entries: [entry({ status: 'retired', supersededBy: 'nowhere-dataset' })] }),
  );
  assert.equal(orphan.valid, false);
  assert.ok(hasIssue(orphan, 'STA005'));

  const unset = validateDatasetRegistry(registry({ entries: [entry({ status: 'retired' })] }));
  assert.equal(unset.valid, false);
  assert.ok(hasIssue(unset, 'STA001'));
});

test('registry: consent must be reviewed and may not register raw personal data', () => {
  const raw = validateDatasetRegistry(
    registry({
      entries: [
        entry({
          sources: [
            source({
              consent: {
                basis: 'user_consented_anonymized',
                containsPersonalData: true,
                personalDataHandling: 'raw',
                redistribution: 'internal_only',
                reviewedBy: 'model-data track',
                reviewedAt: '2026-07-31T00:00:00.000Z',
              },
            }),
          ],
        }),
      ],
    }),
  );

  assert.equal(raw.valid, false);
  assert.ok(hasIssue(raw, 'SRC020'));
  assert.ok(hasIssue(raw, 'SRC023'));
});

test('registry: personal data may not be marked freely redistributable', () => {
  const result = validateDatasetRegistry(
    registry({
      entries: [
        entry({
          sources: [
            source({
              consent: {
                basis: 'project_owned_authored',
                containsPersonalData: true,
                personalDataHandling: 'pseudonymized',
                redistribution: 'allowed_with_attribution',
                reviewedBy: 'model-data track',
                reviewedAt: '2026-07-31T00:00:00.000Z',
              },
            }),
          ],
        }),
      ],
    }),
  );

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'SRC022'));
});

test('registry: lineage must resolve to a declared source or a registered dataset', () => {
  const result = validateDatasetRegistry(
    registry({
      entries: [
        entry({
          lineage: {
            derivedFrom: ['source:not-declared', 'missing-dataset'],
            producedBy: { script: 'scripts/generate.py', version: 'v1', seed: 1 },
          },
        }),
      ],
    }),
  );

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'LIN010'));
  assert.ok(hasIssue(result, 'LIN011'));
});

test('registry: a lineage cycle is rejected', () => {
  const a = entry({
    id: 'dataset-a',
    lineage: {
      derivedFrom: ['dataset-b'],
      producedBy: { script: 'scripts/a.py', version: 'v1', seed: 1 },
    },
    artifacts: [artifact({ id: 'artifact-a' })],
  });
  const b = entry({
    id: 'dataset-b',
    lineage: {
      derivedFrom: ['dataset-a'],
      producedBy: { script: 'scripts/b.py', version: 'v1', seed: 1 },
    },
    artifacts: [artifact({ id: 'artifact-b' })],
  });

  const result = validateDatasetRegistry(registry({ entries: [a, b] }));
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'LIN013'));
});

test('registry: an artifact path may not escape its repository root', () => {
  const result = validateDatasetRegistry(
    registry({
      entries: [
        entry({
          artifacts: [
            artifact({
              location: { repository: 'fixture-repo', revision: 'abc123', path: '../secrets/data.jsonl' },
            }),
          ],
        }),
      ],
    }),
  );

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'ART013'));
});

test('verify: drifted bytes fail hard for a locked artifact and warn for a mutable one', () => {
  const fixture = registry({
    entries: [
      entry({
        status: 'draft',
        artifacts: [
          artifact({ id: 'locked-cases', mutability: 'locked' }),
          artifact({
            id: 'scratch-cases',
            role: 'valid',
            mutability: 'mutable',
            location: { repository: 'fixture-repo', revision: 'abc123', path: 'data/scratch.jsonl' },
          }),
        ],
      }),
    ],
  });

  const drifted: ArtifactReader = (_repository, _revision, artifactPath) => ({
    checksum: checksum(artifactPath === 'data/locked-cases.jsonl' ? 'dead' : 'beef'),
    recordCount: 10,
    byteSize: 100,
  });

  const result = verifyRegistryArtifacts(fixture, drifted);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'VER010'));
  assert.ok(hasIssue(result, 'VER011'));
  assert.equal(result.issues.find((issue) => issue.code === 'VER011')?.severity, 'warning');
});

test('verify: a materialized artifact that is missing on disk fails', () => {
  const result = verifyRegistryArtifacts(registry(), () => null);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'VER001'));
});

test('verify: a matching artifact passes and leaves no issues', () => {
  const fixture = registry();
  const declared = fixture.entries[0].artifacts[0];
  const result = verifyRegistryArtifacts(fixture, () => ({
    checksum: clone(declared.checksum),
    recordCount: declared.recordCount,
    byteSize: declared.byteSize,
  }));

  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test('fingerprint: canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
  assert.deepEqual(
    fingerprintConfig({ seed: 42, maxTokens: 384 }),
    fingerprintConfig({ maxTokens: 384, seed: 42 }),
  );
});

test('fingerprint: a changed config value changes the fingerprint', () => {
  assert.notEqual(
    fingerprintConfig({ seed: 42, maxTokens: 384 }).value,
    fingerprintConfig({ seed: 43, maxTokens: 384 }).value,
  );
});
