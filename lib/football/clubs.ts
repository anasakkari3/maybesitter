/**
 * The curated club list (Sprint, football fixtures MVP, Task 4).
 *
 * ── What this is for ───────────────────────────────────────────────────────
 * The MVP does not let a user search every club in the world -- it offers a
 * short, hand-picked list and lets them pick from it. This module is that
 * list, loaded once from `data/footballClubs.json` and exposed as
 * `listClubs()` / `clubById()`.
 *
 * ── Accuracy over length ────────────────────────────────────────────────────
 * A wrong `providerTeamId` is not a cosmetic bug: `footballDataProvider.ts`
 * (`lib/football/footballDataProvider.ts`) trusts this id completely and
 * fetches whatever club football-data.org has filed under it. A user who
 * follows "Real Madrid" but silently receives Sevilla's fixtures has no way
 * to notice, and no test in this codebase would catch it either -- the fetch
 * succeeds, the fixtures normalize, they are just the wrong team's fixtures.
 * That is why this list is short rather than exhaustive: every row below was
 * checked against football-data.org's own v4 documentation examples
 * (`docs.football-data.org/general/v4/{competition,team,match,person}.html`,
 * which embed real ids alongside real club names -- e.g. the `competition`
 * page's standings example shows `"id": 81, "name": "FC Barcelona"` and
 * `"id": 65, "name": "Manchester City FC"` directly) or, where the docs
 * didn't happen to name that club, against several independent open-source
 * projects that hardcode the same id for the same club (a repo named for the
 * club, e.g. a "bvb-kalender" project pinning `TEAM_ID = 4` for Borussia
 * Dortmund, is strong evidence precisely because the author had no reason to
 * get their own team's id wrong). A club whose id could not be corroborated
 * this way was left out rather than guessed -- see the Task 4 report for the
 * per-club account of what was checked and what was deliberately dropped.
 *
 * To extend this list safely later: find the id the same way (the vendor's
 * own docs first, independent corroboration second), and add the Arabic and
 * Hebrew names as the names those languages actually use for the club, not a
 * transliteration invented at the keyboard -- verified against Arabic/Hebrew
 * sports coverage (kooora.com, ynet.co.il, sport5.co.il), not assumed.
 *
 * ── Fail loud, not quiet ───────────────────────────────────────────────────
 * `validateClub` throws the moment it finds a malformed row, and that throw
 * happens at module load, synchronously, before `listClubs()` or
 * `clubById()` can return anything. The alternative -- skip the bad row and
 * keep going, the way `footballDataProvider.normalizeMatch` skips one bad
 * *match* -- is right for a live API response where one bad row among
 * hundreds is normal and the other 19 still deserve to load. It is wrong
 * here: this file is hand-edited by a person, not machine-generated at
 * volume, so a malformed row is a typo in a commit, not noise in a feed. The
 * failure mode of silently dropping it is a club a user can never follow --
 * it just isn't in the list, with nothing in any log to say why.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** The three languages every club must be able to say its own name in. */
const REQUIRED_LANGUAGES = ['ar', 'he', 'en'] as const;
type ClubLanguage = (typeof REQUIRED_LANGUAGES)[number];

export interface Club {
  readonly clubId: string;
  readonly providerTeamId: string;
  readonly competition: string;
  readonly names: { readonly ar: string; readonly he: string; readonly en: string };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates one raw row and returns it typed as a `Club`, or throws.
 *
 * Every failure names the row's `clubId` (or its index, if even that is
 * missing) and exactly what was wrong with it -- this throws at module load,
 * off the critical path of any request, so there is no reason to make the
 * next person guess which of fifteen rows broke.
 */
function validateClub(raw: unknown, index: number): Club {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`footballClubs.json row ${index} is not an object`);
  }
  const row = raw as Record<string, unknown>;
  // Every message after this point can name the club by id, even one whose
  // *other* fields are broken -- only a missing/blank id itself falls back
  // to the row index.
  const label = isNonEmptyString(row.clubId) ? row.clubId : `row ${index}`;

  if (!isNonEmptyString(row.clubId)) {
    throw new Error(`footballClubs.json ${label} is missing a non-empty "clubId"`);
  }
  if (!isNonEmptyString(row.providerTeamId)) {
    throw new Error(`footballClubs.json club "${label}" is missing a non-empty "providerTeamId"`);
  }
  if (!isNonEmptyString(row.competition)) {
    throw new Error(`footballClubs.json club "${label}" is missing a non-empty "competition"`);
  }
  if (typeof row.names !== 'object' || row.names === null) {
    throw new Error(`footballClubs.json club "${label}" is missing its "names" object`);
  }
  const names = row.names as Record<string, unknown>;
  for (const lang of REQUIRED_LANGUAGES) {
    if (!isNonEmptyString(names[lang])) {
      throw new Error(`footballClubs.json club "${label}" is missing its "${lang}" name`);
    }
  }

  return {
    clubId: row.clubId,
    providerTeamId: row.providerTeamId,
    competition: row.competition,
    names: {
      ar: names.ar as string,
      he: names.he as string,
      en: names.en as string,
    },
  };
}

