/**
 * Football fixture contract and the provider seam.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 * A `Fixture` is how the product is allowed to know about a football match:
 * an interval, two team names, a competition and a status. The product cares
 * about a match as a claim on somebody's evening — something that blocks two
 * hours and might move, get postponed, or get cancelled — not as a sporting
 * event with a result.
 *
 * ── What this deliberately refuses to represent ───────────────────────────
 * No score, no lineup, no minute-by-minute state, no live clock. A contract
 * with no field for a score cannot leak one into a commitment title by
 * accident, and a boundary that never carries live state cannot be asked to
 * keep it fresh. If a future feature needs a score, it needs a new contract
 * and a deliberate decision, not a widened field on this one.
 *
 * ── The vendor seam ────────────────────────────────────────────────────────
 * `FixtureProvider` is where one company's HTTP API, auth and JSON shape stay
 * on the far side of an interface. Everything above `FixtureProvider` in this
 * file is ours; everything behind it belongs to whichever vendor we happen to
 * be calling this sprint.
 */

import { createHash } from 'node:crypto';
import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const FIXTURE_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const FIXTURE_SCHEMA_VERSION = 'fixture-v1' as const;

/** A match occupies two hours: ninety minutes plus the interval and stoppage. */
export const FIXTURE_BLOCK_MINUTES = 120;

export type FixtureStatus = 'scheduled' | 'postponed' | 'cancelled' | 'finished';

export interface FixtureCore {
  readonly provider: string;
  readonly providerMatchId: string;
  readonly competition: string;
  readonly homeTeamId: string;
  readonly awayTeamId: string;
  readonly homeTeamName: string;
  readonly awayTeamName: string;
  /** UTC instant. Never a local time: see the timezone constraint. */
  readonly kickoffUtc: string;
  readonly status: FixtureStatus;
  readonly venue: string | null;
}

export interface Fixture extends FixtureCore {
  readonly version: typeof FIXTURE_CONTRACT_VERSION;
  readonly schemaVersion: typeof FIXTURE_SCHEMA_VERSION;
  readonly contentHash: string;
}

export interface FixtureWindow {
  readonly fromIso: string;
  readonly toIso: string;
}

/**
 * The vendor seam. Everything above this line is ours; everything below knows
 * about HTTP, API keys and one company's JSON.
 */
export interface FixtureProvider {
  readonly name: string;
  listFixtures(providerTeamId: string, window: FixtureWindow): Promise<readonly Fixture[]>;
}

/* ── The football watcher source (closure CL7, «تابعلي») ──────────── */

/**
 * The provider name a football watcher names. The watcher vocabulary is a
 * lowercase token (`watcherApi.ts`'s `PROVIDER`), so this is the adapter's
 * `football-data` spelled with an underscore; nothing joins the two.
 */
export const FOOTBALL_WATCHER_PROVIDER = 'football_data' as const;
/**
 * A watcher over one followed club's fixtures. `subjectRef` is the curated
 * `clubId` (`lib/football/clubs.ts`), never a provider team id.
 */
export const FOOTBALL_TEAM_SIGNAL_KIND = 'football_team' as const;

/**
 * Why the last fetch of a club failed, in a closed vocabulary: the provider's
 * own message never leaves the adapter. `rate_limited` is a 429 (the free
 * tier's per-minute cap); everything else — a timeout, a 5xx, an unreadable
 * body — is `unavailable`.
 */
export type ClubSyncFailureKind = 'rate_limited' | 'unavailable';

/**
 * A club whose last fetch failed is asked again this long after that attempt
 * (the per-minute poll's retry). Here, next to `ClubSyncState`, because both
 * the poll and the background-monitor row read it: the row's "next check" for
 * a retrying watcher is `lastSyncedAt` plus this.
 */
export const FOOTBALL_RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * `footballClubSyncState/{clubId}`: when a club was last asked of the
 * provider, how that went, and a digest that moves only when an
 * already-known match materially changed (kickoff moved, postponed,
 * cancelled). The football watcher's observer reads this document and
 * nothing else, so a match merely entering or leaving the sync window never
 * reads as a change.
 *
 * Every field after `lastSyncedAt` is optional: documents written before
 * CL7 carry only the first two.
 */
export interface ClubSyncState {
  readonly clubId: string;
  /** The last attempt, success or failure. */
  readonly lastSyncedAt: string;
  readonly lastOutcome?: 'ok' | 'failed';
  readonly failureKind?: ClubSyncFailureKind | null;
  readonly lastSucceededAt?: string | null;
  readonly changeDigest?: string | null;
  readonly lastChangedAt?: string | null;
}

/**
 * Decides whether a fixture changed since it was last seen. Sorts its keys
 * before hashing so the result depends only on content, never on the order a
 * provider happened to serialise its JSON on a given response.
 */
export function fixtureContentHash(core: FixtureCore): string {
  // `Object.entries` rather than `Object.keys(...).map((key) => core[key])`:
  // `FixtureCore` has no index signature, so indexing it with a plain
  // `string` key needs a cast -- and `core as Record<string, unknown>` is a
  // cast TypeScript itself refuses (the two types don't sufficiently
  // overlap). `Object.entries` reads the same key/value pairs without one.
  const sorted = Object.entries(core).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
