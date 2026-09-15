/**
 * The events that must come back out of somebody's calendar (UC-3.1, #185).
 *
 * The phone reconciles its calendar against the commitments it is holding, and
 * a commitment that has been cancelled is not one of them — it is an absence,
 * and an absence is exactly what no client can tell apart from "that one is not
 * on Today any more". So "deleting the commitment removes the event" is a
 * promise only the server can keep, by *naming* the links whose commitment the
 * account has outlived.
 *
 * The dangerous half is the second case below. A commitment that was *finished*
 * falls out of both lists the day after, exactly as a cancelled one does, and
 * the entry for the appointment somebody actually went to has to stay in their
 * calendar. Every case here is really one question asked twice: which
 * disappearance is a deletion, and which is only a list moving on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { configureCommandService } from '../../lib/services/commandService.ts';
import { createEmptyDomainState, type Command } from '../../src/domain/stateMachine.ts';
import { applyParticipantCommand } from '../../lib/services/mobile/participantState.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as upcomingGet } from '../../src/app/api/mobile/commitments/upcoming/route.ts';
import { putDeviceCalendarLink } from '../../lib/services/calendar/deviceCalendarLinks.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('CalendarOrphanUser');
const ZONE = 'Asia/Jerusalem';

/**
 * A fixed instant, and every time in this file derived from it.
 *
 * Not `new Date()`: the lists are built against a reference time that is sent
 * with the request, so pinning both to one value is what makes "yesterday" mean
 * the same thing to the test and to the route however long the suite takes.
 */
const NOW = '2026-09-15T09:00:00.000Z';
const YESTERDAY = '2026-09-14T09:00:00.000Z';
const TOMORROW = '2026-09-16T09:00:00.000Z';

let auth: FakeAuthControls | null = null;

function setup(): () => void {
  configureCommandService({ initialState: createEmptyDomainState(), schedulerStore: null });
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

function listRequest(path: 'today' | 'upcoming'): Request {
  const query = `?referenceTime=${encodeURIComponent(NOW)}&timezone=${encodeURIComponent(ZONE)}`;
  return new Request(`${BASE}/api/mobile/commitments/${path}${query}`, {
    headers: { authorization: `Bearer ${tokenFor(USER)}` },
  });
}

interface ListBody {
  items: { id: string }[];
  calendarOrphans?: { commitmentId: string; link: { eventId: string } }[];
}

async function today(): Promise<ListBody> {
  const response = await todayGet(listRequest('today'));
  assert.equal(response.status, 200);
  return await response.json() as ListBody;
}

/** A confirmed, dated commitment with an event already written for it. */
async function linkedCommitment(id: string, dueAt: string): Promise<void> {
  await applyParticipantCommand(USER, {
    type: 'CreateDraft',
    now: NOW,
    commitment: { id, kind: 'task', title: 'Dentist', timeSpec: { kind: 'due_by', dueAt, timezone: ZONE } },
    draftStatus: 'pending_confirmation',
  });
  await applyParticipantCommand(USER, { type: 'ConfirmCommitment', commitmentId: id, now: NOW });
  await putDeviceCalendarLink(USER, id, {
    writerId: 'writer-phone',
    calendarId: 'cal-1',
    eventId: `evt-${id}`,
    contentHash: 'hash-1',
    state: 'linked',
  }, new Date(NOW));
}

async function act(command: Command): Promise<void> {
  await applyParticipantCommand(USER, command);
}

test('a cancelled commitment leaves its event named for removal', async () => {
  const teardown = setup();
  try {
    await linkedCommitment('cmt-cancelled', TOMORROW);
    // Before: the commitment is on a list and owns its event there.
    const before = await today();
    assert.deepEqual(before.calendarOrphans, []);

    await act({ type: 'Drop', commitmentId: 'cmt-cancelled', now: NOW });

    const after = await today();
    assert.equal(after.items.some((item) => item.id === 'cmt-cancelled'), false);
    assert.deepEqual(
      after.calendarOrphans?.map((orphan) => [orphan.commitmentId, orphan.link.eventId]),
      [['cmt-cancelled', 'evt-cmt-cancelled']],
    );
  } finally {
    teardown();
  }
});

test('a commitment finished on an earlier day keeps its event, though it is on no list either', async () => {
  // The whole reason this is computed from the account's statuses rather than
  // from "which ids the list came back with". Both commitments are invisible;
  // only one of them is gone.
  const teardown = setup();
  try {
    await linkedCommitment('cmt-done', YESTERDAY);
    await act({ type: 'Complete', commitmentId: 'cmt-done', now: YESTERDAY });

    const body = await today();
    const upcoming = await (await upcomingGet(listRequest('upcoming'))).json() as ListBody;
    assert.equal(body.items.some((item) => item.id === 'cmt-done'), false);
    assert.equal(upcoming.items.some((item) => item.id === 'cmt-done'), false);
    assert.deepEqual(body.calendarOrphans, []);
  } finally {
    teardown();
  }
});

test('a link belonging to a commitment still on a list is never named', async () => {
  const teardown = setup();
  try {
    await linkedCommitment('cmt-live', TOMORROW);
    const body = await today();
    assert.deepEqual(body.calendarOrphans, []);
  } finally {
    teardown();
  }
});

test('the field is present and empty rather than absent when there is nothing to remove', async () => {
  // Absent would mean "this response did not look", and the client must be able
  // to tell that from "it looked and there is nothing". An empty array proves
  // the join ran.
  const teardown = setup();
  try {
    const body = await today();
    assert.ok(Object.prototype.hasOwnProperty.call(body, 'calendarOrphans'));
    assert.deepEqual(body.calendarOrphans, []);
  } finally {
    teardown();
  }
});

test('Upcoming carries no orphans, so one deletion is never asked for twice', async () => {
  const teardown = setup();
  try {
    await linkedCommitment('cmt-cancelled', TOMORROW);
    await act({ type: 'Drop', commitmentId: 'cmt-cancelled', now: NOW });

    const body = await (await upcomingGet(listRequest('upcoming'))).json() as ListBody;
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'calendarOrphans'), false);
  } finally {
    teardown();
  }
});
