/**
 * A played match is closed for everyone, and a held match whose kickoff has
 * passed is no longer asked about (spec Part 1, "Football", lane E1).
 *
 * ── Closure ──────────────────────────────────────────────────────
 *
 * `completeEndedFixtures` ran only inside the nightly football sync, and that
 * job skips anyone who switched football off (`footballSwitchedOff`). Their
 * fixture commitments were never closed: switching football off froze every
 * match already saved as active, for ever. The nightly maintenance pass now
 * closes every ended, still-live, fixture-linked commitment in the install,
 * whatever the switch says and whether or not the provider key is set. It
 * credits nothing — a final whistle is not the person doing a thing — exactly
 * as the sync's own closure does.
 *
 * ── Held items (audit CA11.1) ────────────────────────────────────
 *
 * A held match or calendar item is a question: "this clashes, add it anyway?"
 * Once its start has passed, the question is moot, and `held-items` kept
 * asking it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userSubDoc, ICS_FEED_ITEMS } from '../../lib/storage/paths.ts';
import { upsertFixtures } from '../../lib/football/fixtureStore.ts';
import { setFollowedClubs } from '../../lib/football/followedClubs.ts';
import { completeEndedFixturesForEveryone, listHeldFixtures, projectFixturesForUser } from '../../lib/football/projectFixtures.ts';
import { refDocPath } from '../../lib/football/externalTaskRefStore.ts';
import { listHeldIcsItems } from '../../lib/calendar/icsFeeds.ts';
import { setFeaturePreference } from '../../lib/features/accountFeatures.ts';
import { runMaintenance } from '../../lib/jobs/internalJobs.ts';
import { persistParticipantState, readParticipantState } from '../../lib/services/mobile/participantState.ts';
import { listEvents } from '../../lib/services/mobile/eventLog.ts';
import { fixtureContentHash, FIXTURE_CONTRACT_VERSION, FIXTURE_SCHEMA_VERSION, type Fixture, type FixtureCore } from '../../src/contracts/v1/fixtureContracts.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';

/** Projected well before the match. */
const BEFORE = '2026-11-01T09:00:00.000Z';
/** Wednesday 2026-11-11 19:00Z kickoff: over at 21:00Z. */
const KICKOFF = '2026-11-11T19:00:00.000Z';
/** 2026-11-12 15:00 in Jerusalem, the scenario's clock. */
const NOW = new Date('2026-11-12T13:00:00.000Z');

function fixture(id: string, kickoffUtc: string): Fixture {
  const core: FixtureCore = {
    provider: 'football-data', providerMatchId: id, competition: 'PD',
    homeTeamId: '81', awayTeamId: '86', homeTeamName: 'FC Barcelona',
    awayTeamName: 'Real Madrid CF', kickoffUtc, status: 'scheduled', venue: null,
  };
  return { ...core, version: FIXTURE_CONTRACT_VERSION, schemaVersion: FIXTURE_SCHEMA_VERSION, contentHash: fixtureContentHash(core) };
}

async function commitmentsOf(uid: string) {
  return Object.values((await readParticipantState(uid)).commitments);
}

test.beforeEach(() => setStorageForTests(createMemoryStorage()));
test.afterEach(() => resetStorageForTests());

/** A follower of Barcelona with the match saved, who then switched football off. */
async function footballOffUserWithMatch(uid: string, kickoffUtc = KICKOFF): Promise<string> {
  await seedLiveAccount(uid);
  await setFollowedClubs(uid, ['barcelona'], BEFORE);
  await upsertFixtures([fixture(`m-${uid}`, kickoffUtc)]);
  const tally = await projectFixturesForUser(uid, BEFORE);
  assert.equal(tally.created, 1, 'sanity: the match was saved');
  await setFeaturePreference(uid, 'football', false, { storage: getStorage(), now: new Date(BEFORE) });
  const [match] = await commitmentsOf(uid);
  assert.equal(match.status, 'active');
  return match.id;
}

test('E1 football: maintenance closes a football-off user\'s ended match', async () => {
  const id = await footballOffUserWithMatch('u-off');
  const result = await runMaintenance({ now: NOW });
  assert.equal(result.ok, true);
  const step = result.steps.find((entry) => entry.name === 'ended_fixtures_completed');
  assert.deepEqual(step, { name: 'ended_fixtures_completed', ok: true, count: 1 });
  const [match] = await commitmentsOf('u-off');
  assert.equal(match.id, id);
  assert.equal(match.status, 'completed', 'a played match is history, not a live item');
  // A final whistle is not the person finishing something: no credit.
  const { events } = await listEvents('u-off');
  assert.equal(events.some((event) => event.type === 'commitment_completed'), false);
});

test('E1 football: maintenance leaves a match still being played, and is idempotent', async () => {
  await footballOffUserWithMatch('u-live', '2026-11-12T12:00:00.000Z'); // over at 14:00Z
  assert.deepEqual(
    (await runMaintenance({ now: NOW })).steps.find((entry) => entry.name === 'ended_fixtures_completed'),
    { name: 'ended_fixtures_completed', ok: true, count: 0 },
  );
  assert.equal((await commitmentsOf('u-live'))[0].status, 'active');
  const after = new Date('2026-11-12T14:00:00.000Z');
  assert.equal((await runMaintenance({ now: after })).steps.find((entry) => entry.name === 'ended_fixtures_completed')?.count, 1);
  assert.equal((await runMaintenance({ now: after })).steps.find((entry) => entry.name === 'ended_fixtures_completed')?.count, 0);
});

