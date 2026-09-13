/**
 * The mobile capture funnel's analytics, through the real routes (UC-2.R2, #172).
 *
 * ── Why the routes and not the recorders ─────────────────────────
 *
 * Before this, `recordCaptureAnalytics` had unit tests and no mobile caller:
 * the funnel was fully specified, fully tested, and emitted exactly nothing
 * from the app people actually use. So every case here posts to
 * `POST /api/mobile/capture`, `POST /api/mobile/capture/confirm` or
 * `POST /api/mobile/analytics` and then reads the event store back. If the
 * wiring comes undone the events stop appearing, which no test of a recorder
 * can notice.
 *
 * ── The three claims being defended ──────────────────────────────
 *
 *  1. `capture_submitted` and `capture_confirmed` are derived on the server and
 *     are *refused* from a client, so nobody can forge funnel progress;
 *  2. nothing a user wrote reaches an event — counts only;
 *  3. a user who declined analytics produces no events at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAnalyticsEvents, resetAnalyticsEventsForTests } from '../../lib/analytics/eventStore.ts';
import { CLIENT_REPORTABLE_EVENTS } from '../../lib/analytics/loopAnalytics.ts';
import { validateAnalyticsEvent } from '../../lib/analytics/privacySafeEvents.ts';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { POST as analyticsPost } from '../../src/app/api/mobile/analytics/route.ts';
import type { PrivacySafeAnalyticsEvent } from '../../src/contracts/v1/analyticsEventContracts.ts';

const BASE = 'http://127.0.0.1:4321';
const REFERENCE_TIME = '2026-08-09T08:00:00.000Z';
const USER = uidFor('FunnelUser');

/**
 * Words nothing but the user's own message could contain. Every case that
 * writes a capture uses this text, so the leak check has something to find.
 */
const PRIVATE_TEXT = 'Call Ghaydaa about the biopsy results tomorrow at 3pm';

let auth: FakeAuthControls | null = null;

