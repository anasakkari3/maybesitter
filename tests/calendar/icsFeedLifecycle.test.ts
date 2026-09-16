/**
 * A subscribed calendar feed, from paste to unsubscribe (UC-3.4, #188).
 *
 * Everything here goes through the route handlers with a fake Firebase token,
 * the real memory storage adapter, the real in-memory KMS double and a fake
 * fetch — the one thing that is not real is the network, and `safeFetch` has
 * its own suite over TLS. `now` is injected and fixed; the domain applies it to
 * every command, so nothing here reads the wall clock's date.
 *
 * The acceptance criteria, each a test below:
 * - a Moodle export yields the expected counts and lectures never become commitments;
 * - refreshing twice creates no duplicates, and a SEQUENCE bump updates the pending row;
 * - auto-accept off: nothing becomes a commitment without an accept; on: commitments with an Activity entry and Undo;
 * - Firestore holds only the encrypted URL, and no log line or response contains it;
 * - unsubscribing removes busy blocks and pending proposals and keeps accepted commitments;
 * - the scheduler endpoint refuses unauthenticated calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { BUSY_BLOCKS, CALENDAR_SOURCES, ICS_FEED_ITEMS, ICS_FEEDS, USER_SCOPED_COLLECTIONS, userCol, userDoc, userSubDoc } from '../../lib/storage/paths.ts';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { createInMemoryKms, type InMemoryKms } from '../../lib/security/inMemoryKms.ts';
import { decryptField, fieldPurpose, FieldEncryptionError, KMS_KEY_ENV_VAR, resetFieldEncryptionForTests } from '../../lib/security/fieldEncryption.ts';
import { AUDIENCE_ENV_VAR, SCHEDULER_SA_ENV_VAR, type OidcPayload } from '../../lib/auth/schedulerOidc.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { listActivity } from '../../lib/services/activity/activityService.ts';
import { SafeFetchError, type SafeFetchOptions, type SafeFetchResult } from '../../lib/net/safeFetch.ts';
import {
  FAILURES_BEFORE_ERROR,
  MANUAL_REFRESH_COOLDOWN_MS,
  MAX_FEEDS_PER_USER,
  REFRESH_INTERVAL_MS,
  icsBusyBlocks,
  type IcsFeedDocument,
  type IcsFeedItemDocument,
} from '../../lib/calendar/icsFeeds.ts';
import {
  handleCreateFeed,
  handleDeadlineDecision,
  handleDeleteFeed,
  handleIcsRefreshTick,
  handleListFeeds,
  handleRefreshFeed,
  handleUpdateFeed,
  type IcsRouteDeps,
} from '../../lib/calendar/icsFeedRoutes.ts';
import { POST as realCreateRoute } from '../../src/app/api/mobile/calendar/ics/route.ts';
import { requireMobileUser } from '../../lib/auth/mobileAuth.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const MOODLE = readFileSync(path.join(here, '..', 'fixtures', 'ics', 'moodle.ics'), 'utf8');

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('IcsFeedUser');
const OTHER = uidFor('IcsFeedOther');
const NOW = new Date('2026-10-05T08:00:00Z');
const SECRET = 'SECRETTOKEN0123456789abcdef';
const FEED_URL = `https://moodle.univ.example/calendar/export_execute.php?userid=42&authtoken=${SECRET}&preset_what=all`;
const HOST = 'moodle.univ.example';

/* ── Harness ───────────────────────────────────────────────────────── */

interface Harness {
  deps: IcsRouteDeps;
  kms: InMemoryKms;
  bodies: Map<string, string>;
  fetches: Array<{ url: string; options: SafeFetchOptions }>;
  logs: string[];
  clock: { now: Date };
  failNext: SafeFetchError | null;
}

function harness(): Harness {
  const kms = createInMemoryKms();
  const bodies = new Map<string, string>();
  const fetches: Harness['fetches'] = [];
  const logs: string[] = [];
  const clock = { now: NOW };
  const h: Harness = {
    kms, bodies, fetches, logs, clock, failNext: null,
    deps: {
      env: { NODE_ENV: 'test', ICS_FEEDS_ENABLED: 'true', [KMS_KEY_ENV_VAR]: kms.keyName } as NodeJS.ProcessEnv,
      now: () => clock.now,
      encryption: { kms, env: { NODE_ENV: 'test', [KMS_KEY_ENV_VAR]: kms.keyName } as NodeJS.ProcessEnv },
      log: (line) => logs.push(line),
      fetch: async (url: string, options: SafeFetchOptions): Promise<SafeFetchResult> => {
        fetches.push({ url, options });
        if (h.failNext) {
          const error = h.failNext;
          h.failNext = null;
          throw error;
        }
        const body = bodies.get(url);
        if (body === undefined) throw new SafeFetchError('http_status', 404);
        return { notModified: false, body, etag: '"e1"', lastModified: null };
      },
    },
  };
  return h;
}

