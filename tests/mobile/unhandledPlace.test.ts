/**
 * «ما اتصرّفت فيها» — the things nothing was done about (owner decision
 * 2026-11-12, spec Part 1, design item 2, lane E2).
 *
 * The place holds two kinds of item, and only those two:
 *
 *   - an appointment or meeting that is over and still active: the person
 *     never said what came of it (`hasEventEnded`, lane E1);
 *   - a deadline (`due_by`) whose time passed while the item was still open.
 *
 * A task keeps #383: it rolls into Today until the person acts on it, and it
 * never comes here. A football match is closed by the maintenance pass for
 * everyone (lane E1), so it is never asked about either.
 *
 * The clock and the account are lane E1's root-cause scenario: 2026-11-12
 * 15:00 in Jerusalem, a lecture three weeks ago, yesterday's all-day doctor
 * appointment and this morning's 09–10 meeting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { UNHANDLED_MARKS, userCol, userDoc } from '../../lib/storage/paths.ts';
import { persistParticipantState, readParticipantState } from '../../lib/services/mobile/participantState.ts';
import { createEmptyDomainState, type Commitment, type DomainState } from '../../src/domain/stateMachine.ts';
import { applyCommitmentAction } from '../../lib/services/mobile/commitmentService.ts';
import {
  dismissUnhandled,
  listUnhandled,
  MAX_UNHANDLED_ASKS,
  NotUnhandledError,
  recordUnhandledAsked,
  unhandledAnchor,
} from '../../lib/services/mobile/unhandledService.ts';
import { AccountUnavailableError } from '../../lib/account/accountLiveness.ts';
import { refDocPath } from '../../lib/football/externalTaskRefStore.ts';
import { deleteAccount } from '../../lib/account/accountDeletion.ts';
import { buildAccountExport } from '../../lib/account/accountExport.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';
import { GET as unhandledGet, POST as unhandledPost } from '../../src/app/api/mobile/commitments/unhandled/route.ts';

const UID = uidFor('UnhandledOwner');
const OTHER = uidFor('UnhandledOther');
const TZ = 'Asia/Jerusalem';
/** Thursday 2026-11-12, 15:00 in Jerusalem (UTC+2 in November). */
const NOW = new Date('2026-11-12T13:00:00.000Z');
const BASE = 'http://127.0.0.1:4321';

function commitment(
  id: string,
  timeSpec: Partial<Commitment['timeSpec']> & Pick<Commitment['timeSpec'], 'kind' | 'dueAt'>,
  extra: Partial<Commitment> = {},
): Commitment {
  return {
    id,
    kind: 'task',
    title: id,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    category: null,
    categorySource: 'inferred',
    timeSpec: { endAt: null, remindAt: null, allDay: false, timezone: TZ, ...timeSpec },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    confirmedAt: '2026-10-01T08:00:00.000Z',
    completedAt: null,
    droppedAt: null,
    ...extra,
  } as Commitment;
}

/** What belongs in the place, and why. */
const EXPECTED: Record<string, 'event_ended' | 'deadline_passed'> = {
  lecture: 'event_ended',
  doctor: 'event_ended',
  meeting: 'event_ended',
  deadline: 'deadline_passed',
  allDayDeadline: 'deadline_passed',
  postponedEnded: 'event_ended',
  // From another provider's task feed: a deadline like any other, not a match.
  importedDeadline: 'deadline_passed',
};

