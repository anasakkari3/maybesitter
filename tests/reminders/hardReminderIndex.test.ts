/**
 * Which Must reminders the server knows it may have to back up (UC-3.12b, #198).
 *
 * The index is written from `writeDomainDiff`, which is the single place every
 * commitment write passes through, so these tests write commitments the way the
 * product does — `persistParticipantState` and the commitment service — rather
 * than calling the index directly. A write path that stopped maintaining it
 * would fail here even if the index module itself were perfect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { HARD_REMINDERS, userCol, userDoc } from '../../lib/storage/paths.ts';
import { createEmptyDomainState, type Commitment, type DomainState } from '../../src/domain/stateMachine.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import {
  completeCommitment,
  dropCommitment,
  patchCommitment,
  postponeCommitment,
} from '../../lib/services/mobile/commitmentService.ts';
import { saveReminderSettings } from '../../lib/services/mobile/reminderSettingsService.ts';
import { saveRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';
import {
  HARD_LEAD_MS,
  hardReminderPath,
  reconcileHardReminderIndex,
  type HardReminderEntry,
} from '../../lib/services/reminders/hardReminderIndex.ts';

const USER = 'hardIndexUser';
const ZONE = 'Asia/Jerusalem';
/** Every instant in this file is relative to this one; no assertion names a date. */
const NOW = new Date('2026-09-16T06:00:00.000Z');

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  return () => resetStorageForTests();
}

function commitment(overrides: Partial<Commitment> = {}): Commitment {
  const start = new Date(NOW.getTime() + 2 * 3_600_000).toISOString();
  return {
    id: 'c1',
    kind: 'task',
    title: 'Dentist',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'none' },
    category: null,
    categorySource: 'inferred',
    timeSpec: { kind: 'scheduled_event', dueAt: start, endAt: null, remindAt: null, allDay: false, timezone: ZONE },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    confirmedAt: NOW.toISOString(),
    completedAt: null,
    droppedAt: null,
    ...overrides,
  } as Commitment;
}

async function store(...commitments: Commitment[]): Promise<DomainState> {
  const state = createEmptyDomainState();
  for (const item of commitments) state.commitments[item.id] = item;
  return persistParticipantState(USER, state);
}

/** The account has turned Must reminders on. */
async function ringing(): Promise<void> {
  await saveReminderSettings(USER, { hardEnabled: true, escalationCeiling: 'hard' }, NOW.toISOString());
}

async function row(commitmentId = 'c1'): Promise<HardReminderEntry | null> {
  return getStorage().get<HardReminderEntry>(hardReminderPath(USER, commitmentId));
}

async function rowCount(): Promise<number> {
  return (await getStorage().list(userCol(USER, HARD_REMINDERS))).length;
}

test('a Must commitment on a ringing account is indexed ten minutes before it starts', async () => {
  const teardown = setup();
  try {
    await ringing();
    const item = commitment();
    await store(item);
    const entry = await row();
    assert.equal(entry?.status, 'pending');
    assert.equal(entry?.commitmentId, 'c1');
    assert.equal(
      entry?.fireAt,
      new Date(Date.parse(item.timeSpec.dueAt as string) - HARD_LEAD_MS).toISOString(),
    );
    assert.equal(entry?.startFingerprint, item.timeSpec.dueAt);
    // Ids and instants; nothing that says what the commitment is.
    assert.ok(!JSON.stringify(entry).includes('Dentist'));
  } finally {
    teardown();
  }
});

