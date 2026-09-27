/**
 * "Remind me when I arrive / leave" on the wire (closure CL4).
 *
 * The server stores that a commitment has a place reminder — which way it
 * fires, the phone's opaque place id, and the place's name — and nothing that
 * says where the place is. These cases read the real handlers:
 *
 *   - the PATCH route stores, returns and removes the trigger;
 *   - a trigger carrying a coordinate is refused, not trimmed, and nothing is
 *     written — so a client that tried to send one finds out;
 *   - the same trigger chosen in review travels with the confirm;
 *   - the account export carries it (deletion and export read one list), and no
 *     stored document anywhere holds a coordinate key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as commitmentGet, PATCH as commitmentPatch } from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { getCommitment } from '../../lib/services/mobile/commitmentService.ts';
import { applyParticipantCommands } from '../../lib/services/mobile/participantState.ts';
import { buildAccountExport } from '../../lib/account/accountExport.ts';
import { createEmptyDomainState, type Command, type Commitment } from '../../src/domain/stateMachine.ts';
import {
  confirmCapture,
  proposeCapture,
  MemoryCaptureProposalStore,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import {
  LOCATION_TRIGGER_FORBIDDEN_FIELDS,
  parseLocationTrigger,
} from '../../src/contracts/v1/locationTriggerContracts.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('CommitmentLocationTriggerUser');
const ID = 'cmt_location_trigger';
const WORK = { kind: 'arrive', placeId: 'place_0f3a9c2e', label: 'Work' } as const;

let auth: FakeAuthControls | null = null;
let storage: ReturnType<typeof createMemoryStorage>;

function setup(): () => void {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

async function seed(): Promise<void> {
  const commands: Command[] = [
    {
      type: 'CreateDraft',
      now: '2026-04-08T09:00:00.000Z',
      commitment: {
        id: ID,
        kind: 'task',
        title: 'Hand in the badge',
        timeSpec: { kind: 'unscheduled', timezone: 'UTC' },
      },
      draftStatus: 'pending_confirmation',
    },
    { type: 'ConfirmCommitment', commitmentId: ID, now: '2026-04-08T09:00:01.000Z' },
  ];
  await applyParticipantCommands(USER, commands);
}

function patch(body: unknown): Promise<Response> {
  return commitmentPatch(new Request(`${BASE}/api/mobile/commitments/${ID}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${tokenFor(USER)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: ID }) });
}

async function readOne(): Promise<Record<string, unknown>> {
  const response = await commitmentGet(new Request(`${BASE}/api/mobile/commitments/${ID}`, {
    headers: { authorization: `Bearer ${tokenFor(USER)}` },
  }), { params: Promise.resolve({ id: ID }) });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

/** Every key anywhere inside a value, lower-cased. */
function keysDeep(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, into));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key.toLowerCase());
      keysDeep(inner, into);
    }
  }
  return into;
}

test('a place reminder is stored, returned by the edit, and carried by the reads', async () => {
  const teardown = setup();
  try {
    await seed();
    const response = await patch({ locationTrigger: WORK });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body.locationTrigger, WORK);

    assert.deepEqual((await readOne()).locationTrigger, WORK);
    const list = (await (await todayGet(new Request(`${BASE}/api/mobile/commitments/today?referenceTime=2026-04-08T10:00:00.000Z`, {
      headers: { authorization: `Bearer ${tokenFor(USER)}` },
    }))).json()) as { items: Array<Record<string, unknown>> };
    assert.deepEqual(list.items.find((item) => item.id === ID)?.locationTrigger, WORK);
  } finally {
    teardown();
  }
});

test('a commitment with no place reminder carries no locationTrigger key at all', async () => {
  const teardown = setup();
  try {
    await seed();
    assert.equal('locationTrigger' in (await readOne()), false);
  } finally {
    teardown();
  }
});

test('null removes the place reminder', async () => {
  const teardown = setup();
  try {
    await seed();
    assert.equal((await patch({ locationTrigger: WORK })).status, 200);
    const cleared = await patch({ locationTrigger: null });
    assert.equal(cleared.status, 200);
    assert.equal('locationTrigger' in ((await cleared.json()) as Record<string, unknown>), false);
    const stored = await getCommitment(ID, { participantId: USER });
    assert.equal(stored?.locationTrigger, undefined);
  } finally {
    teardown();
  }
});

