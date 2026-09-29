/**
 * «تابعلي هذا الإشي» for a football club, end to end (closure CL7).
 *
 * The chain the council ruled on: source picker → team → follow → the poll
 * (riding the per-minute watcher cron) fetches the club → its matches become
 * commitments that block time in the plan → a kickoff that moves reaches the
 * watcher as a real firing → a provider that errors shows "retrying", never
 * silence → "Stop following" removes the watcher and the matches still ahead.
 *
 * The provider is the real `createFootballDataProvider` — its normalisation,
 * status map and error handling all run — fed the recorded vendor-shaped
 * payload in `payloads/barcelona-matches.json` through an injected `fetch`, so
 * no test here reaches football-data.org. Kickoffs are placed relative to the
 * wall clock the routes read, so nothing here is a date bomb.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { footballClubSyncStateDoc, userCol, PLANNING_STATE_CHANGES } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { GET as listWatchers, POST as createWatcher } from '../../src/app/api/mobile/watchers/route.ts';
import { DELETE as deleteWatcher, PATCH as patchWatcher } from '../../src/app/api/mobile/watchers/[id]/route.ts';
import { GET as getFootball, PUT as putFootball } from '../../src/app/api/mobile/football/route.ts';
import { GET as getBackgroundActivity } from '../../src/app/api/mobile/trust/background-activity/route.ts';
import { GET as getBackgroundHistory } from '../../src/app/api/mobile/trust/background-activity/history/route.ts';
import { createFootballDataProvider } from '../../lib/football/footballDataProvider.ts';
import { getFollowedClubs, setFollowedClubs } from '../../lib/football/followedClubs.ts';
import { setUserLocale } from '../../lib/storage/userLocale.ts';
import { AUDIENCE_ENV_VAR, SCHEDULER_SA_ENV_VAR, type OidcPayload } from '../../lib/auth/schedulerOidc.ts';
import { listActiveFixtureCommitments } from '../../lib/football/projectFixtures.ts';
import { FOOTBALL_POLL_INTERVAL_MS, FOOTBALL_RETRY_AFTER_MS } from '../../lib/football/syncFixtures.ts';
import { handleWatcherSweepRequest, runFootballPollJob, runWatcherTick } from '../../lib/jobs/internalJobs.ts';
import { runWatcherSweep } from '../../lib/watchers/watcherEngine.ts';
import { readParticipantState } from '../../lib/services/mobile/participantState.ts';
import { buildDailyPlanInput } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import type { ClubSyncState, FixtureProvider } from '../../src/contracts/v1/fixtureContracts.ts';
import type { UserRoutineProfile } from '../../src/contracts/v1/routineContracts.ts';

const BASE = 'https://api.maybesitter.test';
const ALICE = uidFor('FootballWatcherAlice');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ── The recorded payload, re-dated ───────────────────────────────── */

interface VendorMatch { id: number; utcDate: string; status: string; [key: string]: unknown }
const RECORDED = JSON.parse(
  readFileSync(new URL('./payloads/barcelona-matches.json', import.meta.url), 'utf8'),
) as { matches: VendorMatch[] };
/** The recorded SCHEDULED Barcelona–Real Madrid row, the template for every match below. */
const TEMPLATE = RECORDED.matches.find((match) => match.id === 419471)!;

/** The whole hour two days from the real now: the routes read the wall clock. */
const T0 = Math.ceil((Date.now() + 2 * DAY) / HOUR) * HOUR - 2 * DAY;
const at = (ms: number) => new Date(ms);
const iso = (ms: number) => new Date(ms).toISOString();
const KICKOFF_1 = T0 + 2 * DAY + 17 * HOUR;
const KICKOFF_2 = T0 + 9 * DAY + 17 * HOUR;

