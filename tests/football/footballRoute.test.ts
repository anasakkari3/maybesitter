// tests/football/footballRoute.test.ts
/**
 * The mobile surface for football fixtures (Task 11): pick a club, get the
 * matches, dismiss the ones you don't want.
 *
 * ── Where "is this a feed commitment" lives ───────────────────────────────
 * `Commitment.origin` does not exist (see `projectFixtures.ts`'s header) --
 * an earlier task added and withdrew it because a sealed annotation corpus
 * checksums the whole serialised commitment. So this route never reads a
 * field off a commitment to decide whether a dismiss action applies to it.
 * Instead:
 *  - `GET`/`PUT` return `fixtures`, the caller's own currently-active
 *    fixture-linked commitments -- built by joining `listRefs(uid)` against
 *    that uid's own domain state, exactly the join `dismissFixtureCommitment`
 *    itself does. A commitment the user typed never appears in this list,
 *    so a client that only ever offers the dismiss action for rows in
 *    `fixtures` never shows it on a user-typed commitment in the first place.
 *  - `DELETE .../fixtures/{commitmentId}` is the second, server-side check:
 *    `dismissFixtureCommitment` throws when no ref in *this user's own tree*
 *    links `commitmentId`, and that throw is what turns into this route's
 *    404 -- true both for an id that does not exist and for one that names a
 *    real, user-typed commitment. Belt and suspenders: the UI never offers
 *    the button, and the route refuses the call even if something did.
 *
 * ── The race this route makes reachable ───────────────────────────────────
 * `task-8-report.md`'s "Fix round 3" section names a real, unfixed TOCTOU
 * race between `projectFixturesForUser` and `dismissFixtureCommitment`, and
 * says whoever wires a caller to the dismiss side should read it first. This
 * route is that caller -- see `task-11-report.md` for the answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { upsertFixtures } from '../../lib/football/fixtureStore.ts';
import { listRefs } from '../../lib/football/externalTaskRefStore.ts';
import { applyParticipantCommand } from '../../lib/services/mobile/participantState.ts';
import {
  fixtureContentHash,
  FIXTURE_CONTRACT_VERSION,
  FIXTURE_SCHEMA_VERSION,
  type Fixture,
  type FixtureCore,
} from '../../src/contracts/v1/fixtureContracts.ts';
import { GET, PUT } from '../../src/app/api/mobile/football/route.ts';
import { DELETE } from '../../src/app/api/mobile/football/fixtures/[commitmentId]/route.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('FootballUser');

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

function authedRequest(method: string, body?: unknown, uid = USER): Request {
  return new Request(`${BASE}/api/mobile/football`, {
    method,
    headers: {
      authorization: `Bearer ${tokenFor(uid)}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function dismissRequest(uid = USER): Request {
  return new Request(`${BASE}/api/mobile/football/fixtures/dismiss`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${tokenFor(uid)}` },
  });
}

function dismissParams(commitmentId: string): { params: Promise<{ commitmentId: string }> } {
  return { params: Promise.resolve({ commitmentId }) };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

// Same shape as tests/football/projectFixtures.test.ts's helper -- copied,
// not imported, per that file's own convention (see its comment).
function fixture(id: string, kickoffUtc: string, over: Partial<FixtureCore> = {}): Fixture {
  const core: FixtureCore = {
    provider: 'football-data', providerMatchId: id, competition: 'PD',
    homeTeamId: '81', awayTeamId: '86', homeTeamName: 'FC Barcelona',
    awayTeamName: 'Real Madrid CF', kickoffUtc, status: 'scheduled', venue: null,
    ...over,
  };
  return { ...core, version: FIXTURE_CONTRACT_VERSION, schemaVersion: FIXTURE_SCHEMA_VERSION, contentHash: fixtureContentHash(core) };
}

/** A commitment nobody's follow list ever touched -- a user typed this. */
async function userTypedCommitment(uid: string, id: string): Promise<string> {
  const now = '2026-10-01T09:00:00.000Z';
  await applyParticipantCommand(uid, {
    type: 'CreateDraft', now, commitment: { id, kind: 'task', title: 'Pick up the kids' },
    draftStatus: 'pending_confirmation',
  });
  await applyParticipantCommand(uid, { type: 'ConfirmCommitment', commitmentId: id, now });
  return id;
}

test('the list is served with the follows', async () => {
  const teardown = setup();
  try {
    const body = await json(await GET(authedRequest('GET')));
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.clubs) && body.clubs.length >= 12);
    assert.deepEqual(body.followedClubIds, []);
    assert.deepEqual(body.fixtures, []);
  } finally {
    teardown();
  }
});

