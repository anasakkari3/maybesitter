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
import {
  getStorage,
  type StorageAdapter,
} from '../storage';
import { footballClubSyncStateDoc } from '../storage/paths';
import type { FixtureProvider, FixtureWindow } from '../../src/contracts/v1/fixtureContracts';
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

interface ClubSyncStateDoc {
  readonly clubId: string;
  readonly lastSyncedAt: string;
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

async function readLastSyncedAt(clubId: string, storage: StorageAdapter): Promise<string | null> {
  const doc = await storage.get<ClubSyncStateDoc>(footballClubSyncStateDoc(clubId));
  return doc?.lastSyncedAt ?? null;
}

/**
 * Records that `clubId` was asked of the provider at `now`, success or
 * failure alike. A failing club still needs to rotate out of "least recently
 * synced" — the alternative (only advancing on success) would let a
 * persistently broken club sort first forever, consuming the start of every
 * future tick's budget retrying it before any other followed club gets a
 * turn. Recording an attempt is not the same claim as recording a result:
 * the fixture data itself is untouched on failure (see `upsertFixtures`), so
 * marking the *attempt* here does not risk anyone's stored fixtures.
 */
async function recordClubSynced(clubId: string, now: string, storage: StorageAdapter): Promise<void> {
  await storage.set<ClubSyncStateDoc>(footballClubSyncStateDoc(clubId), { clubId, lastSyncedAt: now });
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
  const window = syncWindow(deps.now);
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
      if (clock() - started >= budgetMs) {
        report.stoppedBy = 'budget';
        break;
      }
      await sleep(REQUEST_SPACING_MS);
    }

    const club = candidates[i]!;
    report.attempted += 1;
    try {
      const fixtures = await deps.provider.listFixtures(club.providerTeamId, window);
      report.fetched += fixtures.length;
      const result = await upsertFixtures(fixtures, { storage });
      report.written += result.written;
    } catch (error) {
      // One club's fetch failing must not stop the rest -- and must never
      // read as "this club has no matches" (see fixtureStore.ts and
      // footballDataProvider.ts: a failed fetch never deletes, because
      // nothing is written here on this path).
      report.failures.push({ clubId: club.clubId, reason: reasonOf(error) });
    }
    // Recorded for both outcomes -- see recordClubSynced's own comment.
    await recordClubSynced(club.clubId, deps.now, storage);
  }

  return report;
}
