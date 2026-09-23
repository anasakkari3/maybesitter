import React, { useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { formatDate } from '../../i18n/format';
import { ltr } from '../../i18n/strings';
import { useTimeZone } from '../../i18n/timezone';
import { Btn, Card, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { useDeleteSeed, usePatchSeed, usePromoteSeed, useSeeds } from '../../api/queries';
import type { Seed } from '../../api/schemas/seeds';
import { SettingsHeader } from '../settings/SettingsChrome';
import { hasRevisit, liveSeeds, seedKindLabel, seedStatusLabel } from './seedDisplay';

/**
 * "Considering / Waiting" — the things the person has not decided on (#519).
 *
 * ── Why this is not a list of tasks with a different colour ──────
 *
 * Nothing here has an importance, a time, or a place in the day. That is the
 * whole point of a Seed: «يمكن أقدّم على NVIDIA هالفصل» is not a Must, a
 * Should or a Nice, and asking somebody to rank a thought they have not had
 * yet is the product pushing them towards deciding. So there is no
 * `ImpBadge`, no time, and no ordering by anything but when they kept it.
 *
 * ── The line that has to be on the screen ────────────────────────
 *
 * `seedsNotCommitment` — "This is not a commitment yet" — is unconditional,
 * for the same reason `suggestionNote` is unconditional on Review. Somebody
 * looking at a list of their own sentences inside a reminders app will
 * reasonably assume the app is going to remind them about them, and it is not.
 *
 * ── Four actions, and one of them is a door ──────────────────────
 *
 * Turn into a task, turn into a goal, later, dismiss. The first two leave this
 * screen and go through the ordinary confirmation boundaries on the server;
 * nothing about them happens here, and nothing about them happens without the
 * person pressing. "Later" sets the person's own revisit marker, which means
 * "bring this back to me" and never "this is due".
 */
export function SeedsScreen({ onBack }: { onBack: () => void }) {
  const { t, p, lang } = useApp();
  const seeds = useSeeds();
  const strings = t as unknown as Record<string, string>;

  const items = liveSeeds(seeds.data?.items ?? []);

  return (
    <Screen pinned={<SettingsHeader title={t.seedsTitle} onBack={onBack} />}>
      <ScreenScroll>
        <Txt size={13} color={p.mu} testID="seeds-lede">{t.seedsLede}</Txt>
        {/* Unconditional, like Review's suggestion note. */}
        <Txt size={12} color={p.mu} testID="seeds-not-commitment">{t.seedsNotCommitment}</Txt>

        <QueryBoundary
          isPending={seeds.isPending}
          error={seeds.error}
          onRetry={() => { void seeds.refetch(); }}
        >
          {items.length === 0 ? (
            <View style={{ padding: 26, backgroundColor: p.sf, borderRadius: 18 }} testID="seeds-empty">
              <Txt size={14} color={p.mu} align="center">{t.seedsEmpty}</Txt>
            </View>
          ) : null}
          {items.map((seed) => (
            <SeedCard key={seed.seedId} seed={seed} strings={strings} lang={lang} />
          ))}
        </QueryBoundary>
      </ScreenScroll>
    </Screen>
  );
}

function SeedCard({ seed, strings, lang }: { seed: Seed; strings: Record<string, string>; lang: string }) {
  const { t, p } = useApp();
  const timeZone = useTimeZone();
  const patch = usePatchSeed();
  const promote = usePromoteSeed();
  const remove = useDeleteSeed();
  const [failed, setFailed] = useState(false);
  const busy = patch.isPending || promote.isPending || remove.isPending;
  const statusLine = seedStatusLabel(seed, strings);

  const run = (work: () => Promise<unknown>) => {
    setFailed(false);
    void work().catch(() => setFailed(true));
  };

  return (
    <Card testID={`seed-${seed.seedId}`}>
      <View style={{ gap: 10 }}>
        <Txt size={11} color={p.mu} testID={`seed-kind-${seed.seedId}`}>{seedKindLabel(seed.kind, strings)}</Txt>
        {/* The person's own sentence, as they wrote it. */}
        <Txt size={15} lh={1.45} testID={`seed-summary-${seed.seedId}`}>{seed.summary}</Txt>
        {statusLine ? <Txt size={12} color={p.mu}>{statusLine}</Txt> : null}
        {hasRevisit(seed) ? (
          <Txt size={12} color={p.mu} testID={`seed-revisit-${seed.seedId}`}>
            {(t.seedRevisitOn ?? '').replace('{date}', ltr(formatDate(new Date(seed.revisitAt as string), 'short', { locale: lang as never, timeZone })))}
          </Txt>
        ) : null}
        {failed ? (
          <Txt size={12} color={p.wm} testID={`seed-failed-${seed.seedId}`}>{t.errorsGeneric}</Txt>
        ) : null}

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <SeedAction
            testID={`seed-to-task-${seed.seedId}`}
            label={t.seedToTask}
            disabled={busy}
            onPress={() => run(() => promote.mutateAsync({ id: seed.seedId, target: 'commitment' }))}
          />
          <SeedAction
            testID={`seed-to-goal-${seed.seedId}`}
            label={t.seedToGoal}
            disabled={busy}
            onPress={() => run(() => promote.mutateAsync({ id: seed.seedId, target: 'goal' }))}
          />
          <SeedAction
            testID={`seed-later-${seed.seedId}`}
            label={t.seedLater}
            disabled={busy}
            onPress={() => run(() => patch.mutateAsync({ id: seed.seedId, status: 'snoozed' }))}
          />
          <SeedAction
            testID={`seed-dismiss-${seed.seedId}`}
            label={t.seedDismiss}
            disabled={busy}
            // Dismiss, not delete: the row is kept so the person can see they
            // dropped it on purpose, and the export still carries it. Removing
            // it outright is the DELETE route, which nothing on this screen
            // reaches by accident.
            onPress={() => run(() => patch.mutateAsync({ id: seed.seedId, status: 'dismissed' }))}
          />
        </View>
      </View>
    </Card>
  );
}

function SeedAction({
  label, onPress, disabled, testID,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  testID: string;
}) {
  const { p } = useApp();
  return (
    <Btn
      testID={testID}
      label={label}
      onPress={onPress}
      disabled={disabled}
      scaleTo={0.97}
      style={{
        backgroundColor: p.sf2,
        borderRadius: 14,
        paddingVertical: 9,
        paddingHorizontal: 14,
        opacity: disabled ? 0.5 : 1,
        alignItems: 'flex-start',
      }}
    >
      <Txt size={13}>{label}</Txt>
    </Btn>
  );
}
