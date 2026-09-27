/**
 * The nightly fixture sync (football fixtures MVP, Task 9).
 *
 * ── What this does, in one sentence ────────────────────────────────────────
 * Asks the provider for every followed club's fixtures and stores them, so
 * the projection in `projectFixtures.ts` has something fresh to turn into
 * commitments. One club is asked once, however many users follow it — the
 * curated list in `clubs.ts` is a menu, not a work queue, and only clubs with
 * at least one follower are ever fetched.
 *
 * ── Decision 1: a budget and a resumable order, not a flat spaced walk ─────
 * The naive version of this job — every followed club, one request every six
 * seconds (football-data.org's free tier is ten requests a minute) — does not
 * fit the deadline it has to run inside. `infra/scheduler.sh` posts to the
 * internal job routes with a 60-second attempt deadline and Cloud Scheduler's
 * default retries, and there is no claim or lock guarding this job. Fifteen
 * curated clubs at six seconds apart is roughly ninety seconds: the scheduler
 * gives up partway through, retries, and the retry's run overlaps the first
 * one's — see the "overlapping runs" note below for what that costs.
 *
 * This module follows the pattern `lib/jobs/internalJobs.ts` already uses for
 * the identical shape of problem (`TICK_BUDGET_MS`, `runJobsTick`): give the
 * sync a time budget (`budgetMs`, default `DEFAULT_SYNC_BUDGET_MS`) and
 * process as many followed clubs as fit inside it, stopping *before* the
 * deadline rather than being cut off by it. A budget alone would just mean a
 * consistent prefix of the followed list gets synced every night and the
 * rest never does — a club that happens to sort last would never be reached.
 * So every attempt (success or failure) records the club's `lastSyncedAt` in
 * `FOOTBALL_CLUB_SYNC_STATE`, and each tick asks for the least-recently-synced
 * followed clubs first. A club a budget deferred this tick is the most
 * urgent candidate next tick, so consecutive ticks rotate through the whole
 * followed list instead of racing the same prefix forever. (This constant
 * is not imported from `internalJobs.ts` — that module imports
 * `syncFollowedClubs` from here, and a constant imported the other way would
 * make the two files an import cycle for no reason; the value is kept in
 * step with `TICK_BUDGET_MS`'s reasoning by comment, not by reference.)
 *
 * ── Decision 2: this budget shrinks scheduler-retry overlap, but does not
 *    remove what overlapping runs still cost ─────────────────────────────
 * `fixtureStore.ts`'s own header explains why `upsertFixtures` is
 * deliberately not transactional: the writes are content-addressed, so two
 * concurrent runs over the same fixture converge on the same bytes rather
 * than corrupting anything. What they do NOT converge on is the `{written,
 * unchanged}` tally (each run only knows what *it* observed) or the request
 * budget (a fixture asked about by two overlapping runs is asked about
 * twice). Fitting comfortably inside the 60-second deadline makes the
 * specific overlap decision 1 was written to prevent — a timeout retry firing
 * while the first attempt is still running — far less likely than the naive
 * ~90-second walk it replaces. It does not make overlap impossible: an
 * operator re-running the job by hand while a previous tick is still in
 * flight, or two scheduler ticks landing close together, still produces two
 * concurrent `upsertFixtures` calls with the exact costs the header
 * describes. The budget shrinks the likeliest cause of overlap; it is not a
 * lock.
 *
 * ── Decision 3: this module fetches and stores; it does not project ────────
 * Turning a stored fixture into a commitment is `projectFixturesForUser`'s
 * job, not this one's — seeing an unfollowed store update touch every
 * follower's own commitment write here would make a single-club fetch fan
 * out into per-user domain transactions this module has no business owning.
 * `lib/jobs/internalJobs.ts`'s `runFootballSyncJob` is what calls both this
 * function and `projectFixturesForUser` in sequence, giving the projection
 * function its first real caller — see that module's header for the race
 * that wiring creates against `dismissFixtureCommitment` and why it is not
 * made worse here.
 */
import { createHash } from 'node:crypto';
import { FOOTBALL_DATA_REQUEST_TIMEOUT_MS } from './footballDataProvider';
import {
  getStorage,
  type StorageAdapter,
} from '../storage';
import { fixtureDoc, footballClubSyncStateDoc } from '../storage/paths';
import type {
  ClubSyncFailureKind,
  ClubSyncState,
  Fixture,
  FixtureProvider,
  FixtureWindow,
} from '../../src/contracts/v1/fixtureContracts';
import { listClubs, type Club } from './clubs';
import { upsertFixtures } from './fixtureStore';
import { listFollowedClubIdsAcrossUsers } from './followedClubs';
import { PROJECTION_WINDOW_DAYS } from './projectFixtures';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** football-data.org's free tier allows ten requests a minute. */
export const REQUEST_SPACING_MS = 6_000;