test('nothing else is ever indexed', async () => {
  const teardown = setup();
  try {
    await ringing();
    const cases: Array<[string, Commitment]> = [
      ['a Should', commitment({ id: 'should', priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' } } as unknown as Partial<Commitment>)],
      ['a Nice', commitment({ id: 'nice', priority: { level: 'low', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' } } as unknown as Partial<Commitment>)],
      ['no time at all', commitment({ id: 'undated', timeSpec: { kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: ZONE } })],
      // Its "start" is local midnight and nobody chose that hour, so ten
      // minutes before it is ten to midnight the night before.
      ['an all-day item', commitment({ id: 'allday', timeSpec: { kind: 'due_by', dueAt: new Date(NOW.getTime() + 86_400_000).toISOString(), endAt: null, remindAt: null, allDay: true, timezone: ZONE } })],
      ['a draft', commitment({ id: 'draft', status: 'draft' })],
      ['something already completed', commitment({ id: 'done', status: 'completed' })],
    ];
    await store(...cases.map(([, item]) => item));
    for (const [name, item] of cases) {
      assert.equal(await row(item.id), null, `${name} was indexed`);
    }
    assert.equal(await rowCount(), 0);
  } finally {
    teardown();
  }
});

test('an account that has not asked for ringing indexes nothing, and asking later indexes what it already had', async () => {
  const teardown = setup();
  try {
    await store(commitment());
    assert.equal(await row(), null);

    // The settings save reconciles: the commitment was written before the
    // account had any reason to index it.
    await ringing();
    assert.equal((await row())?.status, 'pending');

    // And lowering the ceiling removes it again.
    await saveReminderSettings(USER, { hardEnabled: false, escalationCeiling: 'followUp' }, NOW.toISOString());
    assert.equal(await row(), null);
  } finally {
    teardown();
  }
});

test('a survey answer alone never indexes a ring, not even "be firm" (#430 review F1)', async () => {
  const teardown = setup();
  try {
    await saveRoutineProfile(USER, {
      timezone: ZONE,
      sleepWindow: null,
      focusWindows: [],
      fixedCommitmentWindows: [],
      preferredReminderIntensity: 'strongReminder',
      quietHours: null,
      surveySkipped: false,
    }, NOW.toISOString());
    await store(commitment());
    // The phone will not ring (hardEnabled stays off), so there is nothing to back up.
    assert.equal(await row(), null);
  } finally {
    teardown();
  }
});

test('moving the start re-arms the reminder and throws the phone s receipt away', async () => {
  const teardown = setup();
  try {
    await ringing();
    await store(commitment());
    const before = await row();
    // A phone reported that it will ring for the original instant.
    await getStorage().set(hardReminderPath(USER, 'c1'), {
      ...(before as HardReminderEntry),
      localReceipt: { installationId: '11111111-1111-4111-8111-111111111111', notificationId: 'c1:strong', exact: true, scheduledAt: NOW.toISOString() },
    });

    const moved = new Date(NOW.getTime() + 5 * 3_600_000).toISOString();
    await patchCommitment('c1', { dueDate: moved }, NOW, { participantId: USER });

    const after = await row();
    assert.equal(after?.fireAt, new Date(Date.parse(moved) - HARD_LEAD_MS).toISOString());
    assert.equal(after?.status, 'pending');
    assert.equal(after?.localReceipt, undefined, 'a receipt for the old instant survived the move');
  } finally {
    teardown();
  }
});

test('an edit that is not the start leaves the row, and the receipt on it, alone', async () => {
  const teardown = setup();
  try {
    await ringing();
    await store(commitment());
    const receipt = { installationId: '11111111-1111-4111-8111-111111111111', notificationId: 'c1:strong', exact: true, scheduledAt: NOW.toISOString() };
    await getStorage().set(hardReminderPath(USER, 'c1'), { ...(await row() as HardReminderEntry), localReceipt: receipt });

    await patchCommitment('c1', { title: 'Dentist, the second' }, NOW, { participantId: USER });

    assert.deepEqual((await row())?.localReceipt, receipt);
  } finally {
    teardown();
  }
});

test('completing or cancelling before the reminder removes it', async () => {
  for (const [name, act] of [
    ['complete', () => completeCommitment('c1', NOW, { participantId: USER })],
    ['cancel', () => dropCommitment('c1', NOW, { participantId: USER })],
  ] as const) {
    const teardown = setup();
    try {
      await ringing();
      await store(commitment());
      assert.notEqual(await row(), null, 'nothing to remove');
      await act();
      assert.equal(await row(), null, `${name} left the reminder armed`);
    } finally {
      teardown();
    }
  }
});

/*
 * Postpone (council verdict B, #198): a Must ring before `postponedUntil` is not
 * owed; one at or after it is. The start does not move. The full table is
 * shared with the phone in `postponedHardRing.test.ts`; this proves the write
 * path applies it.
 */
test('postponing past the ring removes it; postponing to before the ring keeps it', async () => {
  const teardown = setup();
  try {
    await ringing();
    await store(commitment());
    const before = await row();
    const fireAt = Date.parse(before!.fireAt);

    await postponeCommitment('c1', new Date(fireAt - 30 * 60_000).toISOString(), NOW, { participantId: USER });
    assert.deepEqual(await row(), before, 'a postponement that ends before the ring disarmed it');

    await postponeCommitment('c1', new Date(fireAt + 60_000).toISOString(), NOW, { participantId: USER });
    assert.equal(await row(), null, 'a postponement past the ring left the backup armed');
  } finally {
    teardown();
  }
});

test('reconciling twice changes nothing the second time', async () => {
  const teardown = setup();
  try {
    await ringing();
    await store(commitment());
    const before = await row();
    const result = await reconcileHardReminderIndex(USER, new Date(NOW.getTime() + 60_000));
    assert.deepEqual(result, { created: 0, replaced: 0, removed: 0, kept: 1 });
    assert.deepEqual(await row(), before);
  } finally {
    teardown();
  }
});

test('one account s commitments never reach another account s index', async () => {
  const teardown = setup();
  try {
    await ringing();
    await store(commitment());
    const other = 'hardIndexOther';
    await getStorage().set(userDoc(other), { reminderSettings: { softEnabled: true, softLeadMinutes: 60, hardEnabled: true, escalationCeiling: 'hard', mustThroughQuietHours: false, updatedAt: NOW.toISOString() } });
    await reconcileHardReminderIndex(other, NOW);
    assert.equal((await getStorage().list(userCol(other, HARD_REMINDERS))).length, 0);
    assert.equal(await rowCount(), 1);
  } finally {
    teardown();
  }
});
