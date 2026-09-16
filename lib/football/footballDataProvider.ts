/**
 * The football-data.org adapter (UC football fixtures, #185-series).
 *
 * ── The seam ────────────────────────────────────────────────────────────
 * This is the only file in the feature allowed to know that "football-data"
 * means football-data.org's v4 REST API: its base URL, its `X-Auth-Token`
 * header, its `SCHEDULED`/`POSTPONED`/`CANCELLED`/`FINISHED` vocabulary, its
 * `dateFrom`/`dateTo` query params. Everything above `FixtureProvider`
 * (`src/contracts/v1/fixtureContracts.ts`) is the product's own contract;
 * everything in this file is the vendor's shape, translated at the door.
 *
 * ── Fail-closed, in both directions ────────────────────────────────────
 * A row this module cannot read is skipped (`normalizeMatch` returns
 * `null`) rather than defaulted or thrown -- one bad match must not cost
 * the user the other nineteen. A *response* this module cannot read is
 * rejected (`listFixtures` throws) rather than treated as zero matches --
 * an empty list is indistinguishable from "this club has no fixtures", and
 * whatever reads this provider downstream would take that as permission to
 * clear somebody's evening. The two failure shapes look similar but are not
 * interchangeable: one bad row is local and recoverable, one bad response is
 * global and must stop the sync.
 */
import {
  fixtureContentHash,
  FIXTURE_CONTRACT_VERSION,
  FIXTURE_SCHEMA_VERSION,
  type Fixture,
  type FixtureCore,
  type FixtureProvider,
  type FixtureStatus,
  type FixtureWindow,
} from '../../src/contracts/v1/fixtureContracts';

const PROVIDER_NAME = 'football-data';
const API_BASE_URL = 'https://api.football-data.org/v4';

/**
 * football-data.org's status vocabulary, translated to ours.
 *
 * `IN_PLAY`/`PAUSED` fold into `scheduled` -- from this product's point of
 * view a match in progress is still occupying the evening it was scheduled
 * for, and nothing here needs a live-clock distinction (the contract
 * deliberately has no field for one). `SUSPENDED` folds into `postponed` for
 * the same reason `POSTPONED` does: the block is off, a new time is not yet
 * known.
 *
 * Anything not listed here is deliberately absent rather than mapped to a
 * guess. `normalizeMatch` skips the match instead of defaulting it, because
 * a quietly-invented status is how a game that is not being played ends up
 * blocking somebody's evening anyway.
 */
const STATUS_MAP: Readonly<Record<string, FixtureStatus>> = {
  SCHEDULED: 'scheduled',
  TIMED: 'scheduled',
  IN_PLAY: 'scheduled',
  PAUSED: 'scheduled',
  POSTPONED: 'postponed',
  SUSPENDED: 'postponed',
  CANCELLED: 'cancelled',
  FINISHED: 'finished',
  AWARDED: 'finished',
};

/** Reads a required string field, or hands back `undefined` for anything that isn't one. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * One vendor match, translated to a `Fixture`, or `null` if it cannot be
 * read.
 *
 * `null` covers every way a row can be broken: a missing id, an unparseable
 * `utcDate`, a missing team, an unrecognised status. They are handled
 * uniformly (skip, don't throw, don't guess) because from the caller's side
 * they are the same event -- one match in a list of many that this adapter
 * could not vouch for.
 */
