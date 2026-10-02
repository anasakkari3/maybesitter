import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { formatTime, formatTimeRange } from '../../i18n/format';
import { fill, ltr } from '../../i18n/strings';
import { isolateAuto } from '../../i18n/bidi';
import { useLayoutMode, useTextScale } from '../../theme/textScale';
import { Btn, Txt } from '../../ui/primitives';
import { Tag, priorityTagKind } from '../../ui/chrome';
import { Hatch } from '../../ui/icons';
import { ReferenceIcon } from '../../ui/referenceIcons';
import { CountChip } from '../../ui/hub';
import type { MeetingPrepTarget } from '../../state/types';
import type { WeeklyBlockOccurrence } from '../../api/schemas/weeklyBlocks';
import type { CommitmentView } from '../commitments/model';
import { rowAccessibilityLabel } from '../commitments/accessibility';
import { WeeklyOccurrenceRow } from '../weeklyBlocks/WeeklyOccurrenceRow';
import type { DeviceBusyBlock } from './busyBlocks';
import { HOUR_HEIGHT, hourWindow, minuteOfDay, placeSpans, yOf, type TimelineSpan } from './dayTimeline';

/**
 * The selected day on the Plan tab (Stitch `02-plan`): the proportional
 * timeline at ordinary text sizes, a list in time order at the large ones,
 * and «التزامات بلا وقت» under either.
 *
 * Busy time from the person's calendar is drawn as «مشغول (من التقويم)» and a
 * time range — never an event's name: the product only ever reads *when* the
 * person is busy (`calendarReadBody`). Weekly fixed blocks are the person's
 * own words, so their titles show.
 */

export type PlanRow =
  | { kind: 'commitment'; key: string; at: number; item: CommitmentView; clock: string | null; due: string | null; conflict: DeviceBusyBlock | null }
  | { kind: 'busy'; key: string; at: number; block: DeviceBusyBlock; prep: MeetingPrepTarget | null }
  | { kind: 'weekly'; key: string; at: number; occurrence: WeeklyBlockOccurrence };

/** The gutter the hour labels sit in, at the start edge. */
const GUTTER = 52;

function importanceLook(importance: CommitmentView['importance'], p: ReturnType<typeof useApp>['p']) {
  return importance === 'must'
    ? { bg: p.acs, fg: p.acd }
    : importance === 'should' ? { bg: p.wms, fg: p.wm } : { bg: p.successSoft, fg: p.success };
}

function importanceWord(importance: CommitmentView['importance'], t: ReturnType<typeof useApp>['t']) {
  return importance === 'must' ? t.todayGroupMust : importance === 'should' ? t.todayGroupShould : t.todayGroupNice;
}

/** The overlap line, in the existing copy: «بيتقاطع مع موعد بتقويمك 18:00–19:00». */
function conflictText(block: DeviceBusyBlock, t: ReturnType<typeof useApp>['t'], lang: ReturnType<typeof useApp>['lang'], timeZone: string): string {
  return block.allDay
    ? t.calendarBusyConflictAllDay
    : fill(t.calendarBusyConflict, { range: formatTimeRange(new Date(block.startAt), new Date(block.endAt), { locale: lang, timeZone }) });
}

