/**
 * Rotating the deletion-receipt pepper without losing a deletion (#798).
 *
 * Since #794 the pepper names the deletion job record, which is also the
 * tombstone a uid's first request reads: `accountDeletions/{HMAC(pepper, uid)}`.
 * A rotation must therefore:
 *
 *   - finish a job begun under the old key at the path it is stored at, not at
 *     one re-derived from its uid with the new key;
 *   - find an old-key job or tombstone before minting a new one;
 *   - keep every live revision able to read the key any live revision writes,
 *     which is the two-phase cutover `infra/cloudrun/flags.sh` emits from
 *     `infra/cloudrun/pepper-rotation.env`.
 *
 * The last block runs the real flags.sh for each phase and replays its env
 * against the real engine and trust store, so the phases the deploy produces
 * are the phases tested here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCOUNT_DELETIONS,
  DELETION_RECEIPTS,
  MAX_DELETION_ATTEMPTS,
  RESUME_AFTER_MS,
  deleteAccount,
  resumeStalledDeletions,
  subjectHashFor,
  type DeletionAuthAdmin,
  type DeletionJobRecord,
  type DeletionReceipt,
} from '../../lib/account/accountDeletion.ts';
import { resetDeletionHooksForTests } from '../../lib/account/deletionHooks.ts';
import { deletionJobLocations, deletionPepperWrite, deletionTombstonePaths } from '../../lib/account/deletionTombstone.ts';
import { AccountUnavailableError } from '../../lib/account/accountLiveness.ts';
import { getOrCreateTrust } from '../../lib/pilot/pilotTrustStore.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';

const OLD = 'pepper-798-old-key-not-real';
const NEW = 'pepper-798-new-key-not-real';
/** Firebase uids: 28 characters, mixed case. */
const UID = 'Pr798RoTaTeDaCcOuNt000000001';
const OTHER = 'Pr798UnTouChEdAcCoUnT0000002';

const PEPPER = 'MAYBESITTER_DELETION_RECEIPT_PEPPER';
const PREVIOUS = 'MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS';
const WRITE = 'MAYBESITTER_DELETION_RECEIPT_PEPPER_WRITE';
const ENV_NAMES = [PEPPER, PREVIOUS, WRITE, 'FIRESTORE_EMULATOR_HOST', 'MAYBESITTER_STORAGE_BACKEND', 'K_SERVICE'] as const;

type PepperEnv = Partial<Record<typeof PEPPER | typeof PREVIOUS | typeof WRITE, string>>;

/** The runbook's phases, as the app sees them. */
const PHASE_0: PepperEnv = { [PEPPER]: OLD };
const PHASE_1: PepperEnv = { [PEPPER]: NEW, [PREVIOUS]: OLD, [WRITE]: 'previous' };
const PHASE_2: PepperEnv = { [PEPPER]: NEW, [PREVIOUS]: OLD, [WRITE]: 'current' };
const PHASE_3: PepperEnv = { [PEPPER]: NEW };

const oldPath = (uid = UID) => `${ACCOUNT_DELETIONS}/${subjectHashFor(uid, OLD)}`;
const newPath = (uid = UID) => `${ACCOUNT_DELETIONS}/${subjectHashFor(uid, NEW)}`;

function fakeAuth(failDelete = false): DeletionAuthAdmin & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async revokeRefreshTokens() {},
    async deleteUser(uid) {
      if (failDelete) throw new Error('instance went away');
      deleted.push(uid);
    },
  };
}

