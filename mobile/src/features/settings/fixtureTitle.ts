import type { FootballClub, FootballFixture } from '../../api/schemas/football';

/**
 * What a match is called on the football settings screen: `"<home> – <away>"`,
 * a curated club under its name in the active language and any other team
 * under the provider's name.
 *
 * The same rule as `fixtureTitle` in `lib/football/clubs.ts`, which the server
 * uses to write the commitment's title -- so this row, the calendar entry and
 * Today name a match the same way. It is repeated here rather than imported
 * because the app cannot import server code; the curated names come from the
 * same list, sent by the same route.
 */
export function fixtureTitle(
  fixture: Pick<FootballFixture, 'homeTeamId' | 'awayTeamId' | 'homeTeamName' | 'awayTeamName'>,
  clubs: readonly FootballClub[],
  lang: 'ar' | 'he' | 'en',
): string {
  const nameOf = (teamId: string | undefined, providerName: string) => {
    const club = teamId ? clubs.find((candidate) => candidate.providerTeamId === teamId) : undefined;
    return club ? club.names[lang] : providerName;
  };
  return `${nameOf(fixture.homeTeamId, fixture.homeTeamName)} – ${nameOf(fixture.awayTeamId, fixture.awayTeamName)}`;
}