function scenario(): Commitment[] {
  return [
    commitment('lecture', { kind: 'scheduled_event', dueAt: '2026-10-22T08:00:00.000Z', endAt: '2026-10-22T10:00:00.000Z' }),
    // Yesterday's local midnight in Jerusalem: an all-day appointment names a day.
    commitment('doctor', { kind: 'scheduled_event', dueAt: '2026-11-10T22:00:00.000Z', allDay: true }),
    commitment('meeting', { kind: 'scheduled_event', dueAt: '2026-11-12T07:00:00.000Z', endAt: '2026-11-12T08:00:00.000Z' }),
    // A hand-in due yesterday at 18:00, still open.
    commitment('deadline', { kind: 'due_by', dueAt: '2026-11-11T16:00:00.000Z' }),
    // A deadline named by a day, the day before yesterday: it closed at that day's midnight.
    commitment('allDayDeadline', { kind: 'due_by', dueAt: '2026-11-09T22:00:00.000Z', allDay: true }),
    // A meeting put off once («لسّا») to this morning, and over again.
    commitment('postponedEnded', { kind: 'scheduled_event', dueAt: '2026-11-10T07:00:00.000Z', endAt: '2026-11-10T08:00:00.000Z' }, {
      status: 'deferred', postponedUntil: '2026-11-12T09:00:00.000Z',
    }),

    // ── None of these belongs here ──
    // A deadline named by today: it is still open until tonight's midnight.
    commitment('todayDeadline', { kind: 'due_by', dueAt: '2026-11-11T22:00:00.000Z', allDay: true }),
    // A deadline put off to tomorrow.
    commitment('postponedDeadline', { kind: 'due_by', dueAt: '2026-11-11T16:00:00.000Z' }, {
      status: 'deferred', postponedUntil: '2026-11-13T09:00:00.000Z',
    }),
    // A meeting later today.
    commitment('evening', { kind: 'scheduled_event', dueAt: '2026-11-12T16:00:00.000Z', endAt: '2026-11-12T17:00:00.000Z' }),
    // A task given an hour yesterday: #383 rolls it into Today.
    commitment('clockTask', { kind: 'scheduled_event', dueAt: '2026-11-11T15:00:00.000Z', itemKind: 'task' }),
    // Capture was not sure: it never leaves Today on a guess, so it is not asked about either.
    commitment('unsure', { kind: 'scheduled_event', dueAt: '2026-11-11T08:00:00.000Z', endAt: '2026-11-11T09:00:00.000Z', itemKind: 'unsure' }),
    commitment('undated', { kind: 'unscheduled', dueAt: null }),
    // Settled: the person already said what happened.
    commitment('doneMeeting', { kind: 'scheduled_event', dueAt: '2026-11-11T07:00:00.000Z', endAt: '2026-11-11T08:00:00.000Z' }, {
      status: 'completed', completedAt: '2026-11-11T09:00:00.000Z',
    }),
    commitment('droppedDeadline', { kind: 'due_by', dueAt: '2026-11-11T16:00:00.000Z' }, {
      status: 'dropped', droppedAt: '2026-11-11T17:00:00.000Z',
    }),
    commitment('deleted', { kind: 'due_by', dueAt: '2026-11-11T16:00:00.000Z' }, { status: 'archived' }),
    commitment('importedDeadline', { kind: 'due_by', dueAt: '2026-11-11T10:00:00.000Z' }),
    // Saturday's match, ended: closed for everyone by the maintenance pass.
    commitment('match', { kind: 'scheduled_event', dueAt: '2026-11-11T18:00:00.000Z', endAt: '2026-11-11T20:00:00.000Z' }),
  ];
}

function stateOf(items: readonly Commitment[]): DomainState {
  const state = createEmptyDomainState();
  for (const item of items) state.commitments[item.id] = item;
  return state;
}

async function seedAccount(uid: string, items: readonly Commitment[]): Promise<void> {
  await seedLiveAccount(uid);
  const user = await getStorage().get<Record<string, unknown>>(userDoc(uid));
  await getStorage().set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  await persistParticipantState(uid, stateOf(items));
}

async function linkRef(uid: string, provider: string, commitmentId: string): Promise<void> {
  const taskRefId = `${provider}:${commitmentId}`;
  await getStorage().set(refDocPath(uid, taskRefId), {
    taskRefId,
    identity: { provider, externalId: commitmentId },
    linkedCommitmentId: commitmentId,
    detachedAt: null,
  });
}

let auth: FakeAuthControls | null = null;

async function withSeeded(body: () => Promise<void>): Promise<void> {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
  try {
    await seedAccount(UID, scenario());
    await linkRef(UID, 'football-data', 'match');
    await linkRef(UID, 'todoist', 'importedDeadline');
    await body();
  } finally {
    resetStorageForTests();
    auth?.restore();
    auth = null;
  }
}

function ids(items: readonly { commitment: { id: string } }[]): string[] {
  return items.map((item) => item.commitment.id).sort();
}

/* ── The projection ──────────────────────────────────────────────── */

test('E2 projection: ended events and passed deadlines, and nothing else', async () => {
  await withSeeded(async () => {
    const { items } = await listUnhandled(UID, { now: NOW });
    assert.deepEqual(ids(items), Object.keys(EXPECTED).sort());
    for (const item of items) assert.equal(item.reason, EXPECTED[item.commitment.id], item.commitment.id);
  });
});

