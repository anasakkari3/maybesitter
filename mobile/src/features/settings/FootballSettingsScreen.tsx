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
import type { Clash, HeldFixture } from '../../api/schemas/m4b';
import { HeldChangedError } from '../../api/errors';
import { dayKey } from '../../i18n/format';
import { isolateAuto, stripIsolates } from '../../i18n/bidi';
import { useM4bCapabilities } from '../m4b/capabilities';
import { useDecideHeldFixture } from '../m4b/heldFixtures';
import { clashLine } from '../m4b/clashLine';
import { LiveRegion } from '../../ui/liveRegion';
import { useAnnounceOnIos } from '../../ui/announce';

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
  const decideHeld = useDecideHeldFixture();
  // M4b: the probe is read with the screen (fail closed). The held section
  // itself shows only what the server sent: `held` is absent when it is off.
  // Gated twice (M4B-A-001): the server sends these fields only when the
  // capability is on, and a cached copy is drawn only while the latest
  // successful probe still says it is on.
  const holdOn = useM4bCapabilities()?.externalClashHold === true;
  const held = holdOn ? settings.data?.held ?? [] : [];
  const waitingForCoverage = holdOn ? settings.data?.waitingForCoverage ?? 0 : 0;
  const heldChanged = decideHeld.error instanceof HeldChangedError;
  useAnnounceOnIos(heldChanged ? t.zHeldChanged : null);

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

  const clashLines = useCallback((key: string, kickoffUtc: string, clashes: readonly Clash[]) => {
    const subjectDay = dayKey(new Date(kickoffUtc), timezone);
    return clashes.map((clash, index) => (
      <Txt key={`${key}-${index}`} size={13} color={p.wm} testID={`football-fixture-clash-${key}-${index}`}>
        {clashLine(clash, { t, lang, timezone, subjectDay })}
      </Txt>
    ));
  }, [lang, p.wm, t, timezone]);

  const matchLine = useCallback((fixture: Pick<FootballFixture, 'kickoffUtc'>): string => {
    const kickoff = new Date(fixture.kickoffUtc);
    const date = formatDate(kickoff, 'short', { locale: lang, timeZone: timezone });
    const time = formatTime(kickoff, { locale: lang, timeZone: timezone });
    return `${isolateAuto(date)} · ${ltr(time)}`;
  }, [lang, timezone]);

  return (
    <Screen pinned={<SettingsHeader title={t.footballTitle} onBack={onBack} />}>
      <ScreenScroll>
        <Card pad={18}>
          <Txt size={15} color={p.mu} lh={1.5}>{t.footballBody}</Txt>
        </Card>

        {/* First on the screen (simulator pass SIM-B2): the person arrives from
            «في شغلة بتستنى قرارك», so the decision is what they see, not the
            club list above it. */}
        {/* Mounted always (M4B-A-006): TalkBack hears a change inside a live
            region that is already there, even when the last held row goes. */}
        <LiveRegion>
          {heldChanged ? <Txt size={13} color={p.wm} testID="football-held-changed">{t.zHeldChanged}</Txt> : null}
        </LiveRegion>
        {held.length > 0 ? (
          <Card pad={0} style={{ overflow: 'hidden' }} testID="football-held-section">
            <View style={{ paddingTop: 16, paddingHorizontal: 18 }}>
              <Txt size={15} weight={700} role="section">{t.zHeldSection}</Txt>
            </View>
            {held.map((entry: HeldFixture) => {
              const title = isolateAuto(fixtureTitle(entry, clubs, lang));
              const when = matchLine(entry);
              const headline = (entry.moved ? fill(t.zHeldMoved, { title, when, clash: '' }) : fill(t.zHeldMatch, { title, when, clash: '' })).trim();
              return (
                <View key={entry.fixtureId} testID={`football-held-${entry.fixtureId}`} style={{ paddingVertical: 14, paddingHorizontal: 18, gap: 6, borderTopWidth: 1, borderTopColor: p.ln, marginTop: 10 }}>
                  <Txt size={15}>{headline}</Txt>
                  {clashLines(entry.fixtureId, entry.kickoffUtc, entry.clashes)}
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                    <Btn
                      label={stripIsolates(fill(t.zHeldAddA11y, { title }))}
                      testID={`football-held-add-${entry.fixtureId}`}
                      disabled={decideHeld.isPending}
                      onPress={() => decideHeld.mutate({ fixtureId: entry.fixtureId, action: 'add', heldVersion: entry.heldVersion })}
                      scaleTo={0.97}
                      style={{ minHeight: 44, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 14, backgroundColor: p.ac, justifyContent: 'center' }}
                    >
                      <Txt size={14} weight={700} color={p.onAccent}>{t.zHeldAdd}</Txt>
                    </Btn>
                    <Btn
                      label={stripIsolates(fill(t.zHeldDismissA11y, { title }))}
                      testID={`football-held-dismiss-${entry.fixtureId}`}
                      disabled={decideHeld.isPending}
                      onPress={() => decideHeld.mutate({ fixtureId: entry.fixtureId, action: 'dismiss', heldVersion: entry.heldVersion })}
                      scaleTo={0.97}
                      style={{ minHeight: 44, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1, borderColor: p.ln, justifyContent: 'center' }}
                    >
                      <Txt size={14} color={p.tx}>{t.zHeldDismiss}</Txt>
                    </Btn>
                  </View>
                </View>
              );
            })}
          </Card>
        ) : null}

        {waitingForCoverage > 0 ? (
          <Txt size={13} color={p.mu} testID="football-coverage-note">{t.zHeldCoverageNote}</Txt>
        ) : null}

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
                {holdOn && fixture.clashes !== undefined ? clashLines(fixture.commitmentId, fixture.kickoffUtc, fixture.clashes) : fixture.collisions && fixture.collisions.length > 0 ? (
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
