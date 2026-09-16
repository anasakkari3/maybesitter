/**
 * The shared fixture store (football fixtures MVP, Task 5).
 *
 * ── One row per match, not one per follower ──────────────────────────────
 * `paths.ts` explains why `FIXTURES` is a top-level collection; this module is
 * what reads and writes it. A thousand people following FC Barcelona still
 * cost one `upsertFixtures` call and one row — the per-user fetch this design
 * rejected would instead cost one provider call per follower per night, which
 * is also the fastest way to exhaust football-data.org's free tier.
 *
 * ── Why an unchanged fixture is never rewritten ──────────────────────────
 * The nightly sync calls `upsertFixtures` with every fixture in the window it
 * asked the provider for, whether or not anything about them moved. A blind
 * `set` on every one of those would give Task 8's projection a `contentHash`
 * it had never seen for a match nobody touched, and the projection's only way
 * to read "the hash changed" is "reschedule this commitment's reminders" — so
 * a no-op nightly write would move reminders nobody asked to move, every
 * night, for every fixture. Comparing `contentHash` before writing is what
 * keeps a quiet night quiet.
 *
 * ── Why there is no transaction here ─────────────────────────────────────
 * `deviceCalendarLinks.ts` reads-then-writes inside a transaction because two
 * *different* devices can race to claim the same link. Nothing here races:
 * one nightly job is the only writer a fixture ever has, so the plain
 * get-then-set below has no concurrent writer to lose a race against. If a
 * second writer is ever introduced (e.g. a manual backfill job running
 * alongside the nightly sync), this is the line to make transactional.
 *
 * ── Why a team listing is two queries, not one ───────────────────────────
 * A club plays roughly half its matches at home and half away, and `where`
 * clauses inside one `list()` call are ANDed together — there is no single
 * equality filter that means "this team, on either side of the match". So
 * `listFixturesForTeam` runs the home query and the away query separately and
 * merges the results, rather than risking a filter that silently returns half
 * a season and looks, to every caller, like a complete one.
 */
import {
  getStorage,
  requireCollectionPath,
  type ListOptions,
  type StorageAdapter,
} from '../storage';
import { FIXTURES, fixtureDoc } from '../storage/paths';
import type { Fixture, FixtureWindow } from '../../src/contracts/v1/fixtureContracts';

export interface FixtureStoreDeps {
  storage?: StorageAdapter;
}

function storageOf(deps: FixtureStoreDeps): StorageAdapter {
  return deps.storage ?? getStorage();
}

/** How many fixtures were written vs. left alone because nothing changed. */
export interface UpsertFixturesResult {
  written: number;
  unchanged: number;
}

/**
 * Stores every fixture, once each, keyed by `(provider, providerMatchId)`.
 *
 * A fixture whose `contentHash` matches what is already stored is left
 * untouched — see the module header for why that matters to the projection
 * downstream. The tally lets a caller (or a log line) tell "a quiet night"
 * apart from "the provider changed a third of the season".
 */
export async function upsertFixtures(
  fixtures: readonly Fixture[],
  deps: FixtureStoreDeps = {},
): Promise<UpsertFixturesResult> {
  const storage = storageOf(deps);
  let written = 0;
  let unchanged = 0;
  for (const fixture of fixtures) {
    const path = fixtureDoc(fixture.provider, fixture.providerMatchId);
    const existing = await storage.get<Fixture>(path);
    if (existing && existing.contentHash === fixture.contentHash) {
      unchanged += 1;
      continue;
    }
    await storage.set(path, fixture);
    written += 1;
  }
  return { written, unchanged };
}

function windowWhere(window: FixtureWindow): NonNullable<ListOptions['where']> {
  // Half-open, product-wide convention: a fixture at exactly `toIso` belongs
  // to the *next* window, not this one.
  return [
    ['kickoffUtc', '>=', window.fromIso],
    ['kickoffUtc', '<', window.toIso],
  ];
}

/**
 * Every fixture in `window` where `providerTeamId` plays, home or away.
 *
 * See the module header for why this is two queries merged rather than one —
 * a single equality filter on either side of the match would only ever see
 * half the team's fixtures.
 */
export async function listFixturesForTeam(
  providerTeamId: string,
  window: FixtureWindow,
  deps: FixtureStoreDeps = {},
): Promise<readonly Fixture[]> {
  const storage = storageOf(deps);
  const collection = requireCollectionPath(FIXTURES);
  const [home, away] = await Promise.all([
    storage.list<Fixture>(collection, {
      where: [['homeTeamId', '==', providerTeamId], ...windowWhere(window)],
    }),
    storage.list<Fixture>(collection, {
      where: [['awayTeamId', '==', providerTeamId], ...windowWhere(window)],
    }),
  ]);
  // A `Map` keyed by document id merges the two sides and, incidentally,
  // guards against a row somehow matching both queries (e.g. malformed data
  // with homeTeamId === awayTeamId) being counted twice.
  const byId = new Map<string, Fixture>();
  for (const row of home) byId.set(row.id, row.data);
  for (const row of away) byId.set(row.id, row.data);
  return [...byId.values()].sort((a, b) => {
    if (a.kickoffUtc !== b.kickoffUtc) return a.kickoffUtc < b.kickoffUtc ? -1 : 1;
    return a.providerMatchId < b.providerMatchId ? -1 : a.providerMatchId > b.providerMatchId ? 1 : 0;
  });
}
