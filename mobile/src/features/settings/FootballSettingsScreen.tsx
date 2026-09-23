import React, { useCallback } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { formatDate, formatTime } from '../../i18n/format';
import { fill, ltr } from '../../i18n/strings';
import { fixtureTitle } from './fixtureTitle';
import { Btn, Card, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import { SettingsHeader } from './SettingsChrome';
import { useDismissFixture, useFootballSettings, useSetFollowedClubs } from '../../api/queries';
import type { FootballFixture } from '../../api/schemas/football';

/**
 * Settings → Football (football fixtures MVP, Task 11).
 *
 * "If I love Barcelona, I want to see all of the games" — the owner's own
 * request. This screen is the whole loop: pick clubs from the curated list,
 * see the matches that following them just put on the calendar, and take
 * back the one match you don't want without unfollowing the club over it.
 *
 * ── Club names come from the curated list, never the provider ────────────
 * `club.names[lang]` is `lib/football/clubs.ts`'s hand-checked name for the
 * active language — never football-data.org's own (Latin-script-only) name.
 * An Arabic screen that fell back to the provider's name would say "FC
 * Barcelona" instead of برشلونة, which is exactly the failure the schema in
 * `api/schemas/football.ts` is shaped to make unreachable.
 *
 * ── There is no separate "Save" step ──────────────────────────────────────
 * Tapping a club saves the whole list immediately, the same way the calendar
 * settings screen's calendar picker saves on tap rather than behind a
 * confirm button. The server projects synchronously on that same request
 * (see the route's own header), so the response this tap gets back already
 * carries the first match, if the store had one to give.
 *
 * ── Why the dismiss action never appears on a commitment the user typed ───
 * There is no `Commitment.origin` field to check (see
 * `lib/football/projectFixtures.ts`'s header for why it was added and
 * withdrawn). This screen only ever renders a dismiss action next to a row
 * in `fixtures`, the account's own currently-active, fixture-linked
 * commitments the server computed by joining the external task references —
 * a commitment the user typed by hand never appears in that list, so there
 * is no row here to attach a dismiss button to in the first place. The
 * route is the second line of defence: it 404s if this ever raced anyway.
 */
export function FootballSettingsScreen({ onBack }: { onBack: () => void }) {
  const { t, p, lang } = useApp();
  const timezone = useTimeZone();
  const settings = useFootballSettings();
  const setFollowed = useSetFollowedClubs();
  const dismiss = useDismissFixture();

  const followedClubIds = settings.data?.followedClubIds ?? [];
  const followedSet = new Set(followedClubIds);
  const clubs = settings.data?.clubs ?? [];
  const fixtures = settings.data?.fixtures ?? [];

  // The next list is built from the latest saved answer inside the mutation,
  // not from what this render shows -- see `useSetFollowedClubs`. The error
  // is shown below the list, so the promise's rejection is handled there.
  const toggle = useCallback((clubId: string) => {
    setFollowed.mutateAsync({ clubId, locale: lang }).catch(() => {});
  }, [lang, setFollowed]);

  const dismissMatch = useCallback((commitmentId: string) => {
    void dismiss.mutateAsync(commitmentId);
  }, [dismiss]);

  const matchLine = useCallback((fixture: FootballFixture): string => {
    const kickoff = new Date(fixture.kickoffUtc);
    const date = formatDate(kickoff, 'short', { locale: lang, timeZone: timezone });
    const time = formatTime(kickoff, { locale: lang, timeZone: timezone });
    return `${date} · ${ltr(time)}`;
  }, [lang, timezone]);

  return (
    <Screen pinned={<SettingsHeader title={t.footballTitle} onBack={onBack} />}>
      <ScreenScroll>
        <Card pad={18}>
          <Txt size={15} color={p.mu} lh={1.5}>{t.footballBody}</Txt>
        </Card>

        <Card pad={0} style={{ overflow: 'hidden' }} testID="football-club-list">
          {settings.isLoading ? (
            <View style={{ padding: 18, alignItems: 'center' }}>
              <ActivityIndicator color={p.ac} />
            </View>
          ) : (
            clubs.map((club, index) => {
              const following = followedSet.has(club.clubId);
              return (
                <Btn
                  key={club.clubId}
                  label={club.names[lang]}
                  testID={`football-club-${club.clubId}`}
                  onPress={() => toggle(club.clubId)}
                  scaleTo={0.98}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingVertical: 16,
                    paddingHorizontal: 18,
                    minHeight: 52,
                    borderTopWidth: index === 0 ? 0 : 1,
                    borderTopColor: p.ln,
                  }}
                >
                  <Txt size={15}>{club.names[lang]}</Txt>
                  {following ? <Txt size={13} color={p.ac}>{t.footballFollowing}</Txt> : null}
                </Btn>
              );
            })
          )}
        </Card>

        {setFollowed.isError ? (
          <Txt size={13} color={p.wm} testID="football-save-failed">{t.footballSaveFailed}</Txt>
        ) : null}

        {fixtures.length > 0 ? (
          <Card pad={0} style={{ overflow: 'hidden' }} testID="football-fixture-list">
            {fixtures.map((fixture, index) => (
              <View
                key={fixture.commitmentId}
                style={{
                  paddingVertical: 14,
                  paddingHorizontal: 18,
                  gap: 6,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: p.ln,
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt size={15}>{fixtureTitle(fixture, clubs, lang)}</Txt>
                    <Txt size={13} color={p.mu}>{matchLine(fixture)}</Txt>
                  </View>
                  <Btn
                    label={t.footballDismiss}
                    testID={`football-dismiss-${fixture.commitmentId}`}
                    onPress={() => dismissMatch(fixture.commitmentId)}
                    scaleTo={0.97}
                    style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: p.ln }}
                  >
                    <Txt size={13} color={p.mu}>{t.footballDismiss}</Txt>
                  </Btn>
                </View>
                {fixture.collisions && fixture.collisions.length > 0 ? (
                  <Txt size={13} color={p.wm} testID={`football-collision-${fixture.commitmentId}`}>
                    {fill(t.footballCollision, { titles: fixture.collisions.map((collision) => collision.title).join(lang === 'ar' ? '، ' : ', ') })}
                  </Txt>
                ) : null}
              </View>
            ))}
          </Card>
        ) : null}

        {/* The provider's free tier requires this on screen, not only in a
            code comment -- see task-11-report.md's decision log. */}
        <Txt size={12} color={p.mu} testID="football-attribution">{t.footballAttribution}</Txt>
      </ScreenScroll>
    </Screen>
  );
}
