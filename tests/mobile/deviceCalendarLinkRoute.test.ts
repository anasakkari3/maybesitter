/**
 * The link between a commitment and the event in somebody's phone calendar
 * (UC-3.1, #185).
 *
 * The rule this file exists for is the one no device can enforce for itself:
 * two phones signed into one account both hold the same confirmed commitment,
 * both have the calendar target on, and exactly one of them may write an event.
 * The loser has to be *told*, by the server, inside the transaction that
 * decides — so these cases are about the refusals, not the happy path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { configureCommandService } from '../../lib/services/commandService.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { applyParticipantCommand } from '../../lib/services/mobile/participantState.ts';
import {
  DELETE as linkDelete,
  PUT as linkPut,
} from '../../src/app/api/mobile/commitments/[id]/device-calendar-link/route.ts';
import { GET as commitmentGet } from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { getDeviceCalendarLink } from '../../lib/services/calendar/deviceCalendarLinks.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('CalendarLinkUser');
const OTHER = uidFor('CalendarLinkBystander');
const PHONE = 'writer-phone';
const TABLET = 'writer-tablet';

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

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function put(uid: string, id: string, body: unknown): Request {
  return new Request(`${BASE}/api/mobile/commitments/${id}/device-calendar-link`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tokenFor(uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function del(uid: string, id: string, writerId?: string): Request {
  const query = writerId === undefined ? '' : `?writerId=${encodeURIComponent(writerId)}`;
  return new Request(`${BASE}/api/mobile/commitments/${id}/device-calendar-link${query}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${tokenFor(uid)}` },
  });
}

function link(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    writerId: PHONE,
    calendarId: 'cal-1',
    eventId: 'evt-1',
    contentHash: 'hash-1',
    state: 'linked',
    ...overrides,
  };
}

/** A confirmed commitment in this user's own tree, which is what a link needs. */
async function commitmentFor(uid: string, id: string): Promise<string> {
  const now = '2026-09-15T09:00:00.000Z';
  await applyParticipantCommand(uid, {
    type: 'CreateDraft',
    now,
    commitment: { id, kind: 'task', title: 'Dentist' },
    draftStatus: 'pending_confirmation',
  });
  await applyParticipantCommand(uid, { type: 'ConfirmCommitment', commitmentId: id, now });
  return id;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test('a link is stored, and comes back on the commitment the app already reads', async () => {
  const teardown = setup();
  try {
    const id = await commitmentFor(USER, 'cmt-link-1');
    const stored = await linkPut(put(USER, id, link()), params(id));
    assert.equal(stored.status, 200);

    const read = await commitmentGet(
      new Request(`${BASE}/api/mobile/commitments/${id}`, {
        headers: { authorization: `Bearer ${tokenFor(USER)}` },
      }),
      params(id),
    );
    const dto = await json(read) as { deviceCalendarLink?: Record<string, unknown> };
    assert.equal(dto.deviceCalendarLink?.eventId, 'evt-1');
    assert.equal(dto.deviceCalendarLink?.state, 'linked');
  } finally {
    teardown();
  }
});

test('a commitment with no link says so, rather than leaving the field out', async () => {
  const teardown = setup();
  try {
    const id = await commitmentFor(USER, 'cmt-link-none');
    const read = await commitmentGet(
      new Request(`${BASE}/api/mobile/commitments/${id}`, {
        headers: { authorization: `Bearer ${tokenFor(USER)}` },
      }),
      params(id),
    );
    const dto = await json(read);
    assert.ok('deviceCalendarLink' in dto, 'the read answered nothing about the link');
    assert.equal(dto.deviceCalendarLink, null);
  } finally {
    teardown();
  }
});

test('a second installation is refused, and nothing it sent is stored', async () => {
  const teardown = setup();
  try {
    const id = await commitmentFor(USER, 'cmt-link-2');
    assert.equal((await linkPut(put(USER, id, link()), params(id))).status, 200);

    const second = await linkPut(
      put(USER, id, link({ writerId: TABLET, calendarId: 'cal-2', eventId: 'evt-2' })),
      params(id),
    );
    assert.equal(second.status, 409);
    assert.equal((await json(second)).reason, 'calendar_link_owned_elsewhere');

    // The refusal is only worth something if it also refused to write.
    const current = await getDeviceCalendarLink(USER, id);
    assert.equal(current?.writerId, PHONE);
    assert.equal(current?.eventId, 'evt-1');
  } finally {
    teardown();
  }
});

test('an event the user deleted by hand is never linked again', async () => {
  const teardown = setup();
  try {
    const id = await commitmentFor(USER, 'cmt-link-3');
    assert.equal((await linkPut(put(USER, id, link()), params(id))).status, 200);
    // The app noticed the event was gone from the calendar.
    assert.equal((await linkPut(put(USER, id, link({ state: 'detached' })), params(id))).status, 200);

    // The same installation, editing the commitment later, tries to write it back.
    const relink = await linkPut(put(USER, id, link({ eventId: 'evt-9' })), params(id));
    assert.equal(relink.status, 409);
    assert.equal((await json(relink)).reason, 'calendar_link_detached');
    assert.equal((await getDeviceCalendarLink(USER, id))?.state, 'detached');
  } finally {
    teardown();
  }
});

test('a detached link may still be corrected by its owner as long as it stays detached', async () => {
  const teardown = setup();
  try {
    const id = await commitmentFor(USER, 'cmt-link-4');
    await linkPut(put(USER, id, link()), params(id));
    await linkPut(put(USER, id, link({ state: 'detached' })), params(id));
    const again = await linkPut(put(USER, id, link({ state: 'detached', contentHash: 'hash-2' })), params(id));
    assert.equal(again.status, 200);
    assert.equal((await getDeviceCalendarLink(USER, id))?.contentHash, 'hash-2');
  } finally {
    teardown();
  }
});

test('only the owning installation may forget a link', async () => {
  const teardown = setup();
  try {
    const id = await commitmentFor(USER, 'cmt-link-5');
    await linkPut(put(USER, id, link()), params(id));

    const refused = await linkDelete(del(USER, id, TABLET), params(id));
    assert.equal(refused.status, 409);
    assert.ok(await getDeviceCalendarLink(USER, id), 'a refused delete removed the row anyway');

    const allowed = await linkDelete(del(USER, id, PHONE), params(id));
    assert.equal(allowed.status, 200);
    assert.equal((await json(allowed)).deleted, true);
    assert.equal(await getDeviceCalendarLink(USER, id), null);
  } finally {
    teardown();
  }
});

test('a delete with no writerId is a 400, not a silent removal', async () => {
  const teardown = setup();
  try {
    const id = await commitmentFor(USER, 'cmt-link-6');
    await linkPut(put(USER, id, link()), params(id));
    const response = await linkDelete(del(USER, id), params(id));
    assert.equal(response.status, 400);
    assert.ok(await getDeviceCalendarLink(USER, id));
  } finally {
    teardown();
  }
});

test('an incomplete link is refused before anything is written', async () => {
  const teardown = setup();
  try {
    const id = await commitmentFor(USER, 'cmt-link-7');
    for (const body of [
      link({ writerId: '' }),
      link({ eventId: undefined }),
      link({ state: 'gone' }),
      link({ calendarId: 42 }),
    ]) {
      const response = await linkPut(put(USER, id, body), params(id));
      assert.equal(response.status, 400, `accepted ${JSON.stringify(body)}`);
    }
    assert.equal(await getDeviceCalendarLink(USER, id), null);
  } finally {
    teardown();
  }
});

test('a link needs a commitment this account actually has', async () => {
  const teardown = setup();
  try {
    await commitmentFor(OTHER, 'cmt-link-8');
    // Another user's commitment is simply not in this user's tree.
    const response = await linkPut(put(USER, 'cmt-link-8', link()), params('cmt-link-8'));
    assert.equal(response.status, 404);
    assert.equal(await getDeviceCalendarLink(USER, 'cmt-link-8'), null);
    assert.equal(await getDeviceCalendarLink(OTHER, 'cmt-link-8'), null);
  } finally {
    teardown();
  }
});

test('no credential reaches no link', async () => {
  const teardown = setup();
  try {
    const id = await commitmentFor(USER, 'cmt-link-9');
    const anonymous = new Request(`${BASE}/api/mobile/commitments/${id}/device-calendar-link`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(link()),
    });
    assert.equal((await linkPut(anonymous, params(id))).status, 401);
    assert.equal(await getDeviceCalendarLink(USER, id), null);
  } finally {
    teardown();
  }
});