function vendorBody(kickoff1: number): string {
  return JSON.stringify({
    ...RECORDED,
    matches: [
      { ...TEMPLATE, id: 900001, utcDate: iso(kickoff1).replace('.000Z', 'Z') },
      { ...TEMPLATE, id: 900002, utcDate: iso(KICKOFF_2).replace('.000Z', 'Z') },
    ],
  });
}

/** What the fake vendor answers next: a body, or a status it fails with. */
let answer: { status: 200; body: string } | { status: 429 | 503 } = { status: 200, body: vendorBody(KICKOFF_1) };
let requests = 0;
const fetchImpl = (async () => {
  requests += 1;
  if (answer.status !== 200) {
    return new Response('{}', { status: answer.status, statusText: answer.status === 429 ? 'Too Many Requests' : 'Unavailable' });
  }
  return new Response(answer.body, { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const provider: FixtureProvider = createFootballDataProvider({ apiKey: 'test-key', fetchImpl });

/* ── Harness ──────────────────────────────────────────────────────── */

let auth: FakeAuthControls | null = null;
let previousKey: string | undefined;

function begin(key: string | null): void {
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  previousKey = process.env.FOOTBALL_DATA_API_KEY;
  if (key === null) delete process.env.FOOTBALL_DATA_API_KEY;
  else process.env.FOOTBALL_DATA_API_KEY = key;
  answer = { status: 200, body: vendorBody(KICKOFF_1) };
  requests = 0;
}

function end(): void {
  auth?.restore();
  auth = null;
  resetStorageForTests();
  if (previousKey === undefined) delete process.env.FOOTBALL_DATA_API_KEY;
  else process.env.FOOTBALL_DATA_API_KEY = previousKey;
}

function request(path: string, options: { method?: string; body?: unknown } = {}): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(ALICE)}` });
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** The exact body the watcher builder sends for "follow Barcelona". */
function followBody(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    label: 'برشلونة',
    source: { provider: 'football_data', connectionId: null, signalKind: 'football_team', subjectRef: 'barcelona' },
    condition: { kind: 'digest_changed' },
    effect: 'replan_if_impacted',
    createdBy: 'user',
    ...overrides,
  };
}

async function tick(nowMs: number) {
  return runWatcherTick({
    football: () => runFootballPollJob({ provider, now: at(nowMs) }),
    sweep: () => runWatcherSweep({ now: at(nowMs) }),
  });
}

interface Monitor { watcherId: string; status: string; lastChangedAt: string | null; nextCheckAt: string | null; effects: string[] }
async function monitors(): Promise<Monitor[]> {
  const body = await (await getBackgroundActivity(request('/api/mobile/trust/background-activity'))).json() as { monitors: Monitor[] };
  return body.monitors;
}

async function historyStatuses(watcherId: string): Promise<string[]> {
  const body = await (await getBackgroundHistory(request('/api/mobile/trust/background-activity/history'))).json() as {
    items: Array<{ watcherId: string; status: string }>;
  };
  return body.items.filter((item) => item.watcherId === watcherId).map((item) => item.status);
}

async function footballWatcherLabels(): Promise<Array<[string, string | null]>> {
  const body = await (await listWatchers(request('/api/mobile/watchers'))).json() as {
    items: Array<{ label: string | null; source: { subjectRef: string } }>;
  };
  return body.items.map((item) => [item.source.subjectRef, item.label]);
}

async function syncState(): Promise<ClubSyncState | null> {
  return getStorage().get<ClubSyncState>(footballClubSyncStateDoc('barcelona'));
}

/* ── Without the key, there is no football source ────────────────── */

test('without the provider key the source is reported off and a follow is refused, writing nothing', async () => {
  begin(null);
  try {
    const football = await (await getFootball(request('/api/mobile/football'))).json() as { providerConfigured: boolean };
    assert.equal(football.providerConfigured, false);

    const refused = await createWatcher(request('/api/mobile/watchers', { body: followBody() }));
    assert.equal(refused.status, 409);
    assert.equal((await refused.json() as { reason: string }).reason, 'provider_not_configured');
    assert.deepEqual(await getFollowedClubs(ALICE), []);
    assert.deepEqual((await (await listWatchers(request('/api/mobile/watchers'))).json() as { items: unknown[] }).items, []);

    // And the poll is off: it never asks the provider.
    assert.deepEqual(await runFootballPollJob({ env: {}, now: at(T0) }), { enabled: false });
  } finally {
    end();
  }
});

test('a whitespace-only key is not a key', async () => {
  begin('   ');
  try {
    const football = await (await getFootball(request('/api/mobile/football'))).json() as { providerConfigured: boolean };
    assert.equal(football.providerConfigured, false);
  } finally {
    end();
  }
});

/* ── The whole chain ─────────────────────────────────────────────── */

test('follow → poll → matches block the plan → a moved kickoff fires → provider error says retrying → stop following', async () => {
  begin('test-key');
  try {
    const football = await (await getFootball(request('/api/mobile/football'))).json() as { providerConfigured: boolean };
    assert.equal(football.providerConfigured, true);

    // Follow, from the builder. A second tap is the same follow.
    const created = await createWatcher(request('/api/mobile/watchers', { body: followBody() }));
    assert.equal(created.status, 201, await created.clone().text());
    const watcherId = (await created.json() as { watcher: { watcherId: string } }).watcher.watcherId;
    const again = await createWatcher(request('/api/mobile/watchers', { body: followBody() }));
    assert.equal(again.status, 201);
    assert.equal((await again.json() as { watcher: { watcherId: string } }).watcher.watcherId, watcherId);
    assert.deepEqual(await getFollowedClubs(ALICE), ['barcelona']);
    // Nothing is stored for a club nobody followed before; no match yet.
    assert.equal((await listActiveFixtureCommitments(ALICE)).length, 0);

    // The first tick: the poll fetches the due club and projects its followers;
    // the sweep primes the watcher on the club's state without firing.
    const first = await tick(T0);
    assert.equal(first.football.poll?.refreshed.join(), 'barcelona');
    assert.equal(first.fired, 0);
    assert.equal(requests, 1);
    const matches = await listActiveFixtureCommitments(ALICE);
    assert.deepEqual(matches.map((match) => match.kickoffUtc), [iso(KICKOFF_1), iso(KICKOFF_2)]);

    // The match is a two-hour block in that day's plan.
    const state = await readParticipantState(ALICE);
    const commitments = Object.values(state.commitments);
    const matchDate = new Date(KICKOFF_1 + 3 * HOUR).toISOString().slice(0, 10);
    const plan = buildDailyPlanInput({
      uid: ALICE,
      date: matchDate,
      timezone: 'Asia/Jerusalem',
      profile: PROFILE,
      busyBlocks: [],
      commitments,
      builtAt: iso(T0),
    });
    const block = plan.constraints.fixedEvents.find((event) => event.sourceCommitmentId === matches[0]!.commitmentId);
    assert.ok(block, 'the match should block time in its day\'s plan');
    assert.equal(block.blocking, true);
    assert.equal(block.interval.startsAt, iso(KICKOFF_1));
    assert.equal(block.interval.endsAt, iso(KICKOFF_1 + 2 * HOUR));

    // A quiet minute later: nothing is due, nothing is asked, nothing fires.
    const quiet = await tick(T0 + 60_000);
    assert.equal(quiet.football.poll?.attempted, 0);
    assert.equal(quiet.fired, 0);
    assert.equal(requests, 1);

    // The provider moves the first kickoff by two hours. The next due poll
    // moves the commitment and the watcher fires on it in the same tick.
    answer = { status: 200, body: vendorBody(KICKOFF_1 + 2 * HOUR) };
    const moved = await tick(T0 + FOOTBALL_POLL_INTERVAL_MS);
    assert.equal(moved.football.projection?.updated, 1);
    assert.equal(moved.fired, 1);
    assert.equal((await listActiveFixtureCommitments(ALICE))[0]!.kickoffUtc, iso(KICKOFF_1 + 2 * HOUR));
    const changes = await getStorage().list<{ source: string; entityId: string }>(userCol(ALICE, PLANNING_STATE_CHANGES));
    assert.deepEqual(changes.map((row) => [row.data.source, row.data.entityId]), [['watcher', watcherId]]);
    const [afterMove] = await monitors();
    assert.equal(afterMove!.status, 'active');
    assert.ok(afterMove!.lastChangedAt, 'the watcher row should say when it last changed');
    assert.deepEqual(afterMove!.effects, ['replan_if_impacted']);

    // The same data again is not news.
    const unchanged = await tick(T0 + 2 * FOOTBALL_POLL_INTERVAL_MS);
    assert.equal(unchanged.football.poll?.attempted, 1);
    assert.equal(unchanged.fired, 0);

    // The provider runs out of quota: the watcher says so.
    answer = { status: 429 };
    const failing = await tick(T0 + 3 * FOOTBALL_POLL_INTERVAL_MS);
    assert.deepEqual(failing.football.poll?.failures, [{ clubId: 'barcelona', failureKind: 'rate_limited' }]);
    assert.equal((await syncState())?.lastOutcome, 'failed');
    const [retrying] = await monitors();
    assert.equal(retrying!.status, 'retrying');
    // It says when it tries again — the real retry, not "no check yet".
    assert.equal(retrying!.nextCheckAt, iso(T0 + 3 * FOOTBALL_POLL_INTERVAL_MS + FOOTBALL_RETRY_AFTER_MS));
    // And the history tells the same story as the live row.
    const statuses = await historyStatuses(watcherId);
    assert.ok(statuses.length > 0, 'the moved kickoff should be in the history');
    assert.deepEqual(Array.from(new Set(statuses)), ['retrying']);
    // The matches it already knew stay on the calendar through the outage.
    assert.equal((await listActiveFixtureCommitments(ALICE)).length, 2);

    // It retries within minutes, not tomorrow night, and recovers.
    answer = { status: 200, body: vendorBody(KICKOFF_1 + 2 * HOUR) };
    const recovered = await tick(T0 + 3 * FOOTBALL_POLL_INTERVAL_MS + FOOTBALL_RETRY_AFTER_MS);
    assert.equal(recovered.football.poll?.refreshed.join(), 'barcelona');
    assert.equal((await monitors())[0]!.status, 'active');

    // Stop following: the watcher, the follow and the matches ahead all go.
    const stopped = await deleteWatcher(request(`/api/mobile/watchers/${watcherId}`, { method: 'DELETE' }), params(watcherId));
    assert.equal(stopped.status, 200);
    assert.deepEqual(await getFollowedClubs(ALICE), []);
    assert.deepEqual(await listActiveFixtureCommitments(ALICE), []);
    assert.deepEqual(await monitors(), []);
  } finally {
    end();
  }
});

/* ── The cron that makes the poll happen ─────────────────────────── */

const SCHEDULER_SA = 'maybesitter-scheduler@example-project.iam.gserviceaccount.com';
const SCHEDULER_AUDIENCE = 'https://api.example.invalid';
const SCHEDULER_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test', [SCHEDULER_SA_ENV_VAR]: SCHEDULER_SA, [AUDIENCE_ENV_VAR]: SCHEDULER_AUDIENCE,
};
const SCHEDULER: OidcPayload = {
  email: SCHEDULER_SA, email_verified: true, aud: SCHEDULER_AUDIENCE, iss: 'https://accounts.google.com',
};
const schedulerRequest = { headers: { get: (name: string) => (name.toLowerCase() === 'authorization' ? 'Bearer t' : null) } };

test('the per-minute watcher cron runs the football poll through its default wiring', async () => {
  // `/api/internal/jobs/watchers` is the only scheduler entry that polls a
  // followed club. Nothing is injected here but the scheduler's identity and
  // the network: the handler's own default tick, the real provider (reading
  // the key from the environment) and the real sweep all run.
  begin('test-key');
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const created = await createWatcher(request('/api/mobile/watchers', { body: followBody() }));
    assert.equal(created.status, 201);

    const response = await handleWatcherSweepRequest(schedulerRequest, {
      env: SCHEDULER_ENV, verify: async () => SCHEDULER,
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { scanned: number; football?: { enabled: boolean; poll?: { refreshed: string[] } } };
    assert.equal(body.football?.enabled, true, 'the cron should run the football poll');
    assert.deepEqual(body.football?.poll?.refreshed, ['barcelona']);
    assert.equal(body.scanned, 1, 'and the watcher sweep after it');
    assert.equal(requests, 1);
    assert.equal((await listActiveFixtureCommitments(ALICE)).length, 2);
  } finally {
    globalThis.fetch = realFetch;
    end();
  }
});

/* ── Follows without a watcher ───────────────────────────────────── */

test('without the key, Settings cannot follow a club into a watcher that never fetches — but can still stop following', async () => {
  begin(null);
  try {
    // A follow saved before the watcher lane (Settings → Football was open to
    // everyone then), and no key on this server.
    await setFollowedClubs(ALICE, ['barcelona'], iso(T0));

    const adding = await putFootball(request('/api/mobile/football', { method: 'PUT', body: { clubIds: ['barcelona', 'liverpool'] } }));
    assert.equal(adding.status, 409);
    assert.equal((await adding.json() as { reason: string }).reason, 'provider_not_configured');
    assert.deepEqual(await getFollowedClubs(ALICE), ['barcelona']);

    // Saving what is already followed writes no watcher: it would say LIVE
    // and never fetch.
    const keeping = await putFootball(request('/api/mobile/football', { method: 'PUT', body: { clubIds: ['barcelona'] } }));
    assert.equal(keeping.status, 200);
    assert.deepEqual(await footballWatcherLabels(), []);

    // Stopping is always allowed.
    const stopping = await putFootball(request('/api/mobile/football', { method: 'PUT', body: { clubIds: [] } }));
    assert.equal(stopping.status, 200);
    assert.deepEqual(await getFollowedClubs(ALICE), []);
    assert.deepEqual(await footballWatcherLabels(), []);
  } finally {
    end();
  }
});

test('once the key exists, a follow from before the watcher lane gets its watcher on the first poll, named in the account language', async () => {
  begin('test-key');
  try {
    await setFollowedClubs(ALICE, ['barcelona'], iso(T0));
    await setUserLocale(ALICE, 'ar', iso(T0));
    assert.deepEqual(await footballWatcherLabels(), []);

    await tick(T0);
    assert.deepEqual(await footballWatcherLabels(), [['barcelona', 'برشلونة']]);
    assert.equal((await monitors()).length, 1);

    // The next poll finds it already there.
    await tick(T0 + FOOTBALL_POLL_INTERVAL_MS);
    assert.deepEqual(await footballWatcherLabels(), [['barcelona', 'برشلونة']]);
  } finally {
    end();
  }
});

test('Settings names a new follow\'s watcher in the account language when the save carries none', async () => {
  begin('test-key');
  try {
    await setUserLocale(ALICE, 'he', iso(T0));
    await putFootball(request('/api/mobile/football', { method: 'PUT', body: { clubIds: ['barcelona'] } }));
    const [[, label]] = await footballWatcherLabels() as [[string, string | null]];
    assert.notEqual(label, 'Barcelona');
    assert.match(label ?? '', /[\u0590-\u05FF]/);
  } finally {
    end();
  }
});

test('a poll that throws never stops the watcher sweep', async () => {
  begin('test-key');
  try {
    const result = await runWatcherTick({
      football: async () => { throw new Error('boom'); },
      sweep: () => runWatcherSweep({ now: at(T0) }),
    });
    assert.equal(result.football.error, 'football_poll_failed');
    assert.equal(result.scanned, 0);
  } finally {
    end();
  }
});

/* ── What a football watcher may be ──────────────────────────────── */

test('a football watcher names a curated club and a plan or notify effect, and cannot be retuned into anything else', async () => {
  begin('test-key');
  try {
    const unknown = await createWatcher(request('/api/mobile/watchers', {
      body: followBody({ source: { provider: 'football_data', connectionId: null, signalKind: 'football_team', subjectRef: 'narnia-fc' } }),
    }));
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json() as { reason: string }).reason, 'unknown_club');

    const proposing = await createWatcher(request('/api/mobile/watchers', { body: followBody({ effect: 'propose_commitment' }) }));
    assert.equal(proposing.status, 400);
    assert.equal((await proposing.json() as { reason: string }).reason, 'invalid_effect');

    const wrongProvider = await createWatcher(request('/api/mobile/watchers', {
      body: followBody({ source: { provider: 'aviation', connectionId: null, signalKind: 'football_team', subjectRef: 'barcelona' } }),
    }));
    assert.equal(wrongProvider.status, 400);
    assert.deepEqual(await getFollowedClubs(ALICE), []);

    const created = await createWatcher(request('/api/mobile/watchers', { body: followBody({ effect: 'notify' }) }));
    const watcherId = (await created.json() as { watcher: { watcherId: string } }).watcher.watcherId;
    const retuned = await patchWatcher(
      request(`/api/mobile/watchers/${watcherId}`, { method: 'PATCH', body: { effect: 'propose_commitment' } }),
      params(watcherId),
    );
    assert.equal(retuned.status, 400);
    const replan = await patchWatcher(
      request(`/api/mobile/watchers/${watcherId}`, { method: 'PATCH', body: { effect: 'replan_if_impacted' } }),
      params(watcherId),
    );
    assert.equal(replan.status, 200);
  } finally {
    end();
  }
});

/* ── Settings → Football and the watcher screen agree ────────────── */

test('saving the follow list in Settings leaves exactly one watcher per followed club', async () => {
  begin('test-key');
  try {
    const saved = await putFootball(request('/api/mobile/football', { method: 'PUT', body: { clubIds: ['liverpool', 'barcelona'], locale: 'ar' } }));
    assert.equal(saved.status, 200);
    assert.equal((await saved.json() as { providerConfigured: boolean }).providerConfigured, true);
    let items = (await (await listWatchers(request('/api/mobile/watchers'))).json() as {
      items: Array<{ label: string | null; source: { subjectRef: string } }>;
    }).items;
    assert.deepEqual(items.map((item) => [item.source.subjectRef, item.label]).sort(), [['barcelona', 'برشلونة'], ['liverpool', 'ليفربول']]);

    // Following Barcelona from the builder now is the same follow.
    await createWatcher(request('/api/mobile/watchers', { body: followBody() }));
    await putFootball(request('/api/mobile/football', { method: 'PUT', body: { clubIds: ['barcelona'] } }));
    items = (await (await listWatchers(request('/api/mobile/watchers'))).json() as { items: typeof items }).items;
    assert.deepEqual(items.map((item) => item.source.subjectRef), ['barcelona']);
  } finally {
    end();
  }
});

const PROFILE: UserRoutineProfile = {
  schemaVersion: 1,
  updatedAt: '2026-09-01T00:00:00.000Z',
  timezone: 'Asia/Jerusalem',
  sleepWindow: { start: '23:00', end: '07:00' },
  focusWindows: [{ start: '09:00', end: '17:00', label: 'work_study' }],
  fixedCommitmentWindows: [],
  preferredReminderIntensity: 'followUp',
  quietHours: null,
  surveySkipped: false,
} as UserRoutineProfile;