let auth: FakeAuthControls | null = null;
const consoleLines: string[] = [];

async function withWorld(run: (h: Harness) => Promise<void>): Promise<void> {
  setStorageForTests(createMemoryStorage());
  resetFieldEncryptionForTests();
  auth = installFakeAuth();
  const saved = { info: console.info, log: console.log, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => { consoleLines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.info = capture; console.log = capture; console.warn = capture; console.error = capture;
  try {
    await withConsent(USER);
    await run(harness());
  } finally {
    Object.assign(console, saved);
    auth?.restore();
    auth = null;
    resetStorageForTests();
    resetFieldEncryptionForTests();
  }
}

async function withConsent(uid: string): Promise<void> {
  await applyTrustAction(uid, { type: 'record_first_value', at: NOW.toISOString() });
  await applyTrustAction(uid, { type: 'set_calendar_consent', granted: true, at: NOW.toISOString() });
}

function request(method: string, pathName: string, body?: unknown, uid: string | null = USER): Request {
  return new Request(`${BASE}${pathName}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(uid === null ? {} : { authorization: `Bearer ${tokenFor(uid)}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  responseTexts.push(text);
  return JSON.parse(text) as Record<string, any>;
}
const responseTexts: string[] = [];

/** The uid a request's token names, as the route files resolve it before calling a handler. */
async function uidOf(req: Request): Promise<string> {
  return (await requireMobileUser(req)).uid;
}

async function call<A extends unknown[]>(
  handler: (req: Request, uid: string, ...rest: A) => Promise<Response>,
  req: Request,
  ...rest: A
): Promise<Response> {
  return handler(req, await uidOf(req), ...rest);
}

async function subscribe(h: Harness, body: Record<string, unknown> = {}, uid = USER): Promise<{ status: number; body: Record<string, any> }> {
  const response = await call(handleCreateFeed, request('POST', '/api/mobile/calendar/ics', { url: FEED_URL, ...body }, uid), h.deps);
  return { status: response.status, body: await json(response) };
}

function fmt(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Item { uid: string; title: string; dueInHours: number; sequence?: number; stamp?: string }
interface Lecture { uid: string; startInHours: number; hours: number }

function calendar(items: Item[], lectures: Lecture[] = []): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN'];
  for (const item of items) {
    const due = fmt(NOW.getTime() + item.dueInHours * HOUR);
    lines.push('BEGIN:VEVENT', `UID:${item.uid}`, `SUMMARY:${item.title}`, `SEQUENCE:${item.sequence ?? 0}`,
      `DTSTAMP:${item.stamp ?? '20260915T080000Z'}`, `DTSTART:${due}`, `DTEND:${due}`, 'END:VEVENT');
  }
  for (const lecture of lectures) {
    const start = NOW.getTime() + lecture.startInHours * HOUR;
    lines.push('BEGIN:VEVENT', `UID:${lecture.uid}`, 'SUMMARY:Lecture', 'DTSTAMP:20260915T080000Z',
      `DTSTART:${fmt(start)}`, `DTEND:${fmt(start + lecture.hours * HOUR)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR', '');
  return lines.join('\r\n');
}

async function items(uid = USER): Promise<IcsFeedItemDocument[]> {
  return (await getStorage().list<IcsFeedItemDocument>(userCol(uid, ICS_FEED_ITEMS))).map((row) => row.data);
}

async function feeds(uid = USER): Promise<IcsFeedDocument[]> {
  return (await getStorage().list<IcsFeedDocument>(userCol(uid, ICS_FEEDS))).map((row) => row.data);
}

async function commitments(uid = USER) {
  return Object.values((await getParticipantStateSnapshot(uid)).commitments);
}

async function refresh(h: Harness, feedId: string, uid = USER): Promise<Record<string, any>> {
  const response = await call(handleRefreshFeed, request('POST', `/api/mobile/calendar/ics/${feedId}/refresh`, undefined, uid), feedId, h.deps);
  // Manual refreshes are rate limited; the tests that are not about that step past it.
  h.clock.now = new Date(h.clock.now.getTime() + MANUAL_REFRESH_COOLDOWN_MS);
  return { status: response.status, ...(await json(response)) };
}

async function decide(h: Harness, feedId: string, itemKey: string, action: string, uid = USER) {
  const response = await call(handleDeadlineDecision, 
    request('POST', `/api/mobile/calendar/ics/${feedId}/deadlines/${itemKey}`, { action }, uid), feedId, itemKey, h.deps);
  return { status: response.status, body: await json(response) };
}

function byTitle(rows: IcsFeedItemDocument[], title: string): IcsFeedItemDocument {
  const row = rows.find((candidate) => candidate.title === title);
  assert.ok(row, `no item titled ${title}`);
  return row;
}

/** Everything under the user's tree plus the user document, as one string. */
async function dumpUserTree(uid = USER): Promise<string> {
  const parts: unknown[] = [await getStorage().get(userDoc(uid))];
  for (const collection of USER_SCOPED_COLLECTIONS) {
    parts.push(await getStorage().list(userCol(uid, collection)));
  }
  return JSON.stringify(parts);
}

/* ── Subscribe ─────────────────────────────────────────────────────── */

test('a Moodle export subscribes with a preview of its counts, and lectures become busy time, never commitments', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, MOODLE);
    const { status, body } = await subscribe(h, { label: 'CS101 Moodle' });
    assert.equal(status, 201);
    assert.deepEqual(body.preview, { deadlines: 4, busyBlocks: 4, skipped: 6 });
    assert.equal(body.feed.label, 'CS101 Moodle');
    assert.equal(body.feed.autoAcceptDeadlines, false);
    assert.equal(body.feed.pendingDeadlines, 4);

    const feedId = body.feed.feedId as string;
    const busy = await icsBusyBlocks(USER, feedId, { now: () => NOW });
    assert.equal(busy.length, 4);
    assert.ok(busy.every((block) => block.sourceKind === 'ics' && block.sourceId === `ics:${feedId}`));
    assert.equal((await items()).filter((item) => item.state === 'pending').length, 4);
    assert.deepEqual(await commitments(), [], 'a subscription made a commitment nobody accepted');
  });
});

test('Firestore holds the URL only encrypted, bound to this feed; no response and no log line contains it', async () => {
  consoleLines.length = 0;
  responseTexts.length = 0;
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, MOODLE);
    const { body } = await subscribe(h);
    const feedId = body.feed.feedId as string;
    const [feed] = await feeds();

    assert.equal(await decryptField(USER, fieldPurpose('ics-url', feedId), feed!.encryptedUrl, h.deps.encryption), FEED_URL);
    await assert.rejects(decryptField(USER, fieldPurpose('ics-url', '00000000-0000-4000-8000-000000000000'), feed!.encryptedUrl, h.deps.encryption));

    // Every flow that touches the URL: list, refresh (ok, failing, 304-less), rename, decide, the sweep, delete.
    await json(await call(handleListFeeds, request('GET', '/api/mobile/calendar/ics'), h.deps));
    await refresh(h, feedId);
    h.failNext = new SafeFetchError('timeout');
    await refresh(h, feedId);
    await json(await call(handleUpdateFeed, request('PATCH', `/api/mobile/calendar/ics/${feedId}`, { label: 'x' }), feedId, h.deps));
    const [first] = await items();
    await decide(h, feedId, first!.itemKey, 'accept');
    h.clock.now = new Date(h.clock.now.getTime() + REFRESH_INTERVAL_MS + HOUR);
    await json(await handleIcsRefreshTick(schedulerRequest('Bearer t'), { ...h.deps, env: { ...h.deps.env, ...SCHEDULER_ENV }, verify: async () => SCHEDULER }));
    // A subscribe that fails, too: the error path is where URLs leak.
    h.bodies.set('https://moodle.univ.example/other?authtoken=' + SECRET, '<html>');
    await json(await call(handleCreateFeed, request('POST', '/api/mobile/calendar/ics', { url: 'https://moodle.univ.example/other?authtoken=' + SECRET }), h.deps));

    const tree = await dumpUserTree();
    await json(await call(handleDeleteFeed, request('DELETE', `/api/mobile/calendar/ics/${feedId}`), feedId, h.deps));

    for (const [where, text] of [
      ['storage', tree],
      ['responses', responseTexts.join('\n')],
      ['service log', h.logs.join('\n')],
      ['console', consoleLines.join('\n')],
    ] as const) {
      assert.ok(!text.includes(SECRET), `${where} contains the feed token`);
      assert.ok(!text.includes('export_execute'), `${where} contains the feed path`);
      assert.ok(!text.includes(HOST), `${where} contains the feed host`);
    }
    assert.ok(h.logs.length >= 5, 'the flows above were expected to log');
    assert.ok(h.logs.some((line) => line.includes(`feed=${feedId}`)));
  });
});

test('a URL the guard refuses is a 400 with a reason, and nothing is stored or fetched', async () => {
  await withWorld(async (h) => {
    for (const [url, detail] of [
      ['http://moodle.univ.example/cal.ics', 'blocked_scheme'],
      ['https://169.254.169.254/computeMetadata/v1/', 'blocked_address'],
      ['https://10.0.0.5/cal.ics', 'blocked_address'],
      ['https://metadata.google.internal/', 'blocked_host'],
      ['https://moodle.univ.example:8443/cal.ics', 'blocked_port'],
      ['not a url', 'invalid_url'],
    ]) {
      const response = await call(handleCreateFeed, request('POST', '/api/mobile/calendar/ics', { url }), h.deps);
      assert.equal(response.status, 400, url);
      assert.deepEqual(await response.json(), { success: false, error: 'invalid_url', reason: 'invalid_url', detail });
    }
    assert.equal(h.fetches.length, 0);
    assert.deepEqual(await feeds(), []);
  });
});

test('a page that is not a calendar, a failed fetch, an unknown key and missing KMS each refuse without storing', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, '<html>login</html>');
    assert.equal((await subscribe(h)).body.error, 'not_a_calendar');
    h.bodies.delete(FEED_URL);
    const failed = await subscribe(h);
    assert.deepEqual([failed.status, failed.body.error, failed.body.detail], [422, 'fetch_failed', 'http_status']);
    h.bodies.set(FEED_URL, MOODLE);
    assert.equal((await subscribe(h, { title: 'x' })).status, 400);
    assert.equal((await subscribe(h, { autoAcceptDeadlines: 'yes' })).status, 400);

    const noKms = await call(handleCreateFeed, request('POST', '/api/mobile/calendar/ics', { url: FEED_URL }), { ...h.deps, encryption: { env: {} as NodeJS.ProcessEnv } });
    assert.equal(noKms.status, 503);
    assert.equal((await noKms.json()).error, 'encryption_unavailable');
    assert.deepEqual(await feeds(), []);
    assert.deepEqual(await items(), []);
  });
});

test('at most five feeds; the flag, the token and the calendar consent are each checked', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, calendar([]));
    for (let i = 0; i < MAX_FEEDS_PER_USER; i += 1) assert.equal((await subscribe(h)).status, 201);
    const sixth = await subscribe(h);
    assert.deepEqual([sixth.status, sixth.body.error], [409, 'too_many_feeds']);

    const off = await call(handleCreateFeed, request('POST', '/api/mobile/calendar/ics', { url: FEED_URL }), { ...h.deps, env: {} as NodeJS.ProcessEnv });
    assert.equal(off.status, 404);
    const offByDefault = await realCreateRoute(request('POST', '/api/mobile/calendar/ics', { url: FEED_URL }));
    assert.equal(offByDefault.status, 404, 'the route is on without ICS_FEEDS_ENABLED=true');
    // Through the real route file: authentication is lexically there, before anything else.
    const anonymous = await realCreateRoute(request('POST', '/api/mobile/calendar/ics', { url: FEED_URL }, null));
    assert.equal(anonymous.status, 401);
    const noConsent = await subscribe(h, {}, OTHER);
    assert.deepEqual([noConsent.status, noConsent.body.error], [403, 'calendar_consent_required']);
  });
});

test('another account cannot see, refresh, change, decide on or delete my feed', async () => {
  await withWorld(async (h) => {
    await withConsent(OTHER);
    h.bodies.set(FEED_URL, calendar([{ uid: 'a', title: 'Essay due', dueInHours: 48 }]));
    const feedId = (await subscribe(h)).body.feed.feedId as string;
    const [item] = await items();

    const list = await json(await call(handleListFeeds, request('GET', '/api/mobile/calendar/ics', undefined, OTHER), h.deps));
    assert.deepEqual([list.feeds, list.deadlines], [[], []]);
    assert.equal((await refresh(h, feedId, OTHER)).status, 404);
    assert.equal((await call(handleUpdateFeed, request('PATCH', `/x/${feedId}`, { label: 'mine' }, OTHER), feedId, h.deps)).status, 404);
    assert.equal((await decide(h, feedId, item!.itemKey, 'accept', OTHER)).status, 404);
    assert.equal((await call(handleDeleteFeed, request('DELETE', `/x/${feedId}`, undefined, OTHER), feedId, h.deps)).status, 404);
    assert.equal((await feeds()).length, 1);
    assert.deepEqual(await commitments(OTHER), []);
    assert.deepEqual(await commitments(USER), []);
  });
});

/* ── Refresh and dedupe ────────────────────────────────────────────── */

test('refreshing twice creates no duplicate proposals, and a SEQUENCE bump moves the pending one in place', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, calendar([
      { uid: 'essay', title: 'Essay due', dueInHours: 48 },
      { uid: 'lab', title: 'Lab due', dueInHours: 72 },
    ], [{ uid: 'lec', startInHours: 5, hours: 2 }]));
    const feedId = (await subscribe(h)).body.feed.feedId as string;
    const before = await items();

    await refresh(h, feedId);
    await refresh(h, feedId);
    const after = await items();
    assert.equal(after.length, 2);
    assert.deepEqual(after.map((i) => i.itemKey).sort(), before.map((i) => i.itemKey).sort());
    assert.equal((await icsBusyBlocks(USER, feedId, { now: () => NOW })).length, 1, 'busy blocks duplicated');

    h.bodies.set(FEED_URL, calendar([
      { uid: 'essay', title: 'Essay due', dueInHours: 60, sequence: 1, stamp: '20260920T080000Z' },
      { uid: 'lab', title: 'Lab due', dueInHours: 72 },
    ], [{ uid: 'lec', startInHours: 5, hours: 2 }]));
    await refresh(h, feedId);
    const moved = byTitle(await items(), 'Essay due');
    assert.equal(moved.itemKey, byTitle(before, 'Essay due').itemKey);
    assert.equal(moved.state, 'pending');
    assert.equal(moved.dueAt, new Date(NOW.getTime() + 60 * HOUR).toISOString());
    assert.equal(moved.sequence, 1);
    assert.equal((await items()).length, 2);

    // A stale copy with a lower SEQUENCE does not move it back.
    h.bodies.set(FEED_URL, calendar([
      { uid: 'essay', title: 'Essay due', dueInHours: 48, sequence: 0 },
      { uid: 'lab', title: 'Lab due', dueInHours: 72 },
    ]));
    await refresh(h, feedId);
    assert.equal(byTitle(await items(), 'Essay due').dueAt, moved.dueAt);
  });
});

test('a conditional fetch sends the ETag only while the last full fetch is fresh', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, calendar([]));
    const feedId = (await subscribe(h)).body.feed.feedId as string;
    await refresh(h, feedId);
    assert.equal(h.fetches.at(-1)!.options.etag, '"e1"');
    h.clock.now = new Date(h.clock.now.getTime() + 2 * DAY);
    await refresh(h, feedId);
    assert.equal(h.fetches.at(-1)!.options.etag, undefined);
  });
});

test('a pending deadline that leaves the feed is withdrawn; an accepted one gets a notice and its commitment stays', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, calendar([
      { uid: 'essay', title: 'Essay due', dueInHours: 48 },
      { uid: 'lab', title: 'Lab due', dueInHours: 72 },
    ]));
    const feedId = (await subscribe(h)).body.feed.feedId as string;
    const lab = byTitle(await items(), 'Lab due');
    assert.equal((await decide(h, feedId, lab.itemKey, 'accept')).status, 200);

    h.bodies.set(FEED_URL, calendar([]));
    await refresh(h, feedId);
    assert.equal(byTitle(await items(), 'Essay due').state, 'withdrawn');
    const removed = byTitle(await items(), 'Lab due');
    assert.deepEqual([removed.state, removed.notice], ['accepted', 'removed']);
    assert.equal((await commitments()).length, 1, 'a removal from the source deleted the user\'s commitment');

    // And back: withdrawn is proposed again, and the notice clears.
    h.bodies.set(FEED_URL, calendar([
      { uid: 'essay', title: 'Essay due', dueInHours: 48 },
      { uid: 'lab', title: 'Lab due', dueInHours: 72 },
    ]));
    await refresh(h, feedId);
    assert.equal(byTitle(await items(), 'Essay due').state, 'pending');
    assert.equal(byTitle(await items(), 'Lab due').notice, null);
  });
});

test('a past-due deadline that aged out of the window is neither withdrawn nor noticed', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, calendar([{ uid: 'soon', title: 'Quiz due', dueInHours: 2 }]));
    const feedId = (await subscribe(h)).body.feed.feedId as string;
    const quiz = byTitle(await items(), 'Quiz due');
    await decide(h, feedId, quiz.itemKey, 'accept');
    h.clock.now = new Date(NOW.getTime() + 3 * HOUR);
    h.bodies.set(FEED_URL, calendar([{ uid: 'soon', title: 'Quiz due', dueInHours: 2 }]));
    await refresh(h, feedId);
    assert.equal(byTitle(await items(), 'Quiz due').notice, null);
  });
});

/* ── Deciding ──────────────────────────────────────────────────────── */

test('auto-accept off: nothing is a commitment until accepted, an accept is idempotent, and a dismissal comes back once if the deadline moves', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, calendar([
      { uid: 'essay', title: 'Essay due', dueInHours: 48 },
      { uid: 'lab', title: 'Lab due', dueInHours: 72 },
    ]));
    const feedId = (await subscribe(h)).body.feed.feedId as string;
    await refresh(h, feedId);
    assert.deepEqual(await commitments(), []);

    const essay = byTitle(await items(), 'Essay due');
    const first = await decide(h, feedId, essay.itemKey, 'accept');
    assert.equal(first.status, 200);
    assert.equal(first.body.replayed, false);
    const second = await decide(h, feedId, essay.itemKey, 'accept');
    assert.equal(second.body.replayed, true);
    const made = await commitments();
    assert.equal(made.length, 1);
    assert.equal(made[0]!.title, 'Essay due');
    assert.equal(made[0]!.timeSpec.dueAt, new Date(NOW.getTime() + 48 * HOUR).toISOString());
    assert.equal(made[0]!.status, 'active');
    assert.equal(first.body.deadline.commitmentId, made[0]!.id);

    const lab = byTitle(await items(), 'Lab due');
    assert.equal((await decide(h, feedId, lab.itemKey, 'dismiss')).status, 200);
    assert.equal((await decide(h, feedId, lab.itemKey, 'accept')).status, 409);
    await refresh(h, feedId);
    assert.equal(byTitle(await items(), 'Lab due').state, 'rejected', 'an unchanged dismissal came back');

    const labMoved = (hours: number) => calendar([
      { uid: 'essay', title: 'Essay due', dueInHours: 48 },
      { uid: 'lab', title: 'Lab due', dueInHours: hours, sequence: hours },
    ]);
    h.bodies.set(FEED_URL, labMoved(80));
    await refresh(h, feedId);
    assert.equal(byTitle(await items(), 'Lab due').state, 'pending');
    await decide(h, feedId, lab.itemKey, 'dismiss');
    h.bodies.set(FEED_URL, labMoved(90));
    await refresh(h, feedId);
    assert.equal(byTitle(await items(), 'Lab due').state, 'rejected', 'a dismissal came back twice');
    assert.equal((await commitments()).length, 1);
  });
});

test('an accepted deadline the feed moves is not moved until the user applies it', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 48 }]));
    const feedId = (await subscribe(h)).body.feed.feedId as string;
    const essay = byTitle(await items(), 'Essay due');
    await decide(h, feedId, essay.itemKey, 'accept');

    h.bodies.set(FEED_URL, calendar([{ uid: 'essay', title: 'Essay due', dueInHours: 96, sequence: 1 }]));
    await refresh(h, feedId);
    const noticed = byTitle(await items(), 'Essay due');
    assert.deepEqual([noticed.notice, noticed.proposedDueAt], ['moved', new Date(NOW.getTime() + 96 * HOUR).toISOString()]);
    assert.equal((await commitments())[0]!.timeSpec.dueAt, new Date(NOW.getTime() + 48 * HOUR).toISOString());

    const listed = await json(await call(handleListFeeds, request('GET', '/api/mobile/calendar/ics'), h.deps));
    assert.equal(listed.deadlines[0].notice, 'moved');

    assert.equal((await decide(h, feedId, essay.itemKey, 'apply_move')).status, 200);
    assert.equal((await commitments())[0]!.timeSpec.dueAt, new Date(NOW.getTime() + 96 * HOUR).toISOString());
    assert.equal(byTitle(await items(), 'Essay due').notice, null);
    await refresh(h, feedId);
    assert.equal(byTitle(await items(), 'Essay due').notice, null, 'an applied move was noticed again');
  });
});

test('a deadline already past cannot be accepted', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, calendar([{ uid: 'q', title: 'Quiz due', dueInHours: 1 }]));
    const feedId = (await subscribe(h)).body.feed.feedId as string;
    const quiz = byTitle(await items(), 'Quiz due');
    h.clock.now = new Date(NOW.getTime() + 2 * HOUR);
    const refused = await decide(h, feedId, quiz.itemKey, 'accept');
    assert.deepEqual([refused.status, refused.body.error], [409, 'past_due']);
    assert.deepEqual(await commitments(), []);
    assert.equal((await decide(h, feedId, quiz.itemKey, 'teleport')).status, 400);
  });
});

test('auto-accept on: each deadline becomes a commitment with an Activity entry, and Undo drops it for good', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, calendar([
      { uid: 'essay', title: 'Essay due', dueInHours: 48 },
      { uid: 'lab', title: 'Lab due', dueInHours: 72 },
    ], [{ uid: 'lec', startInHours: 5, hours: 2 }]));
    const feedId = (await subscribe(h, { autoAcceptDeadlines: true })).body.feed.feedId as string;

    const made = await commitments();
    assert.deepEqual(made.map((c) => c.title).sort(), ['Essay due', 'Lab due'], 'a lecture became a commitment, or a deadline did not');
    assert.ok(made.every((c) => c.status === 'active'));
    const activity = await listActivity({ uid: USER });
    for (const commitment of made) {
      assert.ok(activity.items.some((entry) => entry.commitmentId === commitment.id), `no activity for ${commitment.title}`);
    }

    const listed = await json(await call(handleListFeeds, request('GET', '/api/mobile/calendar/ics'), h.deps));
    assert.equal(listed.deadlines.filter((d: any) => d.autoAccepted).length, 2, 'undo is not reachable from the list');

    await refresh(h, feedId);
    assert.equal((await commitments()).length, 2, 'a refresh auto-accepted twice');

    const essay = byTitle(await items(), 'Essay due');
    const undo = await decide(h, feedId, essay.itemKey, 'undo');
    assert.equal(undo.status, 200);
    const dropped = (await commitments()).find((c) => c.id === essay.commitmentId);
    assert.equal(dropped?.status, 'dropped');
    assert.equal(byTitle(await items(), 'Essay due').state, 'rejected');
    await refresh(h, feedId);
    assert.equal((await commitments()).filter((c) => c.status === 'active').length, 1, 'an undone deadline was re-accepted');

    // Undo is only for what the feed accepted on the user's behalf.
    await json(await call(handleUpdateFeed, request('PATCH', `/x/${feedId}`, { autoAcceptDeadlines: false }), feedId, h.deps));
    h.bodies.set(FEED_URL, calendar([{ uid: 'new', title: 'Report due', dueInHours: 100 }]));
    await refresh(h, feedId);
    const report = byTitle(await items(), 'Report due');
    assert.equal(report.state, 'pending', 'turning auto-accept off did not stop it');
    await decide(h, feedId, report.itemKey, 'accept');
    assert.equal((await decide(h, feedId, report.itemKey, 'undo')).status, 409);
  });
});

/* ── Failures ──────────────────────────────────────────────────────── */

test('failures back off, turn the feed to error after five, and a manual refresh is limited to one per five minutes', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, calendar([]));
    const feedId = (await subscribe(h)).body.feed.feedId as string;
    const intervals: number[] = [];
    for (let i = 1; i <= FAILURES_BEFORE_ERROR; i += 1) {
      h.failNext = new SafeFetchError('timeout');
      const result = await refresh(h, feedId);
      assert.equal(result.outcome, 'failed');
      const [feed] = await feeds();
      intervals.push(Date.parse(feed!.nextFetchAt) - Date.parse(feed!.lastManualRefreshAt!));
      assert.equal(feed!.status, i >= FAILURES_BEFORE_ERROR ? 'error' : 'ok');
      assert.equal(feed!.lastErrorCode, 'timeout');
    }
    assert.deepEqual(intervals.map((ms) => ms / HOUR), [6, 12, 24, 48, 48]);
    const [broken] = await feeds();
    assert.ok(broken!.encryptedUrl, 'a failing feed lost its URL');

    const ok = await refresh(h, feedId);
    assert.equal(ok.outcome, 'updated');
    assert.deepEqual([(await feeds())[0]!.status, (await feeds())[0]!.consecutiveFailures], ['ok', 0]);

    const first = await call(handleRefreshFeed, request('POST', `/r/${feedId}`), feedId, h.deps);
    assert.equal(first.status, 200);
    const tooSoon = await call(handleRefreshFeed, request('POST', `/r/${feedId}`), feedId, h.deps);
    assert.equal(tooSoon.status, 429);
  });
});

test('a KMS outage defers the refresh without counting a failure; a blob that fails to decrypt counts, and is never cleared', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, calendar([]));
    const feedId = (await subscribe(h)).body.feed.feedId as string;
    const [original] = await feeds();

    const outage = await call(handleRefreshFeed, request('POST', `/r/${feedId}`), feedId, {
      ...h.deps,
      encryption: {
        env: h.deps.encryption!.env,
        kms: { encrypt: h.kms.encrypt.bind(h.kms), decrypt: async () => { throw new FieldEncryptionError('kms_unavailable', 'unreachable'); } } as never,
      },
    });
    const deferred = await json(outage);
    assert.equal(deferred.outcome, 'kms_retry');
    assert.equal((await feeds())[0]!.consecutiveFailures, 0);
    assert.deepEqual((await feeds())[0]!.encryptedUrl, original!.encryptedUrl);
    assert.equal(h.fetches.length, 1, 'fetched without a URL');

    h.clock.now = new Date(h.clock.now.getTime() + MANUAL_REFRESH_COOLDOWN_MS);
    await getStorage().set(userSubDoc(USER, ICS_FEEDS, feedId), {
      ...(await feeds())[0]!,
      encryptedUrl: { ...original!.encryptedUrl, ciphertext: Buffer.from('tampered').toString('base64') },
    });
    const tampered = await refresh(h, feedId);
    assert.equal(tampered.outcome, 'failed');
    const [after] = await feeds();
    assert.equal(after!.consecutiveFailures, 1);
    assert.equal(after!.lastErrorCode, 'decrypt_failed');
    assert.ok(after!.encryptedUrl, 'the stored blob was cleared');
  });
});

/* ── Unsubscribe ───────────────────────────────────────────────────── */

test('unsubscribing deletes the URL, the busy blocks and the proposals, and keeps the commitments the user accepted', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, calendar([
      { uid: 'essay', title: 'Essay due', dueInHours: 48 },
      { uid: 'lab', title: 'Lab due', dueInHours: 72 },
    ], [{ uid: 'lec', startInHours: 5, hours: 2 }, { uid: 'lec2', startInHours: 29, hours: 2 }]));
    const feedId = (await subscribe(h)).body.feed.feedId as string;
    const essay = byTitle(await items(), 'Essay due');
    await decide(h, feedId, essay.itemKey, 'accept');
    assert.ok((await getStorage().get<Record<string, unknown>>(userDoc(USER)))?.icsNextFetchAt);

    const response = await call(handleDeleteFeed, request('DELETE', `/x/${feedId}`), feedId, h.deps);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, busyBlocks: 2, proposals: 1 });

    assert.deepEqual(await feeds(), []);
    assert.deepEqual(await items(), []);
    assert.deepEqual(await getStorage().list(userCol(USER, BUSY_BLOCKS)), []);
    assert.deepEqual(await getStorage().list(userCol(USER, CALENDAR_SOURCES)), []);
    const kept = await commitments();
    assert.deepEqual(kept.map((c) => [c.title, c.status]), [['Essay due', 'active']]);
    assert.equal((await getStorage().get<Record<string, unknown>>(userDoc(USER)))?.icsNextFetchAt, undefined,
      'an account with no feeds is still in the refresh index');
  });
});

test('unsubscribing works without calendar consent, and only removes that feed', async () => {
  await withWorld(async (h) => {
    h.bodies.set(FEED_URL, calendar([{ uid: 'a', title: 'A due', dueInHours: 10 }], [{ uid: 'l', startInHours: 3, hours: 1 }]));
    const keep = (await subscribe(h)).body.feed.feedId as string;
    const drop = (await subscribe(h)).body.feed.feedId as string;
    await applyTrustAction(USER, { type: 'set_calendar_consent', granted: false, at: NOW.toISOString() });
    assert.equal((await call(handleDeleteFeed, request('DELETE', `/x/${drop}`), drop, h.deps)).status, 200);
    assert.deepEqual((await feeds()).map((f) => f.feedId), [keep]);
    assert.equal((await items()).length, 1);
    assert.equal((await icsBusyBlocks(USER, keep, { now: () => NOW })).length, 1);
  });
});

/* ── The scheduled sweep ───────────────────────────────────────────── */

const SA = 'maybesitter-scheduler@example-project.iam.gserviceaccount.com';
const AUDIENCE = 'https://api.example.invalid';
const SCHEDULER_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test', [SCHEDULER_SA_ENV_VAR]: SA, [AUDIENCE_ENV_VAR]: AUDIENCE };
const SCHEDULER: OidcPayload = { email: SA, email_verified: true, aud: AUDIENCE, iss: 'https://accounts.google.com' };

function schedulerRequest(token: string | null) {
  return { headers: { get: (name: string) => (name.toLowerCase() === 'authorization' ? token : null) } };
}

const REFUSED: Array<[string, string | null, OidcPayload | 'throws']> = [
  ['no token', null, SCHEDULER],
  ['a Firebase user ID token', 'Bearer user-token', { email: 'someone@example.com', email_verified: true, aud: 'example-project', iss: 'https://securetoken.google.com/example-project' }],
  ['a different service account', 'Bearer t', { ...SCHEDULER, email: 'other@other-project.iam.gserviceaccount.com' }],
  ['a token for the wrong audience', 'Bearer t', { ...SCHEDULER, aud: 'https://staging.example.invalid' }],
  ['a token Google does not verify', 'Bearer t', 'throws'],
];

for (const [label, header, payload] of REFUSED) {
  test(`ics refresh endpoint: ${label} is refused with 401 and refreshes nothing`, async () => {
    let swept = false;
    const saved = console.warn;
    console.warn = () => undefined;
    try {
      const response = await handleIcsRefreshTick(schedulerRequest(header), {
        env: { ...SCHEDULER_ENV, ICS_FEEDS_ENABLED: 'true' },
        verify: async () => {
          if (payload === 'throws') throw new Error('bad signature');
          return payload;
        },
        tick: async () => {
          swept = true;
          return { accounts: 0, due: 0, updated: 0, notModified: 0, failed: 0, deferred: 0 };
        },
      });
      assert.equal(response.status, 401);
      assert.equal(swept, false);
    } finally {
      console.warn = saved;
    }
  });
}

test('the sweep refreshes exactly the feeds that are due, across accounts', async () => {
  await withWorld(async (h) => {
    await withConsent(OTHER);
    h.bodies.set(FEED_URL, calendar([{ uid: 'a', title: 'A due', dueInHours: 200 }]));
    const mine = (await subscribe(h)).body.feed.feedId as string;
    h.clock.now = new Date(NOW.getTime() + 3 * HOUR);
    const theirs = (await subscribe(h, {}, OTHER)).body.feed.feedId as string;
    const fetchesBefore = h.fetches.length;

    // Six and a half hours after the first subscribe: mine is due, theirs is not.
    h.clock.now = new Date(NOW.getTime() + REFRESH_INTERVAL_MS + 30 * 60_000);
    const response = await handleIcsRefreshTick(schedulerRequest('Bearer t'), {
      ...h.deps, env: { ...h.deps.env, ...SCHEDULER_ENV }, verify: async () => SCHEDULER,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accounts: 1, due: 1, updated: 1, notModified: 0, failed: 0, deferred: 0 });
    assert.equal(h.fetches.length, fetchesBefore + 1);
    assert.equal((await feeds(USER))[0]!.lastFetchedAt, h.clock.now.toISOString());
    assert.notEqual((await feeds(OTHER))[0]!.lastFetchedAt, h.clock.now.toISOString());
    assert.ok(mine && theirs);

    const disabled = await handleIcsRefreshTick(schedulerRequest('Bearer t'), {
      ...h.deps, env: { ...SCHEDULER_ENV }, verify: async () => SCHEDULER,
    });
    assert.deepEqual(await disabled.json(), { skipped: 'feature_disabled' });
  });
});
