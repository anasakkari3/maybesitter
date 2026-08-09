import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupPilotData, restorePilotData } from '../../lib/operations/pilotDataBackup.ts';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function sampleDataRoot(): string {
  const root = tempDir('maybesitter-backup-source-');
  const participants = path.join(root, 'participants');
  mkdirSync(participants, { recursive: true });
  writeFileSync(path.join(root, 'pilot-trust.json'), JSON.stringify({
    version: 'v1',
    participants: {
      'ops-100': {
        version: 'v1',
        participantId: 'ops-100',
        recommendationConsent: true,
        analyticsConsent: true,
        calendarConsent: false,
        firstValueAt: '2026-08-10T10:00:00.000Z',
        quietMode: false,
        revokedAt: null,
        deletedAt: null,
        updatedAt: '2026-08-10T10:00:00.000Z',
      },
    },
    auditEvents: [],
    incidents: [],
  }, null, 2));
  writeFileSync(path.join(participants, 'ops-100-state.json'), JSON.stringify({ commitments: { c1: { id: 'c1' } } }));
  writeFileSync(path.join(participants, 'ops-100-recommendation-actions.json'), JSON.stringify({
    actionKey: { fingerprint: 'fingerprint', response: { success: true } },
  }));
  return root;
}

test('backup creates an external timestamped copy with participant, trust, and idempotency state', () => {
  const source = sampleDataRoot();
  const backupRoot = tempDir('maybesitter-backup-root-');
  const before = readFileSync(path.join(source, 'participants', 'ops-100-state.json'), 'utf8');

  const backup = backupPilotData({
    sourceDir: source,
    backupRoot,
    now: new Date('2026-08-10T12:00:00.000Z'),
  });

  assert.equal(backup.backupPath, path.join(backupRoot, 'pilot-backup-2026-08-10T12-00-00-000Z'));
  assert.equal(existsSync(path.join(backup.dataPath, 'participants', 'ops-100-state.json')), true);
  assert.equal(existsSync(path.join(backup.dataPath, 'pilot-trust.json')), true);
  assert.equal(existsSync(path.join(backup.dataPath, 'participants', 'ops-100-recommendation-actions.json')), true);
  assert.equal(existsSync(backup.manifestPath), true);
  assert.equal(readFileSync(path.join(source, 'participants', 'ops-100-state.json'), 'utf8'), before);
});

test('backup rejects destination equal to source or nested under source', () => {
  const source = sampleDataRoot();
  assert.throws(
    () => backupPilotData({ sourceDir: source, backupRoot: source, label: 'same' }),
    /backup root must not equal MAYBESITTER_DATA_DIR/,
  );
  assert.throws(
    () => backupPilotData({ sourceDir: source, backupRoot: path.join(source, 'backups'), label: 'nested' }),
    /backup root must not be nested inside MAYBESITTER_DATA_DIR/,
  );
});

test('backup refuses to overwrite an existing backup label', () => {
  const source = sampleDataRoot();
  const backupRoot = tempDir('maybesitter-backup-root-');
  backupPilotData({ sourceDir: source, backupRoot, label: 'fixed-label' });
  assert.throws(
    () => backupPilotData({ sourceDir: source, backupRoot, label: 'fixed-label' }),
    /backup already exists/,
  );
});

test('backup fails clearly when source is missing or invalid', () => {
  const backupRoot = tempDir('maybesitter-backup-root-');
  assert.throws(
    () => backupPilotData({ sourceDir: path.join(tmpdir(), 'missing-maybesitter-source'), backupRoot }),
    /MAYBESITTER_DATA_DIR does not exist/,
  );
  assert.throws(
    () => backupPilotData({ sourceDir: 'relative-source', backupRoot }),
    /MAYBESITTER_DATA_DIR must be an absolute path/,
  );
});

test('restore requires a complete backup and protects non-empty targets by default', () => {
  const source = sampleDataRoot();
  const backup = backupPilotData({ sourceDir: source, backupRoot: tempDir('maybesitter-backup-root-'), label: 'restoreable' });
  const target = tempDir('maybesitter-restore-target-');
  writeFileSync(path.join(target, 'existing.txt'), 'do not overwrite');

  assert.throws(
    () => restorePilotData({ backupPath: backup.backupPath, targetDir: target }),
    /restore target is not empty/,
  );

  const restored = restorePilotData({ backupPath: backup.backupPath, targetDir: target, replaceExisting: true });
  assert.equal(restored.restoredTo, target);
  assert.equal(existsSync(path.join(target, 'pilot-trust.json')), true);
  assert.equal(existsSync(path.join(target, 'participants', 'ops-100-state.json')), true);
  assert.equal(existsSync(path.join(target, 'participants', 'ops-100-recommendation-actions.json')), true);
  assert.equal(existsSync(path.join(target, 'existing.txt')), false);
});

test('restore rejects self-referential and incomplete backup paths', () => {
  const source = sampleDataRoot();
  const backup = backupPilotData({ sourceDir: source, backupRoot: tempDir('maybesitter-backup-root-'), label: 'safe' });
  assert.throws(
    () => restorePilotData({ backupPath: backup.backupPath, targetDir: path.join(backup.backupPath, 'target') }),
    /restore target must not be nested inside backup source/,
  );

  const incomplete = tempDir('maybesitter-incomplete-backup-');
  assert.throws(
    () => restorePilotData({ backupPath: incomplete, targetDir: tempDir('maybesitter-restore-target-') }),
    /missing pilot-backup-manifest/,
  );
});
