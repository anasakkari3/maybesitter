/**
 * "The app should warn him if he added a commitment that there is a
 * collision" -- the owner's sentence, driven through the paths a user's own
 * commitment actually takes (final review C2).
 *
 * The first collision tests hand-built `scheduled_event` candidates. Nothing a
 * user types is one: capture extracts `due_by` (or `unscheduled`), and an edit
 * that moves a time writes `due_by`. So the warning could never fire for a
 * commitment the user added, and every test stayed green. These tests start
 * from text and from the edit route instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { upsertFixtures } from '../../lib/football/fixtureStore.ts';
import { setFollowedClubs } from '../../lib/football/followedClubs.ts';
import { projectFixturesForUser } from '../../lib/football/projectFixtures.ts';
import { confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { readParticipantState } from '../../lib/services/mobile/participantState.ts';
import { PATCH } from '../../src/app/api/mobile/commitments/[id]/route.ts';
import {
  fixtureContentHash,
  FIXTURE_CONTRACT_VERSION,
  FIXTURE_SCHEMA_VERSION,
  type Fixture,
  type FixtureCore,
} from '../../src/contracts/v1/fixtureContracts.ts';

const USER = uidFor('CollisionUser');
const PROJECTED_AT = '2026-10-01T09:00:00.000Z';

function fixture(id: string, kickoffUtc: string): Fixture {
  const core: FixtureCore = {
    provider: 'football-data', providerMatchId: id, competition: 'PD',
    homeTeamId: '81', awayTeamId: '86', homeTeamName: 'FC Barcelona',
    awayTeamName: 'Real Madrid CF', kickoffUtc, status: 'scheduled', venue: null,
  };
  return { ...core, version: FIXTURE_CONTRACT_VERSION, schemaVersion: FIXTURE_SCHEMA_VERSION, contentHash: fixtureContentHash(core) };
}

let auth: FakeAuthControls | null = null;

test.beforeEach(async () => {
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  // Barcelona v Real Madrid, 19:00-21:00 UTC on 25 October, projected the
  // way the follow route and the nightly job project it.
  await setFollowedClubs(USER, ['barcelona'], PROJECTED_AT);
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser(USER, PROJECTED_AT);
});

test.afterEach(() => {
  auth?.restore();
  auth = null;
  resetStorageForTests();
});

test('a captured commitment that lands on a projected match is warned about, naming the match', async () => {
  const proposal = await proposeMobileCapture(
    { text: 'Call the dentist tomorrow at 8pm', timezone: 'UTC', referenceTime: '2026-10-24T09:00:00.000Z' },
    { participantId: USER },
  );
  assert.equal(proposal.status, 'proposed');
  const result = await confirmMobileCapture(
    { proposalId: proposal.proposalId, itemIds: [proposal.items[0]!.itemId] },
    { participantId: USER },
  );
  assert.equal(result.success, true);

  // Sanity: this is the shape capture really writes -- not a scheduled event.
  const state = await readParticipantState(USER);
  const captured = state.commitments[result.persisted[0]!.commitmentId]!;
  assert.equal(captured.timeSpec.kind, 'due_by');
  assert.equal(captured.timeSpec.dueAt, '2026-10-25T20:00:00.000Z');

  assert.equal(result.collisions.length, 1);
  assert.equal(result.collisions[0]!.title, 'FC Barcelona – Real Madrid CF');
  assert.equal(result.collisions[0]!.startsAt, '2026-10-25T19:00:00.000Z');
  assert.equal(result.collisions[0]!.endsAt, '2026-10-25T21:00:00.000Z');
});

test('a captured commitment clear of the match gets no warning', async () => {
  const proposal = await proposeMobileCapture(
    { text: 'Call the dentist tomorrow at 9am', timezone: 'UTC', referenceTime: '2026-10-24T08:00:00.000Z' },
    { participantId: USER },
  );
  const result = await confirmMobileCapture(
    { proposalId: proposal.proposalId, itemIds: [proposal.items[0]!.itemId] },
    { participantId: USER },
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.collisions, []);
});

test('moving a commitment onto the match through the edit route returns the warning', async () => {
  const proposal = await proposeMobileCapture(
    { text: 'Call the dentist tomorrow at 9am', timezone: 'UTC', referenceTime: '2026-10-24T08:00:00.000Z' },
    { participantId: USER },
  );
  const confirmed = await confirmMobileCapture(
    { proposalId: proposal.proposalId, itemIds: [proposal.items[0]!.itemId] },
    { participantId: USER },
  );
  const id = confirmed.persisted[0]!.commitmentId;

  const response = await PATCH(new Request(`http://127.0.0.1:4321/api/mobile/commitments/${id}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${tokenFor(USER)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dueDate: '2026-10-25T19:30:00.000Z', reminderTime: null }),
  }), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200);
  const body = await response.json() as { collisions?: { title: string }[] };
  assert.deepEqual(body.collisions?.map((c) => c.title), ['FC Barcelona – Real Madrid CF']);
});

// ── Residual R3: two deadlines at the same time are not a clash ─────────
//
// Capture cannot tell "at 5pm" from "by 5pm" -- both are `due_by`. Two
// deadlines due at the same hour are an ordinary Friday, not a double
// booking, so a warning needs at least one real fixed event on one side.
test('two captured deadlines at the same time do not warn about each other', async () => {
  const capture = async (text: string) => {
    const proposal = await proposeMobileCapture(
      { text, timezone: 'UTC', referenceTime: '2026-10-29T08:00:00.000Z' },
      { participantId: USER },
    );
    return confirmMobileCapture(
      { proposalId: proposal.proposalId, itemIds: [proposal.items[0]!.itemId] },
      { participantId: USER },
    );
  };
  const first = await capture('Pay the rent tomorrow at 5pm');
  const second = await capture('Submit the report tomorrow at 5pm');
  assert.equal(first.success && second.success, true);
  const state = await readParticipantState(USER);
  const dues = [first, second].map((r) => state.commitments[r.persisted[0]!.commitmentId]!.timeSpec);
  assert.deepEqual(dues.map((t) => [t.kind, t.dueAt]), [['due_by', '2026-10-30T17:00:00.000Z'], ['due_by', '2026-10-30T17:00:00.000Z']]);
  assert.deepEqual(second.collisions, []);
});