function checkNoDuplicates(clubs: readonly Club[], key: 'clubId' | 'providerTeamId'): void {
  const seen = new Set<string>();
  for (const club of clubs) {
    const value = club[key];
    if (seen.has(value)) {
      // Duplicate providerTeamId is the sharper failure -- see the module
      // comment -- but duplicate clubId is caught the same way, for the same
      // reason: whichever one loses the collision, the other silently
      // disappears from `clubById`.
      throw new Error(`footballClubs.json has more than one club with ${key} "${value}"`);
    }
    seen.add(value);
  }
}

function loadClubsRaw(): unknown {
  try {
    const clubsPath = fileURLToPath(new URL('../../data/footballClubs.json', import.meta.url));
    return JSON.parse(readFileSync(clubsPath, 'utf8'));
  } catch {
    const fallbackPath = join(process.cwd(), 'data', 'footballClubs.json');
    return JSON.parse(readFileSync(fallbackPath, 'utf8'));
  }
}

function loadClubs(): readonly Club[] {
  const raw: unknown = loadClubsRaw();
  if (!Array.isArray(raw)) {
    throw new Error('footballClubs.json must be a JSON array');
  }
  const clubs = raw.map((row, index) => validateClub(row, index));
  checkNoDuplicates(clubs, 'clubId');
  checkNoDuplicates(clubs, 'providerTeamId');
  return Object.freeze(clubs);
}

// Loaded and validated once, at import time. A malformed file fails every
// caller identically and immediately, rather than letting some callers
// through before the bad row is reached.
const CLUBS: readonly Club[] = loadClubs();

const CLUBS_BY_ID: ReadonlyMap<string, Club> = new Map(CLUBS.map((club) => [club.clubId, club]));

export function listClubs(): readonly Club[] {
  return CLUBS;
}

/** `null` for an unknown id -- picking from a curated list is not a place a missing row should throw. */
export function clubById(clubId: string): Club | null {
  return CLUBS_BY_ID.get(clubId) ?? null;
}

const CLUBS_BY_PROVIDER_TEAM_ID: ReadonlyMap<string, Club> = new Map(CLUBS.map((club) => [club.providerTeamId, club]));

/** `null` when the provider's team is not one of the curated clubs -- most opponents are not. */
export function clubByProviderTeamId(providerTeamId: string): Club | null {
  return CLUBS_BY_PROVIDER_TEAM_ID.get(providerTeamId) ?? null;
}

/** The two sides of a match, as a fixture (or a ref copied from one) carries them. */
export interface FixtureTeams {
  readonly homeTeamId?: string | null;
  readonly awayTeamId?: string | null;
  readonly homeTeamName: string;
  readonly awayTeamName: string;
}

function teamName(teamId: string | null | undefined, providerName: string, language: ClubLanguage): string {
  const club = teamId ? clubByProviderTeamId(teamId) : null;
  return club ? club.names[language] : providerName;
}

/**
 * What a match is called on every surface: `"<home> – <away>"`.
 *
 * A curated club is named the way the chosen language names it (the Arabic
 * and Hebrew names in `footballClubs.json` were checked against sports
 * coverage in those languages); any other team keeps the provider's own name,
 * because a transliteration invented here would be a guess. Home first, the
 * way a fixture list prints it in all three languages.
 *
 * Used by the server projection to write `Commitment.title` and by the mobile
 * settings screen for its own rows, so the two cannot name a match
 * differently.
 */
export function fixtureTitle(teams: FixtureTeams, language: ClubLanguage): string {
  return `${teamName(teams.homeTeamId, teams.homeTeamName, language)} – ${teamName(teams.awayTeamId, teams.awayTeamName, language)}`;
}

export type { ClubLanguage };
