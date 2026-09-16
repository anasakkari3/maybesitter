import { z } from 'zod';
import { isoDateTime } from './common';
import { collisionWarningSchema } from './capture';

/**
 * The two football calls (football fixtures MVP, Task 11).
 *
 * ── Why a club's name is not a bare string ────────────────────────────────
 * `names` mirrors `lib/football/clubs.ts`'s curated `Club.names`: one string
 * per language the app ships. The provider's own name for a club ("FC
 * Barcelona") is Latin-script only, and rendering that on an Arabic screen
 * is exactly the failure this schema exists to make impossible to reach --
 * a screen that reads `club.names[lang]` can never fall back to a name the
 * provider spelled, because that name is not in this shape at all.
 */
export const footballClubSchema = z.object({
  clubId: z.string(),
  providerTeamId: z.string(),
  competition: z.string(),
  names: z.object({ ar: z.string(), he: z.string(), en: z.string() }),
});

export type FootballClub = z.infer<typeof footballClubSchema>;

/**
 * One of this account's currently-active, fixture-linked commitments.
 *
 * There is no `Commitment.origin` field (an earlier task added and withdrew
 * it -- see `lib/football/projectFixtures.ts`'s header), so this is how the
 * client learns "this commitment is one of mine, from the feed, and may be
 * dismissed" -- not a field on `Commitment` itself. `homeTeamName`/
 * `awayTeamName` are the provider's own (Latin-script) strings, not the
 * curated `names` a followed club carries: an opponent is not necessarily a
 * club this app curates at all, so there is no dictionary to translate an
 * arbitrary opponent's name through yet. Showing the raw provider name here
 * is a known limitation, not an oversight -- see task-11-report.md.
 *
 * `collisions` reuses `collisionWarningSchema` from `./capture` -- Task 10's
 * shape for "what this landed on top of" -- rather than a second one defined
 * here. The server computes it the same way capture-confirm does
 * (`findCollisions` against this account's other active commitments), so the
 * wire shape is the one thing that should never fork. Optional for the same
 * reason `capture.ts`'s copy is: an older client must keep parsing a response
 * from a server that has always sent it, and a server that has not shipped
 * this field yet must not break a newer client either.
 */
export const footballFixtureSchema = z.object({
  commitmentId: z.string(),
  homeTeamName: z.string(),
  awayTeamName: z.string(),
  kickoffUtc: isoDateTime,
  collisions: collisionWarningSchema.array().optional(),
});

export type FootballFixture = z.infer<typeof footballFixtureSchema>;

/** Mirrors both `GET` and `PUT /api/mobile/football` -- one shape, one schema. */
export const footballSettingsResponseSchema = z.object({
  success: z.literal(true),
  clubs: z.array(footballClubSchema),
  followedClubIds: z.array(z.string()),
  fixtures: z.array(footballFixtureSchema),
});

export type FootballSettingsResponse = z.infer<typeof footballSettingsResponseSchema>;

/** Mirrors `DELETE /api/mobile/football/fixtures/{commitmentId}`. */
export const footballFixtureDismissedSchema = z.object({
  success: z.literal(true),
  id: z.string(),
  dismissed: z.boolean(),
});

export type FootballFixtureDismissed = z.infer<typeof footballFixtureDismissedSchema>;
