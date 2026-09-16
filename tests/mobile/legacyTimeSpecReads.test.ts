/**
 * A commitment stored before `endAt` and `allDay` existed (#185).
 *
 * The widening that added them was argued on producers: `defaultTimeSpec` fills
 * both, so every commitment the domain *stores* carries them. The read path is
 * a producer too, and it was missed. `loadDomainState` assigns the raw storage
 * document into the state, `commitmentToMobileDto` copies `timeSpec` through
 * verbatim, and `timeSpecSchema` on the phone requires both keys — nullable is
 * not optional. So every commitment written before this branch merged served a
 * body the app refuses to parse, and because the list is parsed as a whole, one
 * such row blanks the entire screen rather than its own card.
 *
 * This is the first time this repository has widened a type over a store that
 * already had data in it. The other required fields — `priority.source`,
 * `pressureAllowed` — date from the initial commit, so they were never added to
 * anything; there was no precedent to copy and no backfill script to run.
 *
 * The fix is normalisation on read rather than a migration, and these are the
 * cases that say so: a document is repaired the moment it is read, which is the
 * only moment it matters, so one nobody opens for six months is correct on the
 * day they do. A backfill would have had to be run by somebody, would have
 * missed accounts created by an older instance mid-deploy, and would have left
 * this class of bug live for the next field anybody adds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { configureCommandService } from '../../lib/services/commandService.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { COMMITMENTS, userCol } from '../../lib/storage/paths.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as commitmentGet, PATCH as commitmentPatch } from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('LegacyTimeSpecUser');
const ZONE = 'Asia/Jerusalem';
const NOW = '2026-09-16T06:00:00.000Z';

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

/**
 * Exactly what a document written before this branch looks like: a complete
 * commitment of its day, whose `timeSpec` has four keys and not six.
 */
async function storeLegacyCommitment(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await getStorage().set(`${userCol(USER, COMMITMENTS)}/${id}`, {
    id,
    kind: 'task',
    title: 'Dentist',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: '2026-09-16T09:00:00.000Z', remindAt: null, timezone: ZONE },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    confirmedAt: '2026-09-01T00:00:00.000Z',
    completedAt: null,
    droppedAt: null,
    ...extra,
  });
}

function authed(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${tokenFor(USER)}`, 'Content-Type': 'application/json' },
  });
}

function todayRequest(): Request {
  return authed(`/api/mobile/commitments/today?referenceTime=${encodeURIComponent(NOW)}&timezone=${encodeURIComponent(ZONE)}`);
}

interface ServedTimeSpec { [key: string]: unknown }

/**
 * The claim the phone's schema makes, restated here so the backend suite can
 * fail on its own. `timeSpecSchema` requires both keys and `null` is a value
 * while `undefined` is not, so `'endAt' in timeSpec` is the exact question.
 */
function assertParseable(timeSpec: ServedTimeSpec, where: string): void {
  assert.ok(Object.prototype.hasOwnProperty.call(timeSpec, 'endAt'), `${where}: endAt is missing`);
  assert.ok(Object.prototype.hasOwnProperty.call(timeSpec, 'allDay'), `${where}: allDay is missing`);
  assert.equal(timeSpec.endAt, null, `${where}: a commitment that named no end must say so`);
  assert.equal(timeSpec.allDay, false, `${where}: a commitment nobody marked all-day must say so`);
}

test('a commitment stored before the fields existed is served complete', async () => {
  const teardown = setup();
  try {
    await storeLegacyCommitment('legacy-1');
    const body = await (await todayGet(todayRequest())).json() as { items: { timeSpec: ServedTimeSpec }[] };
    assert.equal(body.items.length, 1);
    assertParseable(body.items[0]!.timeSpec, 'today');

    const one = await (await commitmentGet(authed('/api/mobile/commitments/legacy-1'), {
      params: Promise.resolve({ id: 'legacy-1' }),
    })).json() as { timeSpec: ServedTimeSpec };
    assertParseable(one.timeSpec, 'single read');
  } finally {
    teardown();
  }
});

test('one legacy row cannot spoil the rest of the list', async () => {
  // The list is parsed as one value on the phone, so a row the schema refuses
  // is not a missing card — it is a blank screen. This is the case that makes
  // the severity of a single unrepaired document what it is.
  const teardown = setup();
  try {
    await storeLegacyCommitment('legacy-1');
    await storeLegacyCommitment('legacy-2', { title: 'Passport' });
    const body = await (await todayGet(todayRequest())).json() as { items: { timeSpec: ServedTimeSpec }[] };
    assert.equal(body.items.length, 2);
    for (const item of body.items) assertParseable(item.timeSpec, 'list of two');
  } finally {
    teardown();
  }
});

test('an edit that never mentions the time still stores a repaired record', async () => {
  // A title-only patch does not reach `patchTimeSpec`, so nothing on the write
  // path would have healed this document. Reading it repairs it, and the repair
  // is what gets written back.
  const teardown = setup();
  try {
    await storeLegacyCommitment('legacy-1');
    const response = await commitmentPatch(
      authed('/api/mobile/commitments/legacy-1', { method: 'PATCH', body: JSON.stringify({ title: 'Dentist, moved' }) }),
      { params: Promise.resolve({ id: 'legacy-1' }) },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { title: string; timeSpec: ServedTimeSpec };
    assert.equal(body.title, 'Dentist, moved');
    assertParseable(body.timeSpec, 'after a title edit');

    const stored = await getParticipantStateSnapshot(USER);
    assertParseable(stored.commitments['legacy-1']!.timeSpec as unknown as ServedTimeSpec, 'stored');
  } finally {
    teardown();
  }
});

test('repairing a read does not invent a time the document never had', async () => {
  // The repair fills the two fields that were added and touches nothing else.
  // An undated commitment must not come back dated.
  const teardown = setup();
  try {
    await getStorage().set(`${userCol(USER, COMMITMENTS)}/undated-1`, {
      id: 'undated-1', kind: 'task', title: 'Buy milk', description: null, person: null, status: 'active',
      priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      timeSpec: { kind: 'unscheduled', dueAt: null, remindAt: null, timezone: ZONE },
      currentAckState: 'not_seen', postponedUntil: null,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      confirmedAt: '2026-09-01T00:00:00.000Z', completedAt: null, droppedAt: null,
    });
    const body = await (await todayGet(todayRequest())).json() as { items: { timeSpec: ServedTimeSpec }[] };
    const item = body.items.find((row) => (row as unknown as { id: string }).id === 'undated-1');
    assert.ok(item, 'the undated commitment is still on Today');
    assert.deepEqual(item.timeSpec, {
      kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: ZONE,
    });
  } finally {
    teardown();
  }
});