/** A commitment: its time (or «بدون وقت»), title, importance, and what it runs into. Opens Details. */
export function CommitmentCard({ row, marker = false, narrow = false }: {
  row: Extract<PlanRow, { kind: 'commitment' }>;
  /** On the timeline: a tighter card whose top edge is its time. */
  marker?: boolean;
  /** Sharing its hour with something else: the icon tile gives its width to the title. */
  narrow?: boolean;
}) {
  const { t, p, lang, actions } = useApp();
  const timeZone = useTimeZone();
  const stacked = useLayoutMode() !== 'normal';
  const { item, clock, due, conflict } = row;
  const look = importanceLook(item.importance, p);
  const time = clock ? ltr(formatTime(new Date(clock), { locale: lang, timeZone })) : null;
  const overlap = conflict ? conflictText(conflict, t, lang, timeZone) : null;
  return (
    <Btn
      testID={`calendar-item-${item.id}`}
      label={[rowAccessibilityLabel(item, t, time), due, overlap].filter(Boolean).join(', ')}
      onPress={() => actions.openDetail(item.id)}
      scaleTo={0.98}
      style={{
        minHeight: 44, borderRadius: marker ? 16 : 20, borderWidth: 1,
        borderColor: conflict ? p.prop : p.ln, backgroundColor: p.sf,
        paddingVertical: marker ? 8 : 12, paddingHorizontal: marker ? 10 : 14, gap: 6,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {!stacked && !narrow ? (
          <View accessible={false} style={{ width: marker ? 28 : 40, height: marker ? 28 : 40, borderRadius: marker ? 9 : 12, backgroundColor: look.bg, alignItems: 'center', justifyContent: 'center' }}>
            <ReferenceIcon name={clock ? 'clock' : 'clipboard'} size={marker ? 16 : 20} color={look.fg} />
          </View>
        ) : null}
        <View style={{ flex: 1, gap: 2, alignItems: 'flex-start' }}>
          <Txt size={15} weight={700} color={p.tx}>{isolateAuto(item.title)}</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 }}>
            <Txt size={13} color={p.mu} latin={time !== null} testID={`calendar-time-${item.id}`}>{time ?? t.noTimeYet}</Txt>
            {due ? <Txt size={13} color={p.mu} testID={`calendar-due-${item.id}`}>{due}</Txt> : null}
          </View>
        </View>
        <Tag kind={priorityTagKind(item.importance)} label={importanceWord(item.importance, t)} />
      </View>
      {overlap ? (
        <View testID={`calendar-conflict-${item.id}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'stretch', borderRadius: 10, backgroundColor: p.wms, paddingVertical: 4, paddingHorizontal: 8 }}>
          <View accessible={false} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.wm }} />
          <Txt size={13} weight={600} color={p.wm} style={{ flexShrink: 1 }}>{overlap}</Txt>
        </View>
      ) : null}
    </Btn>
  );
}

/**
 * Busy time from the phone's calendar: «مشغول (من التقويم)» and when — no
 * title, ever. A meeting about to start carries «حضّرني», beside the text
 * rather than inside it so a screen reader reaches both.
 */
export function BusyCard({ row, height }: { row: Extract<PlanRow, { kind: 'busy' }>; height?: number | undefined }) {
  const { t, p, lang, actions } = useApp();
  const timeZone = useTimeZone();
  const { block, prep } = row;
  const range = block.allDay ? null : formatTimeRange(new Date(block.startAt), new Date(block.endAt), { locale: lang, timeZone });
  const start = ltr(formatTime(new Date(block.startAt), { locale: lang, timeZone }));
  return (
    <View testID="calendar-busy-row" style={{ ...(height !== undefined ? { height } : { minHeight: 52 }) }}>
      <View accessible={false} style={{ position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: p.lnStrong, backgroundColor: p.sf2, overflow: 'hidden' }}>
        <Hatch color={p.hatch} radius={14} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 10, minHeight: Math.min(height ?? 52, 52) }}>
        <View accessible accessibilityRole="text" accessibilityLabel={[t.legendBusy, range].filter(Boolean).join(', ')} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ReferenceIcon name="calendar" size={18} color={p.tx} />
          <View style={{ flex: 1, alignItems: 'flex-start' }}>
            <Txt size={14} weight={700} color={p.tx}>{t.legendBusy}</Txt>
            {range ? <Txt size={13} color={p.mu} latin>{range}</Txt> : null}
          </View>
        </View>
        {prep ? (
          <Btn testID="calendar-busy-prepare" label={fill(t.xPrepareFor, { time: start })}
            onPress={() => actions.openMeetingPrep(prep)} scaleTo={0.97}
            style={{ minHeight: 44, justifyContent: 'center', backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 }}>
            <Txt size={13} weight={600} color={p.tx}>{t.xPrepare}</Txt>
          </Btn>
        ) : null}
      </View>
    </View>
  );
}

/** A weekly fixed block on the timeline: «ثابت», its title, its hours. Opens «الثابت الأسبوعي». */
function WeeklyCard({ occurrence, height }: { occurrence: WeeklyBlockOccurrence; height: number }) {
  const { t, p, lang, actions } = useApp();
  const timeZone = useTimeZone();
  const start = new Date(occurrence.startAt);
  const end = new Date(occurrence.endAt);
  const options = { locale: lang, timeZone } as const;
  const testID = `calendar-weekly-${occurrence.weeklyBlockId}`;
  return (
    <Btn
      testID={testID}
      label={[occurrence.title, t.wbFixedTag, fill(t.wbA11yTime, { start: formatTime(start, options), end: formatTime(end, options) })].join(t.wbListSep)}
      hint={t.wbTitle}
      onPress={() => actions.go('weeklyBlocks')}
      scaleTo={0.98}
      style={{ height, borderRadius: 14, backgroundColor: p.sf2, borderStartWidth: 3, borderStartColor: p.lnStrong }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 10, minHeight: Math.min(height, 52) }}>
        <Tag kind="fixed" label={t.wbFixedTag} />
        <View style={{ flex: 1, alignItems: 'flex-start' }}>
          <Txt size={14} weight={700} color={p.tx}>{occurrence.title}</Txt>
          <Txt size={13} color={p.mu} latin testID={`${testID}-time`}>{formatTimeRange(start, end, options)}</Txt>
        </View>
      </View>
    </Btn>
  );
}

/**
 * The day's timed rows on equal hours. Blocks are as tall as they last;
 * commitments are markers at their time. `nowIso` draws the now-line when the
 * day is today.
 */
export function DayTimeline({ rows, day, nowIso }: { rows: readonly PlanRow[]; day: string; nowIso: string | null }) {
  const { p } = useApp();
  const timeZone = useTimeZone();
  const scale = useTextScale();
  const spans: TimelineSpan[] = rows.map(row => {
    if (row.kind === 'commitment') {
      return {
        key: row.key,
        start: minuteOfDay(row.clock!, day, timeZone),
        end: null,
        // Padding, a title line and a time line in the Arabic face's line box;
        // a due aside and an overlap line each add one more.
        minVisual: (70 + (row.due ? 22 : 0) + (row.conflict ? 36 : 0)) * scale,
      };
    }
    const startAt = row.kind === 'busy' ? row.block.startAt : row.occurrence.startAt;
    const endAt = row.kind === 'busy' ? row.block.endAt : row.occurrence.endAt;
    return { key: row.key, start: minuteOfDay(startAt, day, timeZone), end: minuteOfDay(endAt, day, timeZone), minVisual: 58 * scale };
  });
  const { from, to } = hourWindow(spans);
  const placed = placeSpans(spans, from);
  const byKey = new Map(rows.map(row => [row.key, row]));
  const gridHeight = (to - from) * HOUR_HEIGHT;
  const overhang = Math.max(0, ...placed.map(entry => entry.top + entry.visual - gridHeight));
  const nowMinute = nowIso ? minuteOfDay(nowIso, day, timeZone) : null;
  const nowY = nowMinute !== null && nowMinute >= from * 60 && nowMinute <= to * 60 ? yOf(nowMinute, from) : null;
  const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i);

  return (
    <View testID="calendar-timeline" style={{ borderRadius: 20, borderWidth: 1, borderColor: p.ln, backgroundColor: p.bg, paddingTop: 14, paddingBottom: 10, paddingHorizontal: 8 }}>
      <View style={{ height: gridHeight + overhang }}>
        {hours.map(hour => (
          <View key={hour} accessible={false} importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', top: yOf(hour * 60, from) - 10, start: 0, end: 0, height: 20, flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ width: GUTTER, alignItems: 'flex-start', paddingStart: 2 }}>
              <Txt latin size={13} color={p.mu}>{`${String(hour % 24).padStart(2, '0')}:00`}</Txt>
            </View>
            <View style={{ flex: 1, height: 1, backgroundColor: p.ln }} />
          </View>
        ))}
        {nowY !== null ? (
          <View testID="calendar-now-line" accessible={false} importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', top: nowY - 1, start: GUTTER - 6, end: 0, height: 2, backgroundColor: p.ac, zIndex: 3 }}>
            <View style={{ position: 'absolute', top: -4, start: 0, width: 10, height: 10, borderRadius: 5, backgroundColor: p.ac }} />
          </View>
        ) : null}
        <View style={{ position: 'absolute', top: 0, bottom: 0, start: GUTTER, end: 0 }}>
          {placed.map(entry => {
            const row = byKey.get(entry.key)!;
            const frame = {
              position: 'absolute' as const,
              top: entry.top,
              start: `${(entry.lane * 100) / entry.lanes}%` as const,
              width: `${100 / entry.lanes}%` as const,
              paddingEnd: 4,
              zIndex: row.kind === 'commitment' ? 2 : 1,
            };
            if (row.kind === 'commitment') {
              const look = importanceLook(row.item.importance, p);
              return (
                <View key={entry.key} style={frame}>
                  <View accessible={false} style={{ position: 'absolute', top: -4, start: -4, width: 8, height: 8, borderRadius: 4, backgroundColor: look.fg, zIndex: 3 }} />
                  <CommitmentCard row={row} marker narrow={entry.lanes > 1} />
                </View>
              );
            }
            return (
              <View key={entry.key} style={frame}>
                {row.kind === 'busy'
                  ? <BusyCard row={row} height={entry.height} />
                  : <WeeklyCard occurrence={row.occurrence} height={entry.height} />}
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

/** The same rows as a list in time order, for the large text sizes. */
export function DayAgenda({ rows }: { rows: readonly PlanRow[] }) {
  return (
    <View testID="calendar-agenda-list" style={{ gap: 10 }}>
      {rows.map(row => row.kind === 'commitment'
        ? <CommitmentCard key={row.key} row={row} />
        : row.kind === 'busy'
          ? <BusyCard key={row.key} row={row} />
          : <WeeklyOccurrenceRow key={row.key} occurrence={row.occurrence} testID={`calendar-weekly-${row.occurrence.weeklyBlockId}`} />)}
    </View>
  );
}

/** «التزامات بلا وقت»: what the day holds with no hour, under the timeline. */
export function UntimedSection({ rows, title }: { rows: readonly Extract<PlanRow, { kind: 'commitment' }>[]; title: string }) {
  const { p } = useApp();
  return (
    <View testID="calendar-untimed" style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingTop: 4 }}>
        <ReferenceIcon name="clipboard" size={18} color={p.mu} />
        <Txt role="section" size={16} weight={700} style={{ flexShrink: 1 }}>{title}</Txt>
        <CountChip count={rows.length} testID="calendar-untimed-count" />
      </View>
      {rows.map(row => <CommitmentCard key={row.key} row={row} />)}
    </View>
  );
}