/** Switches the pepper env, as a deploy to the next phase would. */
function usePeppers(env: PepperEnv): void {
  for (const name of [PEPPER, PREVIOUS, WRITE] as const) {
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
}

function begin(env: PepperEnv): { storage: MemoryStorageAdapter; end: () => void } {
  const saved: Record<string, string | undefined> = {};
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  for (const name of ENV_NAMES) delete process.env[name];
  usePeppers(env);
  resetDeletionHooksForTests();
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  return {
    storage,
    end() {
      resetStorageForTests();
      resetDeletionHooksForTests();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

async function jobIds(storage: MemoryStorageAdapter): Promise<string[]> {
  return (await storage.list<DeletionJobRecord>(ACCOUNT_DELETIONS)).map((row) => `${ACCOUNT_DELETIONS}/${row.id}`).sort();
}

/** A deletion under the old key that died after `markDeleted`: in progress, holding the uid. */
async function interruptedOldKeyJob(storage: MemoryStorageAdapter): Promise<void> {
  usePeppers(PHASE_0);
  await storage.set(userDoc(UID), { trust: { version: 'v1', participantId: UID, updatedAt: '2026-10-01T00:00:00.000Z' } });
  await assert.rejects(() => deleteAccount(UID, { initiatedBy: 'user', storage, auth: fakeAuth(true) }));
  const job = await storage.get<DeletionJobRecord>(oldPath());
  assert.equal(job?.status, 'in_progress');
  assert.equal(job?.uid, UID);
}

// ── Resume by the stored path ───────────────────────────────────────────

test('an old-key job in progress is resumed and finished at its stored path, after the old key is gone', async () => {
  const { storage, end } = begin(PHASE_0);
  try {
    await interruptedOldKeyJob(storage);

    // The sweep runs on a revision that no longer knows the old key at all
    // (phase 3): resuming must not need it.
    usePeppers(PHASE_3);
    const auth = fakeAuth();
    const swept = await resumeStalledDeletions({ now: new Date(Date.now() + RESUME_AFTER_MS + 60_000), storage, auth });

    assert.equal(swept.resumed, 1);
    assert.deepEqual(auth.deleted, [UID]);
    const job = await storage.get<DeletionJobRecord>(oldPath());
    assert.equal(job?.status, 'done', 'the old-key job was left in progress');
    assert.equal(job?.uid, undefined, 'the old-key job still holds the raw uid');
    assert.deepEqual(await jobIds(storage), [oldPath()], 'resuming minted a second job under the new key');
    const receipts = await storage.list<DeletionReceipt>(DELETION_RECEIPTS);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.data.subjectHash, subjectHashFor(UID, OLD), 'the receipt is not named by the key the job was begun under');
  } finally {
    end();
  }
});

test('an old-key job that ran out of attempts is marked stuck where it is stored', async () => {
  const { storage, end } = begin(PHASE_0);
  try {
    const subjectHash = subjectHashFor(UID, OLD);
    await storage.set<DeletionJobRecord>(oldPath(), {
      version: 'v1', uid: UID, subjectHash, status: 'in_progress', steps: { markDeleted: 'done' }, initiatedBy: 'user',
      startedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', attempts: MAX_DELETION_ATTEMPTS, docsDeleted: 0,
    });
    usePeppers(PHASE_2);
    const swept = await resumeStalledDeletions({ now: new Date(), storage, auth: fakeAuth() });
    assert.equal(swept.stuck, 1);
    assert.equal((await storage.get<DeletionJobRecord>(oldPath()))?.status, 'stuck');
    assert.deepEqual(await jobIds(storage), [oldPath()]);
  } finally {
    end();
  }
});

// ── A repeat request finds the other key's job ──────────────────────────

for (const [name, env] of [['phase 1', PHASE_1], ['phase 2', PHASE_2]] as const) {
  test(`a repeat deletion in ${name} finishes the old-key job and mints no second one`, async () => {
    const { storage, end } = begin(PHASE_0);
    try {
      await interruptedOldKeyJob(storage);
      usePeppers(env);
      const auth = fakeAuth();
      const receipt = await deleteAccount(UID, { initiatedBy: 'user', storage, auth });

      assert.equal(receipt.subjectHash, subjectHashFor(UID, OLD));
      assert.deepEqual(await jobIds(storage), [oldPath()], 'a second deletion job was minted');
      assert.equal((await storage.get<DeletionJobRecord>(oldPath()))?.status, 'done');
      assert.equal((await storage.list(DELETION_RECEIPTS)).length, 1);
    } finally {
      end();
    }
  });

  test(`a repeat deletion in ${name} after an old-key deletion finished returns that receipt`, async () => {
    const { storage, end } = begin(PHASE_0);
    try {
      const first = await deleteAccount(UID, { initiatedBy: 'user', storage, auth: fakeAuth() });
      usePeppers(env);
      const auth = fakeAuth();
      const again = await deleteAccount(UID, { initiatedBy: 'operator', storage, auth });

      assert.equal(again.receiptId, first.receiptId, 'a second receipt was minted for one deletion');
      assert.deepEqual(auth.deleted, [], 'the finished deletion ran again');
      assert.deepEqual(await jobIds(storage), [oldPath()]);
    } finally {
      end();
    }
  });
}

test('an unfinished job under one key wins over a done job under the other', async () => {
  // Two records for one uid (a second job minted before #798, say): the done
  // one's receipt must not hide the one still holding the raw uid.
  const { storage, end } = begin(PHASE_0);
  try {
    await interruptedOldKeyJob(storage);
    const newHash = subjectHashFor(UID, NEW);
    await storage.set(`${DELETION_RECEIPTS}/receipt-under-new-key`, { version: 'v1', receiptId: 'receipt-under-new-key', subjectHash: newHash });
    await storage.set<DeletionJobRecord>(newPath(), {
      version: 'v1', subjectHash: newHash, status: 'done', steps: {}, initiatedBy: 'user',
      startedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', attempts: 1, docsDeleted: 0,
      receiptId: 'receipt-under-new-key',
    });

    usePeppers(PHASE_2); // the writer's (new-key) path is checked first
    const auth = fakeAuth();
    const receipt = await deleteAccount(UID, { initiatedBy: 'user', storage, auth });

    assert.equal(receipt.subjectHash, subjectHashFor(UID, OLD), 'the done job\'s receipt was returned and the unfinished one left');
    assert.deepEqual(auth.deleted, [UID]);
    const old = await storage.get<DeletionJobRecord>(oldPath());
    assert.equal(old?.status, 'done');
    assert.equal(old?.uid, undefined, 'the unfinished job still holds the raw uid');
  } finally {
    end();
  }
});

test('a phase-1 job (old key) found again in phase 3 would be missed: why PREVIOUS stays for the TTL', async () => {
  // Not a behaviour to keep, a boundary to know: once PREVIOUS is dropped, only
  // the sweep (stored path) can still reach an old-key job. The runbook drops it
  // only after the TTL and an empty `in_progress`/`stuck` query.
  const { storage, end } = begin(PHASE_1);
  try {
    await deleteAccount(UID, { initiatedBy: 'user', storage, auth: fakeAuth() });
    assert.deepEqual(await jobIds(storage), [oldPath()]);
    assert.deepEqual(deletionJobLocations(UID).map((l) => `${ACCOUNT_DELETIONS}/${l.subjectHash}`), [oldPath(), newPath()]);
    usePeppers(PHASE_3);
    assert.deepEqual(deletionJobLocations(UID).map((l) => `${ACCOUNT_DELETIONS}/${l.subjectHash}`), [newPath()]);
  } finally {
    end();
  }
});

// ── The writer selector ─────────────────────────────────────────────────

test('the writer switch is honoured: phase 1 writes the old key, phase 2 the new one', async () => {
  const { storage, end } = begin(PHASE_1);
  try {
    await deleteAccount(UID, { initiatedBy: 'user', storage, auth: fakeAuth() });
    assert.deepEqual(await jobIds(storage), [oldPath(UID)]);

    usePeppers(PHASE_2);
    await deleteAccount(OTHER, { initiatedBy: 'user', storage, auth: fakeAuth() });
    assert.deepEqual(await jobIds(storage), [newPath(OTHER), oldPath(UID)].sort());

    usePeppers(PHASE_0);
    assert.equal(deletionPepperWrite(), 'current', 'unset must mean current');
  } finally {
    end();
  }
});

test('a writer selector that cannot be honoured refuses the deletion and writes nothing', async () => {
  for (const env of [
    { [PEPPER]: NEW, [WRITE]: 'previous' },
    { [PEPPER]: NEW, [PREVIOUS]: OLD, [WRITE]: 'old' },
    { [PEPPER]: NEW, [PREVIOUS]: OLD, [WRITE]: 'Previous' },
  ] satisfies PepperEnv[]) {
    const { storage, end } = begin(env);
    try {
      await storage.set(userDoc(UID), { trust: { version: 'v1', participantId: UID, updatedAt: '2026-10-01T00:00:00.000Z' } });
      const auth = fakeAuth();
      await assert.rejects(() => deleteAccount(UID, { initiatedBy: 'user', storage, auth }), /MAYBESITTER_DELETION_RECEIPT_PEPPER_WRITE/);
      assert.deepEqual(await jobIds(storage), [], JSON.stringify(env[WRITE]));
      assert.deepEqual(auth.deleted, []);
      assert.ok(await storage.get(userDoc(UID)), 'the account was touched before the refusal');
    } finally {
      end();
    }
  }
});

test('readers list the writer\'s key first, and never refuse over the writer selector', () => {
  // A writer that takes the first entry (the OAuth cleanup obligation's
  // `accountKey`, #800) then writes the key every live revision reads.
  const { end } = begin(PHASE_1);
  try {
    const paths = () => deletionTombstonePaths(UID, { sharedStorage: true });
    assert.deepEqual(paths(), [oldPath(), newPath()]);
    usePeppers(PHASE_2);
    assert.deepEqual(paths(), [newPath(), oldPath()]);
    usePeppers(PHASE_0);
    assert.deepEqual(paths(), [oldPath()]);
    // A broken selector is a writer problem: the first request still reads every key.
    usePeppers({ [PEPPER]: NEW, [PREVIOUS]: OLD, [WRITE]: 'old' });
    assert.deepEqual(paths(), [newPath(), oldPath()]);
    usePeppers({ [PEPPER]: NEW, [WRITE]: 'previous' });
    assert.deepEqual(paths(), [newPath()]);
  } finally {
    end();
  }
});

// ── Tombstones across the cutover ───────────────────────────────────────

test('an old-key tombstone still blocks the uid\'s first request in phase 1 and phase 2', async () => {
  const { storage, end } = begin(PHASE_0);
  try {
    await deleteAccount(UID, { initiatedBy: 'user', storage, auth: fakeAuth() });
    assert.equal(await storage.get(userDoc(UID)), null);
    for (const env of [PHASE_1, PHASE_2]) {
      usePeppers(env);
      await assert.rejects(() => getOrCreateTrust(UID, '2026-10-24T10:00:00.000Z'), AccountUnavailableError);
      assert.equal(await storage.get(userDoc(UID)), null, 'a deleted account was re-created');
      // Only that uid: another account's first request is untouched.
      await getOrCreateTrust(OTHER, '2026-10-24T10:00:00.000Z');
      await storage.delete(userDoc(OTHER));
    }
  } finally {
    end();
  }
});

// ── The phases flags.sh actually emits ──────────────────────────────────

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Secret Manager versions in the fixtures: 1 is the old key, 2 the new one. */
const VERSION_VALUE: Record<string, string> = { latest: OLD, '1': OLD, '2': NEW };

/** The pepper env a revision deployed by flags.sh for one rotation state would run with. */
function deployedEnv(phase: string, current: string, previous: string): PepperEnv {
  const dir = mkdtempSync(join(tmpdir(), 'pepper-rotation-798-app-'));
  try {
    const file = join(dir, 'pepper-rotation.env');
    writeFileSync(file, [
      `staging_phase=${phase}`, `staging_current_version=${current}`, `staging_previous_version=${previous}`,
      'production_phase=steady', 'production_current_version=latest', 'production_previous_version=',
    ].join('\n') + '\n');
    const result = spawnSync('bash', [join(repoRoot, 'infra/cloudrun/flags.sh'), 'staging'], {
      encoding: 'utf8',
      env: { ...process.env, MAYBESITTER_PEPPER_ROTATION_FILE: file },
    });
    assert.equal(result.status, 0, result.stderr);
    const env: PepperEnv = {};
    const secrets = /--set-secrets=(\S+)/.exec(result.stdout)![1]!;
    for (const pair of secrets.split(',')) {
      const [name, mapping] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
      if (name !== PEPPER && name !== PREVIOUS) continue;
      const value = VERSION_VALUE[mapping.slice(mapping.lastIndexOf(':') + 1)];
      assert.ok(value, `unexpected version in ${mapping}`);
      env[name] = value;
    }
    const write = /MAYBESITTER_DELETION_RECEIPT_PEPPER_WRITE=([a-z]+)/.exec(result.stdout);
    assert.ok(write, 'flags.sh no longer sets the writer selector');
    env[WRITE] = write[1];
    return env;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether a deletion on the writer revision blocks a first request on the reader revision. */
async function blocks(writer: PepperEnv, reader: PepperEnv): Promise<boolean> {
  const { storage, end } = begin(writer);
  try {
    await deleteAccount(UID, { initiatedBy: 'user', storage, auth: fakeAuth() });
    usePeppers(reader);
    try {
      await getOrCreateTrust(UID, '2026-10-24T10:00:00.000Z');
      return false;
    } catch (error) {
      if (error instanceof AccountUnavailableError) return true;
      throw error;
    }
  } finally {
    end();
  }
}

test('during every deploy of the runbook, a deletion on either live revision blocks a first request on the other', async () => {
  // The revision serving before the rotation may predate #798 and set no
  // writer selector at all; unset reads as `current`, which is what flags.sh
  // now writes out for the same state.
  assert.deepEqual(deployedEnv('steady', 'latest', ''), { ...PHASE_0, [WRITE]: 'current' });
  const phases = [
    ['steady on v1 (pre-#798 revision)', PHASE_0],
    ['phase 1 (readers)', deployedEnv('readers', '2', '1')],
    ['phase 2 (writer)', deployedEnv('writer', '2', '1')],
    ['steady on v2', deployedEnv('steady', '2', '')],
  ] as const;
  assert.deepEqual(phases.map(([, env]) => env), [PHASE_0, PHASE_1, PHASE_2, { ...PHASE_3, [WRITE]: 'current' }], 'flags.sh no longer emits the runbook phases');

  // A deploy serves the old and the new revision together, in both directions.
  for (let i = 0; i + 1 < phases.length; i += 1) {
    const [olderName, older] = phases[i]!;
    const [newerName, newer] = phases[i + 1]!;
    assert.equal(await blocks(older, newer), true, `${olderName} writes a tombstone ${newerName} cannot read`);
    assert.equal(await blocks(newer, older), true, `${newerName} writes a tombstone ${olderName} cannot read`);
  }

  // Why phase 2 waits for phase-0 revisions to drain: skipping phase 1 is the
  // old-reader / new-writer gap of #798.
  assert.equal(await blocks(phases[2]![1], phases[0]![1]), false, 'the skipped step is unexpectedly safe; recheck this test');
});