test('E2 projection: the most recent first, each saying since when', async () => {
  await withSeeded(async () => {
    const { items } = await listUnhandled(UID, { now: NOW });
    assert.deepEqual(items.map((item) => item.commitment.id), [
      'postponedEnded', 'meeting', 'doctor', 'deadline', 'importedDeadline', 'allDayDeadline', 'lecture',
    ]);
    const since = Object.fromEntries(items.map((item) => [item.commitment.id, item.since]));
    // The meeting ended at its own end; the all-day appointment at the midnight closing its day.
    assert.equal(since.meeting, '2026-11-12T08:00:00.000Z');
    assert.equal(since.doctor, '2026-11-11T22:00:00.000Z');
    assert.equal(since.deadline, '2026-11-11T16:00:00.000Z');
    assert.equal(since.allDayDeadline, '2026-11-10T22:00:00.000Z');
  });
});

test('E2 projection: a deadline passes at its instant, not a millisecond later', () => {
  const due = commitment('d', { kind: 'due_by', dueAt: '2026-11-12T13:00:00.000Z' });
  assert.equal(unhandledAnchor(due, new Date('2026-11-12T12:59:59.999Z')), null);
  assert.deepEqual(unhandledAnchor(due, NOW), { reason: 'deadline_passed', since: '2026-11-12T13:00:00.000Z' });
});

test('E2 projection: the status stays what it was — listing changes nothing', async () => {
  await withSeeded(async () => {
    await listUnhandled(UID, { now: NOW });
    const state = await readParticipantState(UID);
    assert.equal(state.commitments.lecture.status, 'active');
    assert.equal(state.commitments.deadline.status, 'active');
  });
});

test('E2 projection: one account never sees another account’s items', async () => {
  await withSeeded(async () => {
    await seedAccount(OTHER, [commitment('theirs', { kind: 'due_by', dueAt: '2026-11-11T16:00:00.000Z' })]);
    assert.deepEqual(ids((await listUnhandled(UID, { now: NOW })).items), Object.keys(EXPECTED).sort());
    assert.deepEqual(ids((await listUnhandled(OTHER, { now: NOW })).items), ['theirs']);
  });
});

/* ── The status actions go through the existing commands ─────────── */

test('E2 actions: done, a new date and dropped on purpose each take the item out', async () => {
  await withSeeded(async () => {
    await applyCommitmentAction('lecture', 'complete', { participantId: UID, now: NOW });
    await applyCommitmentAction('deadline', 'postpone', { participantId: UID, now: NOW, postponedUntil: '2026-11-14T08:00:00.000Z' });
    await applyCommitmentAction('doctor', 'cancel', { participantId: UID, now: NOW });
    const left = ids((await listUnhandled(UID, { now: NOW })).items);
    assert.deepEqual(left, ['allDayDeadline', 'importedDeadline', 'meeting', 'postponedEnded']);
    const state = await readParticipantState(UID);
    assert.equal(state.commitments.lecture.status, 'completed');
    assert.equal(state.commitments.doctor.status, 'dropped');
  });
});

/* ── «لا تسألني عنها» ────────────────────────────────────────────── */

test('E2 dismiss: the item leaves the place, its status does not change, and it stays in history', async () => {
  await withSeeded(async () => {
    const result = await dismissUnhandled(UID, 'deadline', { now: NOW });
    assert.equal(result.replayed, false);
    assert.ok(!ids((await listUnhandled(UID, { now: NOW })).items).includes('deadline'));
    const state = await readParticipantState(UID);
    assert.equal(state.commitments.deadline.status, 'active');
  });
});

test('E2 dismiss: a second press changes nothing and says so', async () => {
  await withSeeded(async () => {
    await dismissUnhandled(UID, 'deadline', { now: NOW });
    const marks = async () => (await getStorage().list(userCol(UID, UNHANDLED_MARKS))).map((row) => row.data);
    const before = await marks();
    const again = await dismissUnhandled(UID, 'deadline', { now: new Date(NOW.getTime() + 5_000) });
    assert.equal(again.replayed, true);
    assert.deepEqual(await marks(), before);
  });
});

