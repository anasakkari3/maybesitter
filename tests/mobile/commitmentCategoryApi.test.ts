/**
 * The category on the wire: what the lists carry, and what the user can change
 * (#415).
 *
 * The contract lives in the route, not in a document beside it, so these cases
 * read the real handlers. The first pair is what every screen depends on — a
 * field that is present and explicitly `null` rather than absent, because a
 * client cannot tell "the server does not send categories" from "this one has
 * none" when both arrive as `undefined`, and the filter bar has to.
 *
 * The PATCH cases carry the invariant the state machine enforces from the other
 * side: filing a commitment is the user speaking, so it is recorded as theirs,
 * and clearing it is speaking too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { PATCH as commitmentPatch } from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { getCommitment } from '../../lib/services/mobile/commitmentService.ts';
import { applyParticipantCommands } from '../../lib/services/mobile/participantState.ts';
import type { Command } from '../../src/domain/stateMachine.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('CommitmentCategoryUser');

let auth: FakeAuthControls | null = null;

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

/**
 * Seeded through the same commands the capture flow issues, so the fixture
 * cannot carry a shape the real path never produces.
 */
async function seed(category: 'work' | 'family' | null = null): Promise<{ id: string }> {
  const id = 'cmt_category_api';
  const commands: Command[] = [
    {
      type: 'CreateDraft',
      now: '2026-04-08T09:00:00.000Z',
      commitment: {
        id,
        kind: 'task',
        title: 'Send the invoice',
        category,
        timeSpec: {
          kind: 'due_by',
          dueAt: '2026-04-08T18:00:00.000Z',
          remindAt: '2026-04-08T17:00:00.000Z',
          timezone: 'UTC',
        },
      },
      draftStatus: 'pending_confirmation',
    },
    { type: 'ConfirmCommitment', commitmentId: id, now: '2026-04-08T09:00:01.000Z' },
  ];
  await applyParticipantCommands(USER, commands);
  return { id };
}

function todayRequest(): Request {
  return new Request(`${BASE}/api/mobile/commitments/today?referenceTime=2026-04-08T09:00:00.000Z`, {
    headers: { authorization: `Bearer ${tokenFor(USER)}` },
  });
}

function patchRequest(id: string, body: unknown): Request {
  return new Request(`${BASE}/api/mobile/commitments/${id}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${tokenFor(USER)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test("an uncategorised commitment says so on the wire rather than leaving the field out", async () => {
  const teardown = setup();
  try {
    await seed(null);
    const body = (await (await todayGet(todayRequest())).json()) as {
      items: Array<Record<string, unknown>>;
    };
    const row = body.items[0];
    assert.ok(row, 'the list must carry the seeded commitment');
    assert.ok('category' in row, 'category must be present, not absent');
    assert.equal(row.category, null);
    assert.equal(row.categorySource, 'inferred');
  } finally {
    teardown();
  }
});

test('a categorised commitment carries its category to the list', async () => {
  const teardown = setup();
  try {
    await seed('work');
    const body = (await (await todayGet(todayRequest())).json()) as {
      items: Array<Record<string, unknown>>;
    };
    assert.equal(body.items[0]?.category, 'work');
  } finally {
    teardown();
  }
});

test('filing a commitment through the API records it as the user"s own decision', async () => {
  const teardown = setup();
  try {
    const created = await seed(null);
    const response = await commitmentPatch(patchRequest(created.id, { category: 'family' }), {
      params: Promise.resolve({ id: created.id }),
    });
    assert.equal(response.status, 200);

    const stored = await getCommitment(created.id, { participantId: USER });
    assert.equal(stored?.category, 'family');
    assert.equal(stored?.categorySource, 'user_explicit');
  } finally {
    teardown();
  }
});

test('clearing the category through the API is recorded as a decision too', async () => {
  const teardown = setup();
  try {
    const created = await seed('work');
    await commitmentPatch(patchRequest(created.id, { category: null }), {
      params: Promise.resolve({ id: created.id }),
    });

    const stored = await getCommitment(created.id, { participantId: USER });
    assert.equal(stored?.category, null);
    assert.equal(stored?.categorySource, 'user_explicit');
  } finally {
    teardown();
  }
});

test('a category the catalog does not have is refused', async () => {
  const teardown = setup();
  try {
    const created = await seed('work');
    const response = await commitmentPatch(patchRequest(created.id, { category: 'hobbies' }), {
      params: Promise.resolve({ id: created.id }),
    });
    assert.equal(response.status, 400);

    const stored = await getCommitment(created.id, { participantId: USER });
    assert.equal(stored?.category, 'work', 'the refused patch changed nothing');
  } finally {
    teardown();
  }
});

test('a patch that does not mention the category leaves it alone', async () => {
  const teardown = setup();
  try {
    const created = await seed('work');
    await commitmentPatch(patchRequest(created.id, { title: 'Send the invoice today' }), {
      params: Promise.resolve({ id: created.id }),
    });

    const stored = await getCommitment(created.id, { participantId: USER });
    assert.equal(stored?.category, 'work');
    assert.equal(stored?.categorySource, 'inferred', 'an unrelated edit is not a category decision');
  } finally {
    teardown();
  }
});