/**
 * Mirrors `TICK_BUDGET_MS` in `lib/jobs/internalJobs.ts`: Cloud Scheduler's
 * attempt deadline is 60s; stop claiming new work well before it, so the
 * response the scheduler is waiting on actually arrives inside the deadline
 * instead of racing it. Kept as an independent constant rather than an
 * import — see the module header.
 *
 * This number and the actual deadline are declared in two different files
 * that nothing ties together automatically: the deadline lives in
 * `infra/scheduler.sh`'s `upsert_job` (`--attempt-deadline=60s`, shared by
 * every internal job route including this one's, at
 * `src/app/api/internal/jobs/football-sync/route.ts`). If either number
 * changes without the other, this budget either stops protecting the
 * deadline it was built for, or gives up sooner than it needs to for no
 * reason — see that route file's own comment, which states the same
 * relationship from the other side.
 */
export const DEFAULT_SYNC_BUDGET_MS = 45_000;

/** How many fixtures a request budget can afford — see the module header. */
export interface SyncFollowedClubsDeps {
  readonly provider: FixtureProvider;
  /** The instant this run considers "now". Never `Date.now()` — see the brief's no-ambient-clock rule. */
  readonly now: string;
  /** Injected so tests do not actually wait six seconds between requests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected wall-clock read, for budget accounting; defaults to `Date.now`. */
  readonly clock?: () => number;
  readonly budgetMs?: number;
  readonly storage?: StorageAdapter;
}

/** What one sync run did. */
export interface SyncReport {
  /** Distinct followed clubs this run considered as candidates (whether or not the budget let it reach all of them). */
  clubs: number;
  /** How many of those candidates were actually asked of the provider this tick. */
  attempted: number;
  /** Fixtures returned by the provider, summed across attempted clubs. */
  fetched: number;
  /** Fixtures `upsertFixtures` actually wrote (i.e. changed), summed across attempted clubs. */
  written: number;
  failures: Array<{ clubId: string; reason: string }>;
  /** `drained`: every followed club was attempted. `budget`: time ran out first, and some candidates were deferred to the next tick. */
  stoppedBy: 'drained' | 'budget';
}


function storageOf(deps: SyncFollowedClubsDeps): StorageAdapter {
  return deps.storage ?? getStorage();
}