test('E2 dismiss: an item given a new time that passes again comes back', async () => {
  await withSeeded(async () => {
    await dismissUnhandled(UID, 'deadline', { now: NOW });
    await applyCommitmentAction('deadline', 'postpone', { participantId: UID, now: NOW, postponedUntil: '2026-11-14T08:00:00.000Z' });
    const later = new Date('2026-11-15T08:00:00.000Z');
    assert.ok(ids((await listUnhandled(UID, { now: later })).items).includes('deadline'));
  });
});

test('E2 dismiss: refused for an item that is not in the place, and for another account’s', async () => {
  await withSeeded(async () => {
    await assert.rejects(dismissUnhandled(UID, 'evening', { now: NOW }), NotUnhandledError);
    await assert.rejects(dismissUnhandled(UID, 'clockTask', { now: NOW }), NotUnhandledError);
    await seedAccount(OTHER, [commitment('theirs', { kind: 'due_by', dueAt: '2026-11-11T16:00:00.000Z' })]);
    await assert.rejects(dismissUnhandled(UID, 'theirs', { now: NOW }), /Commitment not found/);
    assert.deepEqual(await getStorage().list(userCol(UID, UNHANDLED_MARKS)), []);
  });
});

test('E2 dismiss: refused under an account being deleted (#772)', async () => {
  await withSeeded(async () => {
    const user = await getStorage().get<{ trust: Record<string, unknown> }>(userDoc(UID));
    await getStorage().set(userDoc(UID), { ...user, trust: { ...user!.trust, deletedAt: NOW.toISOString() } });
    await assert.rejects(dismissUnhandled(UID, 'deadline', { now: NOW }), AccountUnavailableError);
    await assert.rejects(recordUnhandledAsked(UID, ['deadline'], { now: NOW }), AccountUnavailableError);
    assert.deepEqual(await getStorage().list(userCol(UID, UNHANDLED_MARKS)), []);
  });
});

test('E2 dismiss: a football match is never in the place, so it cannot be dismissed from it either', async () => {
  await withSeeded(async () => {
    await assert.rejects(dismissUnhandled(UID, 'match', { now: NOW }), NotUnhandledError);
    assert.deepEqual(await getStorage().list(userCol(UID, UNHANDLED_MARKS)), []);
  });
});

/* ── The marks belong to the account ─────────────────────────────── */

test('E2 marks: an export carries them, and account deletion removes them', async () => {
  await withSeeded(async () => {
    await recordUnhandledAsked(UID, ['lecture'], { now: NOW });
    await dismissUnhandled(UID, 'deadline', { now: NOW });
    await seedAccount(OTHER, [commitment('theirs', { kind: 'due_by', dueAt: '2026-11-11T16:00:00.000Z' })]);
    await recordUnhandledAsked(OTHER, ['theirs'], { now: NOW });

    const exported = await buildAccountExport(UID);
    const marks = exported.collections[UNHANDLED_MARKS].map((doc) => doc.data.commitmentId).sort();
    assert.deepEqual(marks, ['deadline', 'lecture']);

    const previous = process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
    process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = 'test-pepper-not-the-real-one';
    try {
      await deleteAccount(UID, {
        initiatedBy: 'user',
        storage: getStorage(),
        auth: { async revokeRefreshTokens() {}, async deleteUser() {} },
        hooks: [],
      });
    } finally {
      if (previous === undefined) delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
      else process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = previous;
    }
    assert.deepEqual(await getStorage().list(userCol(UID, UNHANDLED_MARKS)), []);
    // Another account's answers are not touched.
    assert.equal((await getStorage().list(userCol(OTHER, UNHANDLED_MARKS))).length, 1);
  });
});

/* ── How many times it was asked about (lane E3 reads this) ──────── */

test('E2 ask count: each ask is counted per item, and the cap lane E3 reads is two', async () => {
  await withSeeded(async () => {
    assert.equal(MAX_UNHANDLED_ASKS, 2);
    await recordUnhandledAsked(UID, ['lecture', 'deadline'], { now: NOW });
    await recordUnhandledAsked(UID, ['lecture', 'not-a-commitment'], { now: NOW });
    const counts = Object.fromEntries((await listUnhandled(UID, { now: NOW })).items.map((item) => [item.commitment.id, item.askCount]));
    assert.equal(counts.lecture, 2);
    assert.equal(counts.deadline, 1);
    assert.equal(counts.meeting, 0);
    // Nothing is written for an id the account does not hold.
    assert.equal((await getStorage().list(userCol(UID, UNHANDLED_MARKS))).length, 2);
  });
});