for (const leak of [
  { ...WORK, lat: 32.08, lng: 34.78 },
  { ...WORK, latitude: 32.08, longitude: 34.78 },
  { ...WORK, coords: { latitude: 32.08, longitude: 34.78 } },
  { ...WORK, radius: 150 },
  { ...WORK, Lat: 32.08 },
]) {
  test(`a trigger carrying ${Object.keys(leak).filter((key) => !(key in WORK)).join('+')} is refused and nothing is written`, async () => {
    const teardown = setup();
    try {
      await seed();
      const before = await getCommitment(ID, { participantId: USER });
      const response = await patch({ locationTrigger: leak });
      assert.equal(response.status, 400);
      const after = await getCommitment(ID, { participantId: USER });
      assert.deepEqual(after, before);
      assert.equal(after?.locationTrigger, undefined);
    } finally {
      teardown();
    }
  });
}

test('an unknown kind, a malformed place id, an empty or over-long label are refused', async () => {
  const teardown = setup();
  try {
    await seed();
    for (const bad of [
      { ...WORK, kind: 'near' },
      { ...WORK, placeId: 'has spaces' },
      { ...WORK, placeId: '' },
      { ...WORK, label: '   ' },
      { ...WORK, label: 'x'.repeat(61) },
      { ...WORK, label: 'line\nbreak' },
      { ...WORK, extra: true },
      'arrive',
    ]) {
      assert.equal((await patch({ locationTrigger: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await getCommitment(ID, { participantId: USER }))?.locationTrigger, undefined);
  } finally {
    teardown();
  }
});

test('no stored document and no export row holds a coordinate key', async () => {
  const teardown = setup();
  try {
    await seed();
    assert.equal((await patch({ locationTrigger: { ...WORK, kind: 'leave' } })).status, 200);
    // Try, and fail, to smuggle one in.
    assert.equal((await patch({ locationTrigger: { ...WORK, latitude: 1, longitude: 2 } })).status, 400);

    const exported = await buildAccountExport(USER, { storage });
    const row = exported.collections.commitments?.find((document) => (document.data as { id?: string }).id === ID);
    assert.ok(row, 'the export must carry the commitment');
    assert.deepEqual((row.data as { locationTrigger?: unknown }).locationTrigger, { ...WORK, kind: 'leave' });

    const forbidden = new Set<string>(LOCATION_TRIGGER_FORBIDDEN_FIELDS);
    const leaked = Array.from(keysDeep(exported)).filter((key) => forbidden.has(key));
    assert.deepEqual(leaked, []);
  } finally {
    teardown();
  }
});

test('the parser trims the label and keeps only the three fields', () => {
  assert.deepEqual(parseLocationTrigger({ kind: 'leave', placeId: 'place_1', label: '  Gym ' }), {
    kind: 'leave', placeId: 'place_1', label: 'Gym',
  });
});

// ── In review, with the confirm ─────────────────────────────────

const now = new Date('2026-09-14T10:00:00+03:00');

function harness() {
  return {
    store: new MemoryCaptureProposalStore(),
    persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
  };
}

async function proposeOne(dependencies = harness()) {
  const contract = await proposeCapture('Remind me to call the clinic tomorrow at 9am', {
    now, timezone: 'Asia/Jerusalem', scopeId: 'a', requestedEngine: 'rules',
  }, dependencies);
  return { contract, dependencies };
}

async function saved(dependencies: ReturnType<typeof harness>): Promise<Commitment[]> {
  return Object.values((await dependencies.persistence.snapshot()).commitments) as Commitment[];
}

test('a place reminder chosen in review is written with the commitment, in the same confirm', async () => {
  const { contract, dependencies } = await proposeOne();
  const itemId = contract.items[0].itemId;
  const result = await confirmCapture({
    proposalId: contract.proposalId, scopeId: 'a', selectedItemIds: [itemId], idempotencyKey: 'k1',
    edits: [{ itemId, locationTrigger: WORK }], now,
  }, dependencies);
  assert.equal(result.success, true);
  const [commitment] = await saved(dependencies);
  assert.deepEqual(commitment?.locationTrigger, WORK);
});

test('a review edit carrying a coordinate fails the whole confirm and saves nothing', async () => {
  const { contract, dependencies } = await proposeOne();
  const itemId = contract.items[0].itemId;
  const result = await confirmCapture({
    proposalId: contract.proposalId, scopeId: 'a', selectedItemIds: [itemId], idempotencyKey: 'k1',
    edits: [{ itemId, locationTrigger: { ...WORK, lat: 32.08, lng: 34.78 } }], now,
  }, dependencies);
  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'invalid_edit');
  assert.equal((await saved(dependencies)).length, 0);
});