function syncWindow(now: string): FixtureWindow {
  return {
    fromIso: now,
    toIso: new Date(Date.parse(now) + PROJECTION_WINDOW_DAYS * MS_PER_DAY).toISOString(),
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readClubSyncState(clubId: string, storage: StorageAdapter): Promise<ClubSyncState | null> {
  return (await storage.get<ClubSyncState>(footballClubSyncStateDoc(clubId))) ?? null;
}

async function readLastSyncedAt(clubId: string, storage: StorageAdapter): Promise<string | null> {
  return (await readClubSyncState(clubId, storage))?.lastSyncedAt ?? null;
}

/**
 * A provider failure in the closed vocabulary the sync state stores. The
 * adapter's message names the HTTP status (`request failed: 429 …`); nothing
 * else about it is kept.
 */
export function classifyFetchFailure(error: unknown): ClubSyncFailureKind {
  const message = error instanceof Error ? error.message : String(error);
  return /request failed: 429\b/.test(message) ? 'rate_limited' : 'unavailable';
}

/**
 * A change the football watcher should hear about: a match this store already
 * knew whose kickoff moved, or that was postponed or cancelled. A match that
 * is new to the store is not a change (it is the window moving forward), and
 * neither is one that finished — that is time passing, not news.
 */
function materialChange(before: Fixture | null, after: Fixture): boolean {
  if (!before) return false;
  if (before.kickoffUtc !== after.kickoffUtc) return true;
  return before.status !== after.status && (after.status === 'postponed' || after.status === 'cancelled');
}

export type ClubFetchResult =
  | { readonly ok: true; readonly fetched: number; readonly written: number; readonly changed: number }
  | { readonly ok: false; readonly reason: string; readonly failureKind: ClubSyncFailureKind };

/**
 * Asks the provider for one club, stores what came back, and records the
 * attempt on the club's sync state — its outcome, and (when an already-known
 * match materially changed) a new `changeDigest` that the football watcher's
 * observer reads. Shared by the nightly sync and the per-minute poll, so the
 * two can never disagree about what counts as a change.
 *
 * Never throws for a provider failure: that is recorded as `failed` with a
 * closed-vocabulary `failureKind`, and the stored fixtures are untouched.
 */
export async function fetchAndStoreClub(
  club: Club,
  deps: { readonly provider: FixtureProvider; readonly now: string; readonly storage: StorageAdapter },
): Promise<ClubFetchResult> {
  const { provider, now, storage } = deps;
  const previous = await readClubSyncState(club.clubId, storage);
  let fixtures: readonly Fixture[];
  try {
    fixtures = await provider.listFixtures(club.providerTeamId, syncWindow(now));
  } catch (error) {
    const failureKind = classifyFetchFailure(error);
    await storage.set<ClubSyncState>(footballClubSyncStateDoc(club.clubId), {
      clubId: club.clubId,
      lastSyncedAt: now,
      lastOutcome: 'failed',
      failureKind,
      lastSucceededAt: previous?.lastSucceededAt ?? null,
      changeDigest: previous?.changeDigest ?? null,
      lastChangedAt: previous?.lastChangedAt ?? null,
    });
    return { ok: false, reason: reasonOf(error), failureKind };
  }

  const changes: string[] = [];
  for (const fixture of fixtures) {
    const before = await storage.get<Fixture>(fixtureDoc(fixture.provider, fixture.providerMatchId));
    if (materialChange(before ?? null, fixture)) changes.push(`${fixture.providerMatchId}:${fixture.contentHash}`);
  }
  const result = await upsertFixtures(fixtures, { storage });
  const changeDigest = changes.length === 0
    ? previous?.changeDigest ?? null
    : createHash('sha256').update(`${previous?.changeDigest ?? ''}|${changes.sort().join(',')}`).digest('hex');
  await storage.set<ClubSyncState>(footballClubSyncStateDoc(club.clubId), {
    clubId: club.clubId,
    lastSyncedAt: now,
    lastOutcome: 'ok',
    failureKind: null,
    lastSucceededAt: now,
    changeDigest,
    lastChangedAt: changes.length === 0 ? previous?.lastChangedAt ?? null : now,
  });
  return { ok: true, fetched: fixtures.length, written: result.written, changed: changes.length };
}

/**
 * Followed, curated clubs ordered least-recently-synced first, so a budget
 * that cannot reach the whole list defers the clubs that were synced most
 * recently — the ones a follower is least likely to be waiting on.
 *
 * Ties (including "never synced", which sorts first of all) break on
 * `clubId` alphabetically, so the order is deterministic across runs with
 * identical sync history rather than depending on `Set`/`Map` iteration
 * order upstream.
 */
async function orderedCandidates(storage: StorageAdapter): Promise<Club[]> {
  const followedIds = await listFollowedClubIdsAcrossUsers({ storage });
  const curated = new Map(listClubs().map((club) => [club.clubId, club]));
  const candidates = followedIds
    .map((id) => curated.get(id))
    // `setFollowedClubs` already refuses an id the curated list does not
    // contain, so a miss here guards a race between a follow and the curated
    // list changing under it, not a typo — see `followedClubs.ts`'s header
    // for the same guard in `projectFixturesForUser`.
    .filter((club): club is Club => Boolean(club));

  const withLastSynced = await Promise.all(
    candidates.map(async (club) => ({ club, lastSyncedAt: await readLastSyncedAt(club.clubId, storage) })),
  );
  withLastSynced.sort((a, b) => {
    const aKey = a.lastSyncedAt ?? '';
    const bKey = b.lastSyncedAt ?? '';
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    return a.club.clubId < b.club.clubId ? -1 : a.club.clubId > b.club.clubId ? 1 : 0;
  });
  return withLastSynced.map((row) => row.club);
}

/**
 * Fetches and stores fixtures for every club at least one user follows,
 * inside a time budget, resuming from whichever clubs were least recently
 * synced — see the module header for why.
 */
export async function syncFollowedClubs(deps: SyncFollowedClubsDeps): Promise<SyncReport> {
  const storage = storageOf(deps);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clock = deps.clock ?? Date.now;
  const budgetMs = deps.budgetMs ?? DEFAULT_SYNC_BUDGET_MS;
  const started = clock();

  const candidates = await orderedCandidates(storage);

  const report: SyncReport = {
    clubs: candidates.length,
    attempted: 0,
    fetched: 0,
    written: 0,
    failures: [],
    stoppedBy: 'drained',
  };

  for (let i = 0; i < candidates.length; i += 1) {
    if (i > 0) {
      // Checked BEFORE sleeping into the next request, not after: a request
      // that would start past the deadline must never be started at all, or
      // the response this budget exists to keep inside 60s would arrive
      // late anyway. The very first candidate is always attempted
      // unconditionally, so a misconfigured near-zero budget still makes
      // progress -- one club a tick, forever, rather than none.
      // The whole cost of the next request counts, not only what has already
      // been spent: the spacing sleep plus a request that may run to its
      // full timeout (final review M1).
      if (clock() - started + REQUEST_SPACING_MS + FOOTBALL_DATA_REQUEST_TIMEOUT_MS > budgetMs) {
        report.stoppedBy = 'budget';
        break;
      }
      await sleep(REQUEST_SPACING_MS);
    }

    const club = candidates[i]!;
    report.attempted += 1;
    // One club's fetch failing must not stop the rest -- and must never read
    // as "this club has no matches" (see fixtureStore.ts and
    // footballDataProvider.ts: a failed fetch never deletes). The attempt is
    // recorded for both outcomes, so a persistently broken club rotates out
    // of "least recently synced" instead of eating the start of every tick.
    const result = await fetchAndStoreClub(club, { provider: deps.provider, now: deps.now, storage });
    if (result.ok) {
      report.fetched += result.fetched;
      report.written += result.written;
    } else {
      report.failures.push({ clubId: club.clubId, reason: result.reason });
    }
  }

  return report;
}

/* ── The per-minute poll (closure CL7) ──────────────────────────────── */

/** A club whose last fetch worked is asked again after this long. */
export const FOOTBALL_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A club whose last fetch failed is retried after this long. */
export const FOOTBALL_RETRY_AFTER_MS = 10 * 60 * 1000;
/**
 * At most this many provider requests per poll. The poll runs once a minute
 * (it rides the watcher sweep's cron), so this is at most one request a
 * minute on top of the nightly sync — inside the free tier's ten a minute
 * (`REQUEST_SPACING_MS`) even while the nightly sync is running.
 */
export const FOOTBALL_POLL_MAX_FETCHES = 1;

export interface PollFollowedClubsDeps {
  readonly provider: FixtureProvider;
  readonly now: string;
  readonly storage?: StorageAdapter;
  readonly maxFetches?: number;
}

export interface PollReport {
  /** Followed clubs whose sync state made them due this minute. */
  due: number;
  attempted: number;
  /** Clubs fetched and stored successfully this poll; their followers need projecting. */
  refreshed: string[];
  failures: Array<{ clubId: string; failureKind: ClubSyncFailureKind }>;
}

function isDue(state: ClubSyncState | null, now: string): boolean {
  if (!state) return true;
  const age = Date.parse(now) - Date.parse(state.lastSyncedAt);
  return state.lastOutcome === 'failed' ? age >= FOOTBALL_RETRY_AFTER_MS : age >= FOOTBALL_POLL_INTERVAL_MS;
}

/**
 * The followed clubs that are due, least recently synced first, fetched up to
 * `maxFetches` — what makes a new follow show its matches within a minute or
 * two, a kickoff that moves reach the watcher within `FOOTBALL_POLL_INTERVAL_MS`,
 * and a failed fetch retry in `FOOTBALL_RETRY_AFTER_MS` rather than tomorrow
 * night.
 */
export async function pollFollowedClubs(deps: PollFollowedClubsDeps): Promise<PollReport> {
  const storage = deps.storage ?? getStorage();
  const maxFetches = deps.maxFetches ?? FOOTBALL_POLL_MAX_FETCHES;
  const report: PollReport = { due: 0, attempted: 0, refreshed: [], failures: [] };
  const due: Club[] = [];
  for (const club of await orderedCandidates(storage)) {
    if (isDue(await readClubSyncState(club.clubId, storage), deps.now)) due.push(club);
  }
  report.due = due.length;
  for (const club of due.slice(0, maxFetches)) {
    report.attempted += 1;
    const result = await fetchAndStoreClub(club, { provider: deps.provider, now: deps.now, storage });
    if (result.ok) report.refreshed.push(club.clubId);
    else report.failures.push({ clubId: club.clubId, failureKind: result.failureKind });
  }
  return report;
}
