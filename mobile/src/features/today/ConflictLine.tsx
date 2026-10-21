import React, { useMemo } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useFootballSettings } from '../../api/queries';
import { useTimeZone } from '../../i18n/timezone';
import { formatTime, formatTimeRange } from '../../i18n/format';
import { fill, ltr } from '../../i18n/strings';
import { isolateAuto } from '../../i18n/bidi';
import { Btn, Pill, Txt } from '../../ui/primitives';
import { ActionRow } from '../../ui/chrome';
import { BottomSheet, SheetHeader } from '../../ui/bottomSheet';
import { useReferencePalette } from '../../ui/referenceDesign';
import type { TodayConflict } from './todayConflict';

/** The sentence under the title: the busy range, or the all-day wording when that is all there is. */
/**
 * A weekly fixed block reaches the day's busy time with a `weekly:` id
 * (`occurrencesAsBusy`). It is the person's own fixed time, not an event in a
 * calendar, and is named so (M6b BB-01: «موعد بتقويمك» with no calendar
 * connected).
 */
export function isFixedBlock(conflict: TodayConflict): boolean {
  return conflict.block.nativeId?.startsWith('weekly:') === true;
}

/**
 * A range inside a sentence, its dash held to both times by word joiners: the
 * line may otherwise break after the en dash and leave «10:00–» on one line and
 * «12:00» on the next (M6b BB-02). The joiners are default-ignorable.
 */
export function unbreakableRange(range: string): string {
  return range.replace(/–/g, '\u2060–\u2060');
}

function busySentence(conflict: TodayConflict, t: ReturnType<typeof useApp>['t'], lang: ReturnType<typeof useApp>['lang'], timeZone: string): string {
  if (conflict.block.allDay) return t.calendarBusyConflictAllDay;
  const range = unbreakableRange(formatTimeRange(new Date(conflict.block.startAt), new Date(conflict.block.endAt), { locale: lang, timeZone }));
  return fill(isFixedBlock(conflict) ? t.fixedBlockConflict : t.calendarBusyConflict, { range });
}

/**
 * The first thing on Today when something clashes (Stitch): the item and its
 * hour on one line, what it runs into on the next, «شوف التعارض» at the end.
 *
 * Two whole lines, never truncated — the reason it is a line and not a chip.
 * A tap explains the clash in a sheet; it does not postpone anything, because
 * people double-book on purpose and a calendar is not a court (`conflicts.ts`).
 */
export function ConflictLine({ conflict, onOpen }: { conflict: TodayConflict; onOpen: () => void }) {
  const { t, lang } = useApp();
  const p = useReferencePalette();
  const timezone = useTimeZone();
  const time = ltr(formatTime(new Date(conflict.at), { locale: lang, timeZone: timezone }));
  const sentence = busySentence(conflict, t, lang, timezone);
  return (
    <Btn
      testID="today-conflict"
      label={`${isolateAuto(conflict.item.title)} ${time}. ${sentence}. ${t.todayConflictOpen}`}
      onPress={onOpen}
      scaleTo={0.99}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 64,
        paddingVertical: 12, paddingHorizontal: 14, borderRadius: 18,
        backgroundColor: p.sf, borderWidth: 1, borderColor: p.prop,
      }}
    >
      <View accessible={false} style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: p.wm, alignSelf: 'flex-start', marginTop: 6 }} />
      <View style={{ flex: 1, gap: 2, alignItems: 'flex-start' }}>
        <Txt size={13} weight={600} color={p.tx} testID="today-conflict-title">{`${isolateAuto(conflict.item.title)} ${time}`}</Txt>
        <Txt size={13} color={p.mu} testID="today-conflict-busy">{sentence}</Txt>
      </View>
      <View style={{ minHeight: 44, justifyContent: 'center' }}>
        <Txt size={13} weight={600} color={p.acd}>{t.todayConflictOpen}</Txt>
      </View>
    </Btn>
  );
}

/**
 * «تعارض بالمواعيد»: what clashes with what, in one sentence, and two ways
 * out — open the item (where its time is changed) or leave it. Nothing is
 * changed from here.
 */
export function ConflictSheet({ conflict, onClose }: { conflict: TodayConflict | null; onClose: () => void }) {
  const { t, lang, actions } = useApp();
  const p = useReferencePalette();
  const timezone = useTimeZone();
  return (
    <BottomSheet visible={conflict !== null} onClose={onClose} testID="today-conflict-sheet">
      {conflict ? (
        <>
          <SheetHeader title={t.todayConflictTitle} icon="alert" tone="attention" onClose={onClose} closeTestID="today-conflict-close" />
          <View style={{ backgroundColor: p.sf2, borderRadius: 18, borderWidth: 1, borderColor: p.ln, padding: 16, gap: 8 }}>
            <Txt size={15} lh={1.6} testID="today-conflict-explain">
              {fill(conflict.block.allDay ? t.todayConflictBodyAllDay : isFixedBlock(conflict) ? t.fixedBlockConflictBody : t.todayConflictBody, {
                title: isolateAuto(conflict.item.title),
                time: ltr(formatTime(new Date(conflict.at), { locale: lang, timeZone: timezone })),
                range: conflict.block.allDay ? '' : formatTimeRange(new Date(conflict.block.startAt), new Date(conflict.block.endAt), { locale: lang, timeZone: timezone }),
              })}
            </Txt>
            <Txt size={13} color={p.mu} lh={1.5}>{t.todayConflictHint}</Txt>
          </View>
          <ActionRow>
            <Pill testID="today-conflict-keep" label={t.todayConflictKeep} kind="soft" size={15} pad={12} onPress={onClose} />
            <Pill testID="today-conflict-open-item" label={t.todayConflictOpenItem} size={15} pad={12} onPress={() => { onClose(); actions.openDetail(conflict.item.id); }} />
          </ActionRow>
        </>
      ) : null}
    </BottomSheet>
  );
}

/**
 * The commitments that are football matches (closure CL-football): a fixture
 * is projected as an ordinary commitment, and the football route lists which
 * ones. Today draws those with a ball instead of a completion circle. Empty
 * until the route answers, and when football is not set up at all.
 */
export function useFootballCommitmentIds(): ReadonlySet<string> {
  const data = useFootballSettings().data;
  return useMemo(() => new Set((data?.fixtures ?? []).map((fixture) => fixture.commitmentId)), [data]);
}