export function normalizeMatch(raw: unknown): Fixture | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const match = raw as Record<string, unknown>;

  const id = match.id;
  const providerMatchId = typeof id === 'number' || typeof id === 'string' ? String(id) : undefined;
  if (!providerMatchId) return null;

  // Unknown status is a skip, never a default. `scheduled` is the one status
  // that blocks time on a calendar, so guessing it for a status this adapter
  // does not recognise is exactly the failure mode this contract exists to
  // rule out.
  const rawStatus = readString(match.status);
  const status = rawStatus ? STATUS_MAP[rawStatus] : undefined;
  if (!status) return null;

  const utcDate = readString(match.utcDate);
  if (!utcDate) return null;
  const kickoff = new Date(utcDate);
  if (Number.isNaN(kickoff.getTime())) return null;

  const competition = match.competition as Record<string, unknown> | undefined;
  const competitionCode = readString(competition?.code);
  if (!competitionCode) return null;

  const homeTeam = match.homeTeam as Record<string, unknown> | undefined;
  const awayTeam = match.awayTeam as Record<string, unknown> | undefined;
  const homeTeamId = homeTeam && (typeof homeTeam.id === 'number' || typeof homeTeam.id === 'string')
    ? String(homeTeam.id)
    : undefined;
  const awayTeamId = awayTeam && (typeof awayTeam.id === 'number' || typeof awayTeam.id === 'string')
    ? String(awayTeam.id)
    : undefined;
  const homeTeamName = readString(homeTeam?.name);
  const awayTeamName = readString(awayTeam?.name);
  if (!homeTeamId || !awayTeamId || !homeTeamName || !awayTeamName) return null;

  const venue = readString(match.venue) ?? null;

  const core: FixtureCore = {
    provider: PROVIDER_NAME,
    providerMatchId,
    competition: competitionCode,
    homeTeamId,
    awayTeamId,
    homeTeamName,
    awayTeamName,
    // `toISOString()` always emits a `Z`-suffixed UTC instant, regardless of
    // how the vendor happened to format the offset on the wire.
    kickoffUtc: kickoff.toISOString(),
    status,
    venue,
  };

  return {
    ...core,
    version: FIXTURE_CONTRACT_VERSION,
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    contentHash: fixtureContentHash(core),
  };
}

export interface FootballDataProviderDeps {
  /** Defaults to `process.env.FOOTBALL_DATA_API_KEY`. Injected by tests. */
  apiKey?: string;
  /** Defaults to the global `fetch`. Injected by tests -- no test in this
   *  suite is allowed to reach the real API (see the module comment on
   *  `tests/football/footballDataProvider.test.ts`). */
  fetchImpl?: typeof fetch;
}

/**
 * Builds the `FixtureProvider` for football-data.org.
 *
 * No network call happens at construction time -- only `listFixtures` talks
 * to anything, so building a provider is always safe, including with a
 * missing key.
 */
export function createFootballDataProvider(deps: FootballDataProviderDeps = {}): FixtureProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    name: PROVIDER_NAME,

    async listFixtures(providerTeamId: string, window: FixtureWindow): Promise<readonly Fixture[]> {
      // Named explicitly rather than left to a generic "unauthorized" from the
      // HTTP layer -- whoever reads this message next is a person debugging a
      // missing env var, not the vendor's API.
      const apiKey = deps.apiKey ?? process.env.FOOTBALL_DATA_API_KEY;
      if (!apiKey) {
        throw new Error(
          'football-data provider has no API key: set FOOTBALL_DATA_API_KEY (or pass apiKey explicitly)',
        );
      }

      const url = new URL(`${API_BASE_URL}/teams/${encodeURIComponent(providerTeamId)}/matches`);
      url.searchParams.set('dateFrom', window.fromIso);
      url.searchParams.set('dateTo', window.toIso);

      const response = await fetchImpl(url, { headers: { 'X-Auth-Token': apiKey } });

      // A non-2xx rejects rather than resolving to an empty list. An empty
      // list here would be silently indistinguishable from "no fixtures in
      // this window", and whatever calls this provider to keep a calendar in
      // sync would read that as license to clear commitments that are simply
      // not this adapter's fault to have lost.
      if (!response.ok) {
        throw new Error(
          `football-data request failed: ${response.status} ${response.statusText} (team ${providerTeamId})`,
        );
      }

      const body = (await response.json()) as { matches?: unknown };
      const rawMatches = Array.isArray(body.matches) ? body.matches : [];

      const fixtures: Fixture[] = [];
      for (const raw of rawMatches) {
        const fixture = normalizeMatch(raw);
        // A malformed row is skipped, not fatal -- see the module comment.
        if (fixture) fixtures.push(fixture);
      }
      return fixtures;
    },
  };
}
