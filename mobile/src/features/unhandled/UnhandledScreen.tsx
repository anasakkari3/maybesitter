import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { fill } from '../../i18n/strings';
import { formatRelativeDay } from '../../i18n/format';
import { isolateAuto } from '../../i18n/bidi';
import { useTimeZone } from '../../i18n/timezone';
import { Btn, Card, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import { HubRow } from '../../ui/hub';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { useCommitmentAction, useDismissUnhandled, useRefreshUnhandled, useUnhandled } from '../../api/queries';
import { ConflictError } from '../../api/errors';
import { markErrorShown } from '../../api/ui/userFacingMessage';
import type { UnhandledItem } from '../../api/schemas/commitments';
import { SettingsHeader } from '../settings/SettingsChrome';
import { PostponeSheetFor } from '../../screens/Sheets';

/**
 * «ما اتصرّفت فيها» (owner decision 2026-11-12, spec Part 1, design item 2,
 * lane E2): appointments that are over and deadlines that passed, which the
 * person never said anything about.
 *
 * ── No pressure, in the layout as well as the words ──────────────
 *
 * There is no "overdue" here and no colour that means one (mobile/AGENTS.md):
 * the reason line is muted text, the cards are the ordinary surface, and
 * nothing is counted against the person. The four answers sit side by side
 * with the same weight — «أسقطه بوعي» is as good an answer as «تمّت», and «لا
 * تسألني عنها» is a third that changes nothing about the item at all.
 *
 * Done, a new date and «أسقطه بوعي» are the commitment's own actions, through
 * the same hook every other screen uses. A second press while one is on its
 * way is disabled; one that lands after the item already left (another device,
 * a double tap) is a 409, and the list simply refetches.
 */
export function UnhandledScreen({ onBack }: { onBack: () => void }) {
  const { t } = useApp();
  const unhandled = useUnhandled();
  const [postponing, setPostponing] = useState<UnhandledItem | null>(null);
  const items = unhandled.data?.items ?? [];

  return (
    <Screen pinned={<SettingsHeader title={t.unhandledTitle} onBack={onBack} />}>
      <ScreenScroll>
        <UnhandledLede />
        <QueryBoundary isPending={unhandled.isPending} error={unhandled.error} onRetry={() => { void unhandled.refetch(); }}>
          {items.length === 0 ? <UnhandledEmpty /> : null}
          {items.map((item) => (
            <UnhandledCard key={item.commitment.id} item={item} onNewDate={() => setPostponing(item)} />
          ))}
        </QueryBoundary>
      </ScreenScroll>
      <PostponeSheetFor
        commitmentId={postponing?.commitment.id ?? null}
        title={postponing?.commitment.title}
        onClose={() => setPostponing(null)}
      />
    </Screen>
  );
}

function UnhandledLede() {
  const { t, p } = useApp();
  return <Txt size={13} color={p.mu} lh={1.5} testID="unhandled-lede">{t.unhandledLede}</Txt>;
}

function UnhandledEmpty() {
  const { t, p } = useApp();
  return (
    <View style={{ padding: 22, backgroundColor: p.sf, borderRadius: 20, alignItems: 'center' }} testID="unhandled-empty">
      <Txt size={14} color={p.mu} align="center">{t.unhandledEmpty}</Txt>
    </View>
  );
}

/** "Ended yesterday" / "Was due Monday": when, never how late. */
export function unhandledReasonLine(
  item: Pick<UnhandledItem, 'reason' | 'since' | 'shownAt'>,
  t: { unhandledEventEnded: string; unhandledDeadlinePassed: string },
  lang: string,
  timeZone: string,
  now: Date = new Date(),
): string {
  const when = isolateAuto(formatRelativeDay(new Date(item.shownAt ?? item.since), { locale: lang as never, timeZone, now }));
  return fill(item.reason === 'event_ended' ? t.unhandledEventEnded : t.unhandledDeadlinePassed, { when });
}

function UnhandledCard({ item, onNewDate }: { item: UnhandledItem; onNewDate: () => void }) {
  const { t, p, lang, actions } = useApp();
  const timeZone = useTimeZone();
  const act = useCommitmentAction();
  const dismiss = useDismissUnhandled();
  const refresh = useRefreshUnhandled();
  const [failed, setFailed] = useState(false);
  const id = item.commitment.id;
  // Held synchronously: two taps inside one frame both see `isPending` false,
  // because the re-render that disables the buttons has not happened yet.
  const inFlight = useRef(false);
  const busy = act.isPending || dismiss.isPending;

  const run = (work: () => Promise<unknown>, toast: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailed(false);
    void work().then(() => actions.toast(toast)).catch((error: unknown) => {
      // Already answered somewhere else: the refetch takes it out of the list.
      if (error instanceof ConflictError) return;
      markErrorShown(error);
      setFailed(true);
    }).finally(() => {
      inFlight.current = false;
      // Every outcome, the silent 409 included: what is in the place is the server's answer.
      refresh();
    });
  };

  return (
    <Card testID={`unhandled-${id}`}>
      <View style={{ gap: 10, alignItems: 'flex-start' }}>
        <Txt size={15} weight={600} lh={1.45} testID={`unhandled-title-${id}`}>{isolateAuto(item.commitment.title)}</Txt>
        <Txt size={13} color={p.mu} testID={`unhandled-reason-${id}`}>{unhandledReasonLine(item, t, lang, timeZone)}</Txt>
        {failed ? <Txt size={13} color={p.wm} testID={`unhandled-failed-${id}`}>{t.errorsGeneric}</Txt> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <UnhandledAction testID={`unhandled-done-${id}`} item={item.commitment.title} label={t.done} disabled={busy}
            onPress={() => run(() => act.mutateAsync({ id, action: 'complete' }), t.toastDone)} />
          <UnhandledAction testID={`unhandled-new-date-${id}`} item={item.commitment.title} label={t.unhandledNewDate} disabled={busy} onPress={onNewDate} />
          <UnhandledAction testID={`unhandled-drop-${id}`} item={item.commitment.title} label={t.dropIt} disabled={busy}
            onPress={() => run(() => act.mutateAsync({ id, action: 'cancel' }), t.toastDrop)} />
          <UnhandledAction testID={`unhandled-dont-ask-${id}`} item={item.commitment.title} label={t.unhandledDontAsk} disabled={busy}
            onPress={() => run(() => dismiss.mutateAsync(id), t.toastUnhandledDismissed)} />
        </View>
      </View>
    </Card>
  );
}

function UnhandledAction({ label, item, onPress, disabled, testID }: {
  label: string;
  /** Named in the accessibility label, so a screen reader says which item this answers. */
  item: string;
  onPress: () => void;
  disabled: boolean;
  testID: string;
}) {
  const { p } = useApp();
  return (
    <Btn
      testID={testID}
      label={`${label}: ${item}`}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityState={{ disabled }}
      scaleTo={0.97}
      style={{
        minHeight: 44, minWidth: 44, justifyContent: 'center',
        backgroundColor: p.sf2, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14,
        opacity: disabled ? 0.5 : 1, alignItems: 'flex-start',
      }}
    >
      <Txt size={13}>{label}</Txt>
    </Btn>
  );
}

/**
 * Today's quiet door into the place: one row, and only when there is
 * something in it. Not a badge, not a colour, not a number in the tab bar.
 */
export function UnhandledEntry() {
  const { tr, actions } = useApp();
  const unhandled = useUnhandled();
  const n = unhandled.data?.items.length ?? 0;
  if (n === 0) return null;
  return (
    <HubRow
      testID="today-unhandled"
      icon="clipboard"
      tone="neutral"
      compact
      title={tr('unhandledEntry', { n })}
      onPress={() => actions.go('unhandled')}
    />
  );
}
