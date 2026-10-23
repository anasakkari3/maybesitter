/**
 * Saving the survey twice (UC-2.7a, #167).
 *
 * Reconciliation is the part with real semantics: what happens to yesterday's
 * answer when today's is different, and what happens to it when today's is the
 * same. Getting either wrong is invisible in a single save and obvious after a
 * month of them — a memory screen showing five copies of "I sleep at 23:30", or
 * a quiet-hours answer the user removed still being enforced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import {
  readRoutineProfile,
  saveRoutineProfile,
} from '../../lib/services/mobile/routineProfileService.ts';
import type { RoutineProfileInput } from '../../src/contracts/v1/routineContracts.ts';
import type { RuntimeMemoryRecord } from '../../src/contracts/v1/memoryContracts.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';

const UID = 'RoutineProfileUser';
const FIRST = '2026-09-13T09:00:00.000Z';
const SECOND = '2026-09-14T09:00:00.000Z';

function input(overrides: Partial<RoutineProfileInput> = {}): RoutineProfileInput {
  return {
    timezone: 'Asia/Jerusalem',
    sleepWindow: { start: '23:30', end: '07:30' },
    focusWindows: [{ start: '09:00', end: '17:00', label: 'work_study' }],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'softAwareness',
    quietHours: { start: '22:30', end: '07:30' },
    surveySkipped: false,
    ...overrides,
  };
}

async function begin(): Promise<void> {
  setStorageForTests(createMemoryStorage());
  // Live accounts, as authentication leaves them: the writers these tests
  // drive directly re-read the account deletion fence (#772).
  await seedLiveAccount(UID);
}

function end(): void {
  resetStorageForTests();
}

async function allRecords(): Promise<readonly RuntimeMemoryRecord[]> {
  return createStorageRuntimeMemoryStore().listAll(UID);
}

async function activeContents(): Promise<string[]> {
  return (await allRecords()).filter((r) => r.status === 'active').map((r) => r.content).sort();
}

test('a first save stores the profile and one fact per answer', async () => {
  await begin();
  try {
    const result = await saveRoutineProfile(UID, input(), FIRST);
    assert.equal(result.facts.created, 4);
    assert.equal(result.facts.superseded, 0);

    const stored = await readRoutineProfile(UID);
    assert.equal(stored?.updatedAt, FIRST, 'the profile did not take the save instant');
    assert.equal(stored?.quietHours?.start, '22:30');
    assert.deepEqual(await activeContents(), [
      'focus_window:09:00-17:00',
      'quiet_hours:22:30-07:30',
      'reminder_intensity:softAwareness',
      'sleep_window:23:30-07:30',
    ]);
  } finally {
    end();
  }
});

test('re-saving an unchanged survey changes nothing and creates no duplicates', async () => {
  await begin();
  try {
    await saveRoutineProfile(UID, input(), FIRST);
    const before = (await allRecords()).map((r) => r.id).sort();

    const again = await saveRoutineProfile(UID, input(), SECOND);
    assert.deepEqual(again.facts, { created: 0, superseded: 0, revoked: 0, unchanged: 4 });
    assert.deepEqual((await allRecords()).map((r) => r.id).sort(), before, 'the ids moved on an identical save');
  } finally {
    end();
  }
});

test('a changed answer supersedes the old one and keeps it inspectable', async () => {
  await begin();
  try {
    await saveRoutineProfile(UID, input(), FIRST);
    const result = await saveRoutineProfile(UID, input({ sleepWindow: { start: '00:30', end: '08:30' } }), SECOND);

    assert.equal(result.facts.superseded, 1);
    assert.equal(result.facts.unchanged, 3);

    const records = await allRecords();
    const old = records.find((r) => r.content === 'sleep_window:23:30-07:30');
    const fresh = records.find((r) => r.content === 'sleep_window:00:30-08:30');
    assert.equal(old?.status, 'superseded', 'the previous answer is not marked superseded');
    assert.equal(old?.supersededById, fresh?.id, 'the chain does not link forward');
    assert.equal(fresh?.supersedesId, old?.id, 'the chain does not link back');
    assert.equal(fresh?.status, 'active');
    // The history is kept, but only the current answer is visible.
    assert.ok(!(await activeContents()).includes('sleep_window:23:30-07:30'));
  } finally {
    end();
  }
});

test('a removed answer is revoked, not left active and not silently deleted', async () => {
  await begin();
  try {
    await saveRoutineProfile(UID, input(), FIRST);
    const result = await saveRoutineProfile(UID, input({ quietHours: null }), SECOND);

    assert.equal(result.facts.revoked, 1);
    const quiet = (await allRecords()).find((r) => r.content === 'quiet_hours:22:30-07:30');
    assert.equal(quiet?.status, 'revoked', 'a removed quiet-hours answer is still active');
    assert.ok(!(await activeContents()).includes('quiet_hours:22:30-07:30'));
  } finally {
    end();
  }
});

test('adding a second focus window leaves the first one alone', async () => {
  await begin();
  try {
    await saveRoutineProfile(UID, input(), FIRST);
    const firstFocus = (await allRecords()).find((r) => r.content === 'focus_window:09:00-17:00')!;

    const result = await saveRoutineProfile(UID, input({
      focusWindows: [
        { start: '09:00', end: '17:00', label: 'work_study' },
        { start: '20:00', end: '22:00', label: 'work_study' },
      ],
    }), SECOND);

    assert.equal(result.facts.created, 1);
    assert.equal(result.facts.superseded, 0, 'an untouched window was rewritten');
    const same = (await allRecords()).find((r) => r.id === firstFocus.id);
    assert.equal(same?.status, 'active', 'the existing focus window stopped being active');
  } finally {
    end();
  }
});

test('skipping the survey records the skip and retires the answers already given', async () => {
  await begin();
  try {
    await saveRoutineProfile(UID, input(), FIRST);
    const result = await saveRoutineProfile(UID, input({ surveySkipped: true }), SECOND);

    assert.equal((await readRoutineProfile(UID))?.surveySkipped, true);
    assert.equal(result.facts.revoked, 4, 'skipping left previous answers active');
    assert.deepEqual(await activeContents(), []);
  } finally {
    end();
  }
});

test('one account’s survey never touches another account’s facts', async () => {
  await begin();
  try {
    const other = 'RoutineProfileStranger';
    await seedLiveAccount(other); // its survey writes behind the deletion fence too (#772)
    await saveRoutineProfile(UID, input(), FIRST);
    await saveRoutineProfile(other, input({ sleepWindow: { start: '21:00', end: '05:00' } }), FIRST);

    await saveRoutineProfile(UID, input({ sleepWindow: null }), SECOND);

    const theirs = await createStorageRuntimeMemoryStore().listAll(other);
    const theirSleep = theirs.find((r) => r.content === 'sleep_window:21:00-05:00');
    assert.equal(theirSleep?.status, 'active', "the other account's answer was retired");
  } finally {
    end();
  }
});

test('a profile never written reads as absent rather than as an empty one', async () => {
  await begin();
  try {
    assert.equal(await readRoutineProfile('NeverAnswered'), null);
  } finally {
    end();
  }
});

test('M5B2A-R34-001: routine facts are never written while a purge or a withdrawal holds the personalization fence', async () => {
  await begin();
  try {
    const { getStorage } = await import('../../lib/storage/index.ts');
    const { userDoc } = await import('../../lib/storage/paths.ts');
    const { MemoryWriteRefusedError } = await import('../../lib/runtimeMemory/runtimeMemoryStore.ts');
    for (const state of ['purging', 'withdrawing'] as const) {
      await getStorage().set(userDoc(UID), { uid: UID, personalizationPurge: { state, epoch: 4 } });
      await seedLiveAccount(UID); // the trust record this overwrite dropped (#772)
      await assert.rejects(saveRoutineProfile(UID, input(), FIRST), MemoryWriteRefusedError);
      assert.equal((await allRecords()).length, 0, `a routine fact was written while ${state}`);
    }
  } finally {
    end();
  }
});

test('M5B2A-R34-001: a routine save that a purge overtakes mid-way writes nothing after it', async () => {
  await begin();
  try {
    const { getStorage } = await import('../../lib/storage/index.ts');
    const { userDoc } = await import('../../lib/storage/paths.ts');
    await getStorage().set(userDoc(UID), { uid: UID, personalizationPurge: { state: 'active', epoch: 4 } });
    await seedLiveAccount(UID); // the trust record this overwrite dropped (#772)
    const real = getStorage();
    let moved = false;
    const storage = new Proxy(real, {
      get(target, key) {
        if (key === 'list') {
          return async (...args: unknown[]) => {
            // A delete-all runs to completion after the save decided to write facts
            // (it reads the existing ones) and before it writes them.
            if (!moved) {
              moved = true;
              // The account stays live (#772): only the personalization fence moves.
              const live = (await target.get<Record<string, unknown>>(userDoc(UID))) ?? {};
              await target.set(userDoc(UID), { ...live, uid: UID, personalizationPurge: { state: 'active', epoch: 5 } });
            }
            return (target.list as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await assert.rejects(saveRoutineProfile(UID, input(), FIRST, { storage } as never));
    assert.equal((await allRecords()).length, 0, 'a routine fact was written across a completed purge');
  } finally {
    end();
  }
});
