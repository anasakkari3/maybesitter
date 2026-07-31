import test from 'node:test';
import assert from 'node:assert/strict';

import { validateLockedArtifactLedger } from '../../lib/evaluation/registry/validateLockLedger.ts';
import { chainHead } from '../../lib/evaluation/registry/lockChain.ts';
import { hasIssue } from '../../lib/evaluation/registry/validationPrimitives.ts';
import { artifact, checksum, clone, entry, ledger, lockRecord, registry, seal } from './registryFixtures.ts';

test('locked test: registry and ledger that agree validate', () => {
  const result = validateLockedArtifactLedger(ledger(), registry());
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('locked test: changing a locked artifact checksum fails validation', () => {
  const drifted = clone(registry());
  drifted.entries[0].artifacts[0].checksum = checksum('dead');

  const result = validateLockedArtifactLedger(ledger(), drifted);

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'LCK043'));
  assert.match(
    result.issues.find((issue) => issue.code === 'LCK043')?.message ?? '',
    /immutable/,
  );
});

test('locked test: changing a locked artifact record count fails validation', () => {
  const drifted = clone(registry());
  drifted.entries[0].artifacts[0].recordCount = 11;

  const result = validateLockedArtifactLedger(ledger(), drifted);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'LCK044'));
});

test('locked test: rewriting a sealed ledger row to hide a checksum change breaks the chain', () => {
  const drifted = clone(registry());
  drifted.entries[0].artifacts[0].checksum = checksum('dead');

  // Editing the ledger row in place makes the two files agree with each other,
  // but the row still carries the chain checksum it was sealed with.
  const tampered = clone(ledger());
  tampered.records[0].checksum = checksum('dead');

  const result = validateLockedArtifactLedger(tampered, drifted);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'LCK060'));
  assert.match(result.issues.find((issue) => issue.code === 'LCK060')?.message ?? '', /append-only/);
});

test('locked test: appending a row does not disturb the chain of earlier rows', () => {
  const first = ledger();
  const appended = seal({
    contractVersion: '1.0.0',
    records: [...first.records, lockRecord({ artifactId: 'second-artifact', checksum: checksum('beef') })],
  });

  assert.deepEqual(appended.records[0].chainChecksum, first.records[0].chainChecksum);
  assert.notDeepEqual(appended.records[1].chainChecksum, first.records[0].chainChecksum);
});

test('locked test: dropping a row from ledger history breaks the chain', () => {
  const history = seal({
    contractVersion: '1.0.0',
    records: [
      lockRecord({ artifactId: 'first-artifact' }),
      lockRecord({ artifactId: 'sample-artifact', checksum: checksum('sample-artifact') }),
    ],
  });

  const truncated = { contractVersion: '1.0.0', records: [history.records[1]] };

  const result = validateLockedArtifactLedger(truncated, registry());
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'LCK060'));
});

test('locked test: a chain head pins the whole ledger', () => {
  const before = chainHead(ledger().records);

  const tampered = clone(ledger());
  tampered.records[0].lockedBy = 'someone else';

  assert.notEqual(chainHead(tampered.records), before);
});

test('locked test: a locked artifact with no ledger record fails', () => {
  const result = validateLockedArtifactLedger(ledger({ records: [] }), registry());
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'LCK050'));
});

test('locked test: an active lock on an artifact that is not locked fails', () => {
  const unlocked = clone(registry());
  unlocked.entries[0].status = 'draft';
  unlocked.entries[0].artifacts[0].mutability = 'append_only';

  const result = validateLockedArtifactLedger(ledger(), unlocked);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'LCK042'));
});

test('locked test: an active lock may not carry supersession fields', () => {
  const result = validateLockedArtifactLedger(
    ledger({ records: [lockRecord({ supersessionReason: 'oops' })] }),
    registry(),
  );

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'LCK020'));
});

test('locked test: supersession requires a successor, an issue, and a reason', () => {
  const incomplete = ledger({
    records: [lockRecord({ state: 'superseded' })],
  });

  const result = validateLockedArtifactLedger(incomplete, registry());
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'LCK021'));
  assert.ok(hasIssue(result, 'LCK024'));
  assert.ok(hasIssue(result, 'LCK025'));
});

test('locked test: an artifact may not supersede itself', () => {
  const selfSuperseding = ledger({
    records: [
      lockRecord({
        state: 'superseded',
        supersededBy: 'sample-artifact',
        supersessionIssue: 'https://github.com/anasakkari3/maybesitter/issues/2',
        supersessionReason: 'fixed a typo in one case',
      }),
    ],
  });

  const result = validateLockedArtifactLedger(selfSuperseding, registry());
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'LCK023'));
});

test('locked test: the documented supersession procedure validates end to end', () => {
  // v1 is retired and replaced by v2 under a new artifact id, as
  // docs/data/DATASET_REGISTRY.md requires.
  const successor = registry({
    entries: [
      entry({
        id: 'sample-dataset',
        artifacts: [
          artifact({
            id: 'sample-artifact-v2',
            checksum: checksum('dead'),
            location: { repository: 'fixture-repo', revision: 'abc123', path: 'data/sample-artifact-v2.jsonl' },
          }),
        ],
      }),
    ],
  });

  const history = ledger({
    records: [
      lockRecord({
        state: 'superseded',
        supersededBy: 'sample-artifact-v2',
        supersessionIssue: 'https://github.com/anasakkari3/maybesitter/issues/2',
        supersessionReason: 'two injection cases had unreachable reference times',
      }),
      lockRecord({
        artifactId: 'sample-artifact-v2',
        checksum: checksum('dead'),
        authorizingIssue: 'https://github.com/anasakkari3/maybesitter/issues/2',
      }),
    ],
  });

  const result = validateLockedArtifactLedger(history, successor);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('locked test: a superseded artifact may not stay registered as locked', () => {
  const stillLocked = registry({
    entries: [
      entry({
        artifacts: [
          artifact({ id: 'sample-artifact' }),
          artifact({
            id: 'sample-artifact-v2',
            checksum: checksum('dead'),
            location: { repository: 'fixture-repo', revision: 'abc123', path: 'data/sample-artifact-v2.jsonl' },
          }),
        ],
      }),
    ],
  });

  const history = ledger({
    records: [
      lockRecord({
        state: 'superseded',
        supersededBy: 'sample-artifact-v2',
        supersessionIssue: 'https://github.com/anasakkari3/maybesitter/issues/2',
        supersessionReason: 'replaced by v2',
      }),
      lockRecord({ artifactId: 'sample-artifact-v2', checksum: checksum('dead') }),
    ],
  });

  const result = validateLockedArtifactLedger(history, stillLocked);
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'LCK051'));
});

test('locked test: a lock must reference the issue that authorized it', () => {
  const result = validateLockedArtifactLedger(
    ledger({ records: [lockRecord({ authorizingIssue: '' })] }),
    registry(),
  );

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'LCK017'));
});