function request(path: string, body: unknown, uid = USER): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${tokenFor(uid)}`,
    },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function setup(): () => void {
  const directory = mkdtempSync(join(tmpdir(), 'maybesitter-capture-funnel-'));
  const previousDataDir = process.env.MAYBESITTER_DATA_DIR;
  process.env.MAYBESITTER_DATA_DIR = directory;
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
    if (previousDataDir === undefined) delete process.env.MAYBESITTER_DATA_DIR;
    else process.env.MAYBESITTER_DATA_DIR = previousDataDir;
    rmSync(directory, { recursive: true, force: true });
  };
}

async function grantAnalytics(uid = USER): Promise<void> {
  await applyTrustAction(uid, { type: 'set_analytics_consent', granted: true, at: new Date().toISOString() });
}

async function propose(text = PRIVATE_TEXT, uid = USER): Promise<Record<string, unknown>> {
  const response = await capturePost(request('/api/mobile/capture', {
    text,
    referenceTime: REFERENCE_TIME,
    timezone: 'UTC',
  }, uid));
  assert.equal(response.status, 200, 'the propose route must still answer 200');
  return json(response);
}

async function confirm(
  proposal: Record<string, unknown>,
  options: { idempotencyKey?: string; uid?: string } = {},
): Promise<Record<string, unknown>> {
  const itemIds = (proposal.items as Array<{ itemId: string }>).map((item) => item.itemId);
  const response = await confirmPost(request('/api/mobile/capture/confirm', {
    proposalId: proposal.proposalId,
    itemIds,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  }, options.uid ?? USER));
  assert.equal(response.status, 200, 'the confirm route must still answer 200');
  const body = await json(response);
  assert.equal(body.success, true);
  return body;
}

function named(events: readonly PrivacySafeAnalyticsEvent[], name: string): PrivacySafeAnalyticsEvent[] {
  return events.filter((event) => event.eventName === name);
}

test('the propose route records capture_submitted with a length and no text', async () => {
  const cleanup = setup();
  try {
    await grantAnalytics();
    await propose();

    const submitted = named(await getAnalyticsEvents(), 'capture_submitted');
    assert.equal(submitted.length, 1, 'a capture the server handled must be counted once');
    assert.equal(submitted[0].anonymousUserId, USER);
    assert.deepEqual(submitted[0].properties, { inputLength: PRIVATE_TEXT.length });
    assert.equal(validateAnalyticsEvent(submitted[0]).valid, true);
  } finally {
    await resetAnalyticsEventsForTests();
    cleanup();
  }
});

test('a capture with nothing to save still counts as a submission', async () => {
  const cleanup = setup();
  try {
    await grantAnalytics();
    // The denominator has to include the misses. A funnel whose first step only
    // counts the captures that worked cannot get worse than it already is.
    await propose('hey, how are you');

    const submitted = named(await getAnalyticsEvents(), 'capture_submitted');
    assert.equal(submitted.length, 1);
    assert.deepEqual(submitted[0].properties, { inputLength: 'hey, how are you'.length });
  } finally {
    await resetAnalyticsEventsForTests();
    cleanup();
  }
});

test('the confirm route records capture_confirmed, counted off committed state', async () => {
  const cleanup = setup();
  try {
    await grantAnalytics();
    const proposal = await propose();
    const confirmation = await confirm(proposal);

    const confirmed = named(await getAnalyticsEvents(), 'capture_confirmed');
    assert.equal(confirmed.length, 1);

    // Not the number of items the request asked for: the number that actually
    // carry a `confirmedAt` in this user's own tree once the write is done.
    const committed = Object.values((await getParticipantStateSnapshot(USER)).commitments)
      .filter((commitment) => Boolean(commitment.confirmedAt));
    assert.ok(committed.length > 0, 'the confirm must have committed something to count');
    assert.deepEqual(confirmed[0].properties, { confirmedCount: committed.length });
    assert.equal(
      (confirmation.persisted as unknown[]).length,
      committed.length,
      'the fixture is only meaningful while the two agree',
    );
  } finally {
    await resetAnalyticsEventsForTests();
    cleanup();
  }
});

test('a replayed confirm does not count a second confirmation', async () => {
  const cleanup = setup();
  try {
    await grantAnalytics();
    const proposal = await propose();
    await confirm(proposal, { idempotencyKey: 'one-intent' });
    const replay = await confirm(proposal, { idempotencyKey: 'one-intent' });
    assert.equal(replay.replayed, true, 'the second confirm must be a replay for this to mean anything');

    // One person's flaky connection is not funnel progress.
    assert.equal(named(await getAnalyticsEvents(), 'capture_confirmed').length, 1);
  } finally {
    await resetAnalyticsEventsForTests();
    cleanup();
  }
});

test('nothing anybody wrote reaches an event in the whole funnel', async () => {
  const cleanup = setup();
  try {
    await grantAnalytics();
    const proposal = await propose();
    await confirm(proposal);
    const undone = await analyticsPost(request('/api/mobile/analytics', {
      eventName: 'capture_undone',
      properties: { undoneCount: 1, stillSavedCount: 0 },
    }));
    assert.equal(undone.status, 200);

    const events = await getAnalyticsEvents();
    assert.deepEqual(
      events.map((event) => event.eventName),
      ['capture_submitted', 'capture_confirmed', 'first_value_reached', 'capture_undone'],
    );

    const serialized = JSON.stringify(events);
    // The words themselves, and the item and commitment ids the titles are
    // attached to — an id is a key back to the text.
    assert.doesNotMatch(serialized, /Ghaydaa|biopsy|Call|tomorrow/i);
    for (const item of proposal.items as Array<{ itemId: string; title: string }>) {
      assert.ok(!serialized.includes(item.itemId), `${item.itemId} leaked into an event`);
      assert.ok(!serialized.includes(item.title), 'a proposed title leaked into an event');
    }
    // Every property of every funnel event is a number.
    for (const event of events.filter((candidate) => candidate.eventName.startsWith('capture_'))) {
      for (const [key, value] of Object.entries(event.properties)) {
        assert.equal(typeof value, 'number', `${event.eventName}.${key} is not a count`);
      }
    }
  } finally {
    await resetAnalyticsEventsForTests();
    cleanup();
  }
});

test('a user who declined analytics produces no capture events at all', async () => {
  const cleanup = setup();
  try {
    // No `grantAnalytics`. The trust record's default is a decline.
    const proposal = await propose();
    await confirm(proposal);
    const undone = await analyticsPost(request('/api/mobile/analytics', {
      eventName: 'capture_undone',
      properties: { undoneCount: 1, stillSavedCount: 0 },
    }));
    // A success that recorded nothing, not an error: the user set a preference
    // and the product did what they asked.
    assert.equal(undone.status, 200);
    assert.equal((await json(undone)).recorded, false);

    assert.deepEqual(await getAnalyticsEvents(), []);
  } finally {
    await resetAnalyticsEventsForTests();
    cleanup();
  }
});

test('a client cannot report the two events the server derives', async () => {
  const cleanup = setup();
  try {
    await grantAnalytics();
    // Each one is sent with exactly the properties its own allowlist permits,
    // so the only thing left to refuse it for is the event name. A payload the
    // property allowlist would reject anyway would make this pass whether or
    // not the funnel is client-writable, which is the bug being guarded.
    const forgeries = [
      { eventName: 'capture_submitted', properties: { inputLength: 1 } },
      { eventName: 'capture_confirmed', properties: { confirmedCount: 99 } },
    ];
    for (const forgery of forgeries) {
      const response = await analyticsPost(request('/api/mobile/analytics', forgery));
      assert.equal(response.status, 400, `${forgery.eventName} must not be reportable by a client`);
      assert.match(String((await json(response)).error), /client reportable/);
    }
    // A funnel a client can write is a funnel that measures whatever the client
    // wants it to.
    assert.deepEqual(await getAnalyticsEvents(), []);
  } finally {
    await resetAnalyticsEventsForTests();
    cleanup();
  }
});

test('capture_undone carries two counts and refuses anything else', async () => {
  const cleanup = setup();
  try {
    await grantAnalytics();
    const accepted = await analyticsPost(request('/api/mobile/analytics', {
      eventName: 'capture_undone',
      properties: { undoneCount: 2, stillSavedCount: 1 },
    }));
    assert.equal(accepted.status, 200);
    assert.equal((await json(accepted)).recorded, true);

    const [event] = named(await getAnalyticsEvents(), 'capture_undone');
    assert.deepEqual(event.properties, { undoneCount: 2, stillSavedCount: 1 });

    const smuggled = await analyticsPost(request('/api/mobile/analytics', {
      eventName: 'capture_undone',
      properties: { undoneCount: 1, stillSavedCount: 0, title: PRIVATE_TEXT },
    }));
    assert.equal(smuggled.status, 400, 'a title on an undo must be refused, not stored');
    assert.equal(named(await getAnalyticsEvents(), 'capture_undone').length, 1);
  } finally {
    await resetAnalyticsEventsForTests();
    cleanup();
  }
});

test('the app\u2019s allowlist and the server\u2019s are the same list', () => {
  // Two copies, because the app cannot import server code. Read as text rather
  // than imported: `mobile/` is a separate package with its own dependencies
  // and its own TypeScript build, and pulling a module across that line here
  // would be a second problem. What matters is that the lists agree — a name
  // added to one and not the other is an event the app sends and the server
  // answers 400 to, which is silence that looks like collection.
  const source = readFileSync(new URL('../../mobile/src/api/schemas/analytics.ts', import.meta.url), 'utf8');
  const declaration = source.slice(source.indexOf('export const CLIENT_REPORTABLE_EVENTS'));
  const names: string[] = [];
  const quoted = /'([a-z_]+)'/g;
  const body = declaration.slice(0, declaration.indexOf('] as const;'));
  for (let match = quoted.exec(body); match !== null; match = quoted.exec(body)) names.push(match[1]);

  assert.deepEqual([...names].sort(), [...CLIENT_REPORTABLE_EVENTS].sort());
  assert.ok(names.includes('capture_undone'));
  for (const derived of ['capture_submitted', 'capture_confirmed']) {
    assert.ok(!names.includes(derived), `${derived} must stay server-derived`);
  }
});