test('a follow is saved and read back', async () => {
  const teardown = setup();
  try {
    await PUT(authedRequest('PUT', { clubIds: ['barcelona'] }));
    const body = await json(await GET(authedRequest('GET')));
    assert.deepEqual(body.followedClubIds, ['barcelona']);
  } finally {
    teardown();
  }
});

test('an unknown club is a 400, not a 500', async () => {
  const teardown = setup();
  try {
    const res = await PUT(authedRequest('PUT', { clubIds: ['not-a-club'] }));
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.success, false);
  } finally {
    teardown();
  }
});

test('each club carries a name in every supported language', async () => {
  const teardown = setup();
  try {
    const body = await json(await GET(authedRequest('GET'))) as { clubs: { names: Record<string, string> }[] };
    for (const club of body.clubs) {
      for (const lang of ['ar', 'he', 'en']) assert.ok(club.names[lang], `missing ${lang} name`);
    }
  } finally {
    teardown();
  }
});

test('saving a follow projects immediately -- the first match needs no nightly job', async () => {
  const teardown = setup();
  try {
    await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
    const body = await json(await PUT(authedRequest('PUT', { clubIds: ['barcelona'] })));
    const fixtures = body.fixtures as { commitmentId: string; homeTeamName: string; awayTeamName: string; kickoffUtc: string; collisions: unknown[] }[];
    assert.equal(fixtures.length, 1);
    assert.equal(fixtures[0]!.homeTeamName, 'FC Barcelona');
    assert.equal(fixtures[0]!.kickoffUtc, '2026-10-25T19:00:00.000Z');
    assert.deepEqual(fixtures[0]!.collisions, []);

    // And GET reads the same projected list back without projecting again.
    const read = await json(await GET(authedRequest('GET')));
    assert.deepEqual(read.fixtures, body.fixtures);
  } finally {
    teardown();
  }
});

test('a projected match says so when something else already landed on top of it', async () => {
  const teardown = setup();
  try {
    const now = '2026-09-16T09:00:00.000Z';
    // A commitment the user made themselves, half an hour into the match's
    // two-hour block.
    await applyParticipantCommand(USER, {
      type: 'CreateDraft', now,
      commitment: {
        id: 'dinner', kind: 'task', title: 'Dinner with the in-laws',
        timeSpec: { kind: 'scheduled_event', dueAt: '2026-10-25T19:30:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
      },
      draftStatus: 'pending_confirmation',
    });
    await applyParticipantCommand(USER, { type: 'ConfirmCommitment', commitmentId: 'dinner', now });

    await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
    const body = await json(await PUT(authedRequest('PUT', { clubIds: ['barcelona'] })));
    const [projected] = body.fixtures as { collisions: { commitmentId: string; title: string }[] }[];
    assert.equal(projected!.collisions.length, 1);
    assert.equal(projected!.collisions[0]!.commitmentId, 'dinner');
    assert.equal(projected!.collisions[0]!.title, 'Dinner with the in-laws');
  } finally {
    teardown();
  }
});

test('dismissing is remembered, not just applied', async () => {
  const teardown = setup();
  try {
    await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
    const put = await json(await PUT(authedRequest('PUT', { clubIds: ['barcelona'] })));
    const [projected] = put.fixtures as { commitmentId: string }[];
    assert.ok(projected, 'the follow should have projected a fixture');

    const res = await DELETE(dismissRequest(), dismissParams(projected.commitmentId));
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.success, true);
    assert.equal(body.dismissed, true);

    const refs = await listRefs(USER);
    assert.equal(refs.length, 1);
    assert.ok(refs[0]!.detachedAt, 'a dismissal that leaves no detachedAt is undone by the next sync');

    // And it drops out of the served list -- the whole point of dismissing.
    const read = await json(await GET(authedRequest('GET')));
    assert.deepEqual(read.fixtures, []);
  } finally {
    teardown();
  }
});

test('a user-typed commitment cannot be dismissed through this route', async () => {
  const teardown = setup();
  try {
    const id = await userTypedCommitment(USER, 'user-typed-1');
    const res = await DELETE(dismissRequest(), dismissParams(id));
    assert.equal(res.status, 404);
  } finally {
    teardown();
  }
});

test('an unknown commitment id is a 404, not a 500', async () => {
  const teardown = setup();
  try {
    const res = await DELETE(dismissRequest(), dismissParams('no-such-commitment'));
    assert.equal(res.status, 404);
  } finally {
    teardown();
  }
});