test('E2 ask count: a dismissal keeps the count it had', async () => {
  await withSeeded(async () => {
    await recordUnhandledAsked(UID, ['deadline'], { now: NOW });
    await dismissUnhandled(UID, 'deadline', { now: NOW });
    await applyCommitmentAction('deadline', 'postpone', { participantId: UID, now: NOW, postponedUntil: '2026-11-14T08:00:00.000Z' });
    const back = (await listUnhandled(UID, { now: new Date('2026-11-15T08:00:00.000Z') })).items.find((item) => item.commitment.id === 'deadline');
    assert.equal(back?.askCount, 1);
  });
});

/* ── The route ───────────────────────────────────────────────────── */

function get(uid: string | null, query = `?referenceTime=${NOW.toISOString()}`) {
  return unhandledGet(new Request(`${BASE}/api/mobile/commitments/unhandled${query}`, {
    headers: new Headers(uid ? { authorization: `Bearer ${tokenFor(uid)}` } : {}),
  }));
}

function post(uid: string | null, body: unknown) {
  // A write is judged on the server's own clock, never a client's.
  return unhandledPost(new Request(`${BASE}/api/mobile/commitments/unhandled`, {
    method: 'POST',
    headers: new Headers({ ...(uid ? { authorization: `Bearer ${tokenFor(uid)}` } : {}), 'Content-Type': 'application/json' }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

test('E2 route: the list needs a signed-in person', async () => {
  await withSeeded(async () => {
    assert.equal((await get(null)).status, 401);
    assert.equal((await post(null, { action: 'dismiss', commitmentId: 'deadline' })).status, 401);
  });
});

test('E2 route: GET answers the items with their reason, since and ask count', async () => {
  await withSeeded(async () => {
    const response = await get(UID);
    assert.equal(response.status, 200);
    const body = await response.json() as { items: Array<{ reason: string; since: string; askCount: number; commitment: { id: string; status: string } }> };
    assert.deepEqual(ids(body.items), Object.keys(EXPECTED).sort());
    const lecture = body.items.find((item) => item.commitment.id === 'lecture')!;
    assert.equal(lecture.reason, 'event_ended');
    assert.equal(lecture.since, '2026-10-22T10:00:00.000Z');
    assert.equal(lecture.askCount, 0);
    assert.equal(lecture.commitment.status, 'active');
  });
});

test('E2 route: POST dismiss takes the item out once, and a repeat is a replay', async () => {
  await withSeeded(async () => {
    const first = await post(UID, { action: 'dismiss', commitmentId: 'meeting' });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { success: true, id: 'meeting', dismissed: true });
    const second = await post(UID, { action: 'dismiss', commitmentId: 'meeting' });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { success: true, id: 'meeting', dismissed: true, replayed: true });
    const body = await (await get(UID)).json() as { items: Array<{ commitment: { id: string } }> };
    assert.ok(!ids(body.items).includes('meeting'));
  });
});

test('E2 route: POST answers 404 for another account’s item and 409 for one not in the place', async () => {
  await withSeeded(async () => {
    await seedAccount(OTHER, [commitment('theirs', { kind: 'due_by', dueAt: '2026-11-11T16:00:00.000Z' })]);
    assert.equal((await post(UID, { action: 'dismiss', commitmentId: 'theirs' })).status, 404);
    // A task is never in the place, whatever the clock says (#383).
    const notHere = await post(UID, { action: 'dismiss', commitmentId: 'clockTask' });
    assert.equal(notHere.status, 409);
    assert.deepEqual(await notHere.json(), { success: false, reason: 'not_unhandled' });
  });
});

test('E2 route: POST refuses a malformed body', async () => {
  await withSeeded(async () => {
    assert.equal((await post(UID, 'not json')).status, 400);
    assert.equal((await post(UID, null)).status, 400);
    assert.equal((await post(UID, { action: 'complete', commitmentId: 'deadline' })).status, 400);
    assert.equal((await post(UID, { action: 'dismiss' })).status, 400);
    assert.equal((await post(UID, { action: 'dismiss', commitmentId: 'x'.repeat(200) })).status, 400);
  });
});
