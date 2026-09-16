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
 * Not a "single writer" promise — the infrastructure does not give one.
 * `infra/scheduler.sh` posts the nightly sync with `--attempt-deadline=60s`
 * and Cloud Scheduler's default retry, and the planned sync walks roughly
 * fifteen clubs several seconds apart, comfortably past sixty seconds end to
 * end. A timeout retry, or an operator re-running the job by hand while the
 * first run is still going server-side, produces two concurrent
 * `upsertFixtures` calls over the same fixtures, with no lock between them.
 *
 * What makes the plain get-then-set below safe anyway is that the write is
 * content-addressed: two overlapping runs reading the same unchanged fixture
 * both see the same `contentHash` and either both skip it or both write the
 * same bytes, so they converge on one document rather than corrupting it —
 * unlike `deviceCalendarLinks.ts`, where two *different* devices can race to
 * claim the same link with genuinely different content and a transaction is
 * what makes one of them lose cleanly.
 *
 * Convergence is not free of cost, though. Two overlapping runs each compute
 * their own `{ written, unchanged }` tally from what *they* observed, so the
 * tally stops being a reliable "quiet night versus change night" signal the
 * moment a retry lands — a run that raced a lucky no-op past it can report
 * `written: 0` while the other run genuinely rewrote something, or vice
 * versa. And every fixture in the window gets asked of the provider twice
 * inside the same window, doubling the request budget for that run rather
 * than the tally simply being wrong. Neither cost corrupts a fixture; both
 * are still worth knowing before leaning on this tally or that budget.
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