test('E1 football: the sweep touches only football refs — a Todoist-linked task is never completed (review item 5)', async () => {
  // The shared `externalTaskRefs` collection is the contract for every task
  // provider (#417). A `todoist:42` ref linked to an ordinary task whose time
  // has passed must not be read as a match that ended.
  await seedLiveAccount('u-todo');
  const state = await readParticipantState('u-todo');
  state.commitments.call = {
    id: 'call', kind: 'task', title: 'Call Alice', description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt: '2026-11-11T07:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'Asia/Jerusalem' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: BEFORE, updatedAt: BEFORE, confirmedAt: BEFORE, completedAt: null, droppedAt: null,
  } as never;
  await persistParticipantState('u-todo', state);
  await getStorage().set(refDocPath('u-todo', 'todoist:42'), {
    scopeId: 'u-todo', taskRefId: 'todoist:42',
    identity: {
      provider: 'todoist',
      providerIdentity: { provider: 'todoist', providerAccountId: 'acct', providerSpaceId: null, displayName: null },
      connectionId: 'conn-todoist-1', externalId: '42', externalUrl: null,
    },
    linkState: 'linked', linkedCommitmentId: 'call', detachedAt: null, updatedAt: BEFORE,
  });
  const step = (await runMaintenance({ now: NOW })).steps.find((entry) => entry.name === 'ended_fixtures_completed');
  assert.deepEqual(step, { name: 'ended_fixtures_completed', ok: true, count: 0 });
  assert.equal((await readParticipantState('u-todo')).commitments.call?.status, 'active');
  // Nor is a Todoist-only account counted as holding a fixture (review round 2).
  assert.deepEqual(await completeEndedFixturesForEveryone(NOW.toISOString()), { users: 0, completed: 0, failed: 0 });
  // And the nightly sync's own closure, which lists the account's refs itself,
  // leaves it alone too.
  await setFollowedClubs('u-todo', ['barcelona'], BEFORE);
  assert.equal((await projectFixturesForUser('u-todo', NOW.toISOString())).completed, 0);
  assert.equal((await readParticipantState('u-todo')).commitments.call?.status, 'active');
});

/* ── Held items ──────────────────────────────────────────────────── */

function heldRef(uid: string, id: string, kickoffUtc: string, reason: 'clash' | 'unknown' = 'clash') {
  const endUtc = new Date(Date.parse(kickoffUtc) + 2 * 60 * 60_000).toISOString();
  return {
    uid, taskRefId: `football-data:${id}`, linkState: 'candidate', linkedCommitmentId: null,
    homeTeamName: 'FC Barcelona', awayTeamName: 'Real Madrid CF', kickoffUtc,
    held: { reason, clashes: [], kickoffUtc, endUtc, contentHash: 'h', moved: false, at: BEFORE },
  };
}

test('E1 held items: a held match whose kickoff has passed is no longer offered', async () => {
  await seedLiveAccount('u-held');
  const storage = getStorage();
  await storage.set(refDocPath('u-held', 'football-data:past'), heldRef('u-held', 'past', KICKOFF));
  await storage.set(refDocPath('u-held', 'football-data:now'), heldRef('u-held', 'now', NOW.toISOString()));
  await storage.set(refDocPath('u-held', 'football-data:next'), heldRef('u-held', 'next', '2026-11-14T19:00:00.000Z'));
  const { held } = await listHeldFixtures('u-held', NOW);
  assert.deepEqual(held.map((row) => row.fixtureId), ['football-data:next']);
});

test('E1 held items: a held calendar item whose start has passed is no longer offered', async () => {
  await seedLiveAccount('u-ics');
  const storage = getStorage();
  const row = (itemKey: string, dueAt: string) => ({
    itemKey, feedId: 'feed1', recurrenceId: null, sequence: 0, dtstamp: null, title: itemKey, dueAt, allDay: false,
    state: 'pending', notice: null, proposedDueAt: null, held: { reason: 'clash', clashes: [] },
    commitmentId: null, autoAccepted: false, reappeared: false, firstSeenAt: BEFORE, updatedAt: BEFORE,
  });
  await storage.set(userSubDoc('u-ics', ICS_FEED_ITEMS, 'past'), row('past', '2026-11-12T08:00:00.000Z'));
  await storage.set(userSubDoc('u-ics', ICS_FEED_ITEMS, 'atnow'), row('atnow', NOW.toISOString()));
  await storage.set(userSubDoc('u-ics', ICS_FEED_ITEMS, 'later'), row('later', '2026-11-13T08:00:00.000Z'));
  const items = await listHeldIcsItems('u-ics', { now: () => NOW });
  assert.deepEqual(items.map((item) => item.title), ['later']);
});

test('E1 held items: a match held for unknown coverage stops waiting once it has kicked off (review item 6)', async () => {
  await seedLiveAccount('u-unknown');
  const storage = getStorage();
  await storage.set(refDocPath('u-unknown', 'football-data:u-past'), heldRef('u-unknown', 'u-past', KICKOFF, 'unknown'));
  await storage.set(refDocPath('u-unknown', 'football-data:u-now'), heldRef('u-unknown', 'u-now', NOW.toISOString(), 'unknown'));
  await storage.set(refDocPath('u-unknown', 'football-data:u-next'), heldRef('u-unknown', 'u-next', '2026-11-14T19:00:00.000Z', 'unknown'));
  const { held, waitingForCoverage } = await listHeldFixtures('u-unknown', NOW);
  assert.deepEqual(held, []);
  assert.equal(waitingForCoverage, 1);
});
