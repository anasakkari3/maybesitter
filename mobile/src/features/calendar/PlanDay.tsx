import React from 'react';
import { View, useWindowDimensions } from 'react-native';
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
import { dayAndTime } from '../plan/savedPlacement';
import type { DeviceBusyBlock } from './busyBlocks';
import { HOUR_HEIGHT, hourWindow, lanesFit, minuteOfDay, placeSpans, yOf, type TimelineSpan } from './dayTimeline';
import { GapRow } from './FreeTimeRows';
import type { Gap } from './freeTime';
import { unbreakableRange } from './busyConflictText';

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
  | {
    kind: 'commitment'; key: string; at: number; item: CommitmentView;
    /** The instant it is drawn at (a saved slot, or its own time unless all-day); null when it has no hour. */
    clock: string | null;
    /** `clock` is on another day than the one shown (work rolled over from yesterday): said with its day, kept off the hours. */
    offDay: boolean;
    due: string | null;
    conflict: DeviceBusyBlock | null;
  }
  | { kind: 'busy'; key: string; at: number; block: DeviceBusyBlock; prep: MeetingPrepTarget | null }
  | { kind: 'weekly'; key: string; at: number; occurrence: WeeklyBlockOccurrence }
  /** A free stretch of an hour or more, drawn quietly between the rows in «الكل» (M4a R003). */
  | { kind: 'gap'; key: string; at: number; gap: Gap };

/** The gutter the hour labels sit in, at the start edge. */
const GUTTER = 52;
/** The screen's side padding (`ScreenScroll`), on each side. */
const SCREEN_SIDE = 16;
/** The timeline card's border (1) and inner padding (8), on each side. */
const TIMELINE_INSET = 9;

/** The width the lanes share on a window `windowWidth` points wide: the screen's padding, the card's, and the hour gutter come off it. */
export function timelineLaneWidth(windowWidth: number): number {
  return windowWidth - 2 * SCREEN_SIDE - 2 * TIMELINE_INSET - GUTTER;
}

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
    : fill(t.calendarBusyConflict, { range: unbreakableRange(formatTimeRange(new Date(block.startAt), new Date(block.endAt), { locale: lang, timeZone })) });
}

/** A commitment: its time (or «بدون وقت»), title, importance, and what it runs into. Opens Details. */
export function CommitmentCard({ row, marker = false, narrow = false, agenda = false, importance = false, minHeight = 44 }: {
  row: Extract<PlanRow, { kind: 'commitment' }>;
  /** On the timeline: a tighter card whose top edge is its time. */
  marker?: boolean;
  /** Sharing its hour with something else: the icon tile gives its width to the title. */
  narrow?: boolean;
  /** Dense ordered-list treatment used when a timeline would be unreadable. */
  agenda?: boolean;
  /**
   * In the dense list, the importance word on its own line under the title —
   * for the day that fell back from the timeline (#738), where the coloured
   * start border alone would be the only sign of it.
   */
  importance?: boolean;
  /** On the timeline, a ranged commitment's true height. */
  minHeight?: number;
}) {
  const { t, p, lang, actions } = useApp();
  const timeZone = useTimeZone();
  const stacked = useLayoutMode() !== 'normal';
  const { item, clock, offDay, due, conflict } = row;
  const look = importanceLook(item.importance, p);
  const time = clock ? (offDay ? dayAndTime(clock, lang, timeZone) : ltr(formatTime(new Date(clock), { locale: lang, timeZone }))) : null;
  const overlap = conflict ? conflictText(conflict, t, lang, timeZone) : null;
  return (
    <Btn
      testID={`calendar-item-${item.id}`}
      label={[rowAccessibilityLabel(item, t, time), due, overlap].filter(Boolean).join(', ')}
      onPress={() => actions.openDetail(item.id)}
      scaleTo={0.98}
      style={{
        minHeight: Math.max(44, minHeight), borderRadius: agenda ? 14 : marker ? 16 : 20, borderWidth: 1,
        borderColor: conflict ? p.prop : p.ln, backgroundColor: p.sf,
        paddingVertical: agenda ? 7 : marker ? 8 : 12, paddingHorizontal: agenda ? 10 : marker ? 10 : 14, gap: agenda ? 3 : 6,
        ...(agenda ? { borderStartWidth: 3, borderStartColor: look.fg } : {}),
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {!agenda && !stacked && !narrow ? (
          <View accessible={false} style={{ width: marker ? 28 : 40, height: marker ? 28 : 40, borderRadius: marker ? 9 : 12, backgroundColor: look.bg, alignItems: 'center', justifyContent: 'center' }}>
            <ReferenceIcon name={clock ? 'clock' : 'clipboard'} size={marker ? 16 : 20} color={look.fg} />
          </View>
        ) : null}
        {agenda ? (
          <View style={{ flex: 1, gap: due || importance ? 2 : 0, alignItems: 'stretch' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Txt size={15} weight={700} color={p.tx} lines={2} style={{ flex: 1 }} testID={`m6-calendar-title-${item.id}`}>{isolateAuto(item.title)}</Txt>
              <Txt size={13} color={p.mu} latin={time !== null && !offDay} lines={1} testID={`calendar-time-${item.id}`}>{time ?? t.noTimeYet}</Txt>
            </View>
            {due ? <Txt size={13} color={p.mu} lines={1} testID={`calendar-due-${item.id}`}>{due}</Txt> : null}
            {importance ? <Tag kind={priorityTagKind(item.importance)} label={importanceWord(item.importance, t)} testID={`calendar-importance-${item.id}`} /> : null}
          </View>
        ) : (
          <View style={{ flex: 1, gap: 2, alignItems: 'flex-start' }}>
            <Txt size={15} weight={700} color={p.tx} testID={`m6-calendar-title-${item.id}`}>{isolateAuto(item.title)}</Txt>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 }}>
              <Txt size={13} color={p.mu} latin={time !== null && !offDay} testID={`calendar-time-${item.id}`}>{time ?? t.noTimeYet}</Txt>
              {due ? <Txt size={13} color={p.mu} testID={`calendar-due-${item.id}`}>{due}</Txt> : null}
            </View>
          </View>
        )}
        {!agenda && !narrow ? <Tag kind={priorityTagKind(item.importance)} label={importanceWord(item.importance, t)} /> : null}
      </View>
      {/* Sharing its hour, the card is a column: the title keeps the whole
          width, so a word is never broken inside itself (#738), and the
          importance chip moves under it. */}
      {!agenda && narrow ? <Tag kind={priorityTagKind(item.importance)} label={importanceWord(item.importance, t)} /> : null}
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
export function BusyCard({ row, height, reserve = 0, narrow = false }: {
  row: Extract<PlanRow, { kind: 'busy' }>;
  /** On the timeline, how long it lasts: the hatched block is drawn exactly this tall. */
  height?: number | undefined;
  /** On the timeline, the room the lanes kept for its label and «حضّرني»: the card is laid out (and pressed) in at least this, and 44. */
  reserve?: number;
  /** Sharing its moment on the timeline: no icon, and «حضّرني» under the text rather than beside it, so neither squeezes a word. */
  narrow?: boolean;
}) {
  const { t, p, lang, actions } = useApp();
  const timeZone = useTimeZone();
  const { block, prep } = row;
  const range = block.allDay ? null : formatTimeRange(new Date(block.startAt), new Date(block.endAt), { locale: lang, timeZone });
  const start = ltr(formatTime(new Date(block.startAt), { locale: lang, timeZone }));
  return (
    <View testID="calendar-busy-row" style={{ ...(height !== undefined ? { height: Math.max(height, reserve, 44) } : { minHeight: 52 }) }}>
      {/* The duration, drawn on its own: the label and the action may need
          more room than a short block lasts, and they keep it (Q738-001). */}
      <View testID="calendar-busy-duration" accessible={false} style={{ position: 'absolute', top: 0, ...(height !== undefined ? { height: Math.max(height, 1) } : { bottom: 0 }), start: 0, end: 0, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: p.lnStrong, backgroundColor: p.sf2, overflow: 'hidden' }}>
        <Hatch color={p.hatch} radius={14} />
      </View>
      <View testID="calendar-busy-body" style={{ flexDirection: narrow ? 'column' : 'row', alignItems: narrow ? 'stretch' : 'center', gap: narrow ? 6 : 8, paddingVertical: 6, paddingHorizontal: 10, minHeight: Math.min(height ?? 52, 52) }}>
        <View accessible accessibilityRole="text" accessibilityLabel={[t.legendBusy, range].filter(Boolean).join(', ')} style={{ ...(narrow ? {} : { flex: 1 }), flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {narrow ? null : <ReferenceIcon name="calendar" size={18} color={p.tx} />}
          <View style={{ flex: 1, alignItems: 'flex-start' }}>
            <Txt size={14} weight={700} color={p.tx}>{t.legendBusy}</Txt>
            {range ? <Txt size={13} color={p.mu} latin>{range}</Txt> : null}
          </View>
        </View>
        {prep ? (
          <Btn testID="calendar-busy-prepare" label={fill(t.xPrepareFor, { time: start })}
            onPress={() => actions.openMeetingPrep(prep)} scaleTo={0.97}
            style={{ minHeight: 44, justifyContent: 'center', ...(narrow ? { alignSelf: 'flex-start' as const } : {}), backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 }}>
            <Txt size={13} weight={600} color={p.tx}>{t.xPrepare}</Txt>
          </Btn>
        ) : null}
      </View>
    </View>
  );
}

/** A weekly fixed block on the timeline: «ثابت», its title, its hours. Opens «الثابت الأسبوعي». */
function WeeklyCard({ occurrence, height, reserve, narrow = false }: {
  occurrence: WeeklyBlockOccurrence;
  /** How long it lasts: the filled block is drawn exactly this tall. */
  height: number;
  /** The room the lanes kept for its label: the button is laid out (and pressed) in at least this, and 44. */
  reserve: number;
  /** Sharing its moment: «ثابت» moves above the title, as a commitment's chip moves under its title, so the title keeps the lane's whole width. */
  narrow?: boolean;
}) {
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
      style={{ height: Math.max(height, reserve, 44), borderRadius: 14 }}
    >
      {/* The duration, drawn on its own (Q738-001): a five-minute block is a
          sliver, and its label and target still get their room. */}
      <View testID={`${testID}-duration`} accessible={false} style={{ position: 'absolute', top: 0, start: 0, end: 0, height: Math.max(height, 1), borderRadius: 14, backgroundColor: p.sf2, borderStartWidth: 3, borderStartColor: p.lnStrong }} />
      <View testID={`${testID}-body`} style={{ flexDirection: narrow ? 'column' : 'row', alignItems: narrow ? 'flex-start' : 'center', gap: narrow ? 4 : 8, paddingVertical: 6, paddingHorizontal: 10, minHeight: Math.min(height, 52) }}>
        <Tag kind="fixed" label={t.wbFixedTag} />
        <View style={{ ...(narrow ? { alignSelf: 'stretch' as const } : { flex: 1 }), alignItems: 'flex-start' }}>
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
 * day is today. When the busiest moment needs more lanes than the width holds
 * at the reader's text size (`lanesFit`), it draws `DayAgenda` instead (#738).
 */
export function DayTimeline({ rows: allRows, day, nowIso }: { rows: readonly PlanRow[]; day: string; nowIso: string | null }) {
  const { p } = useApp();
  const timeZone = useTimeZone();
  const scale = useTextScale();
  const { width } = useWindowDimensions();
  // Free stretches sit behind the lanes: they are the space between things,
  // so they take no lane of their own and never narrow a commitment.
  const gaps = allRows.filter((row): row is Extract<PlanRow, { kind: 'gap' }> => row.kind === 'gap');
  const rows = allRows.filter((row): row is Exclude<PlanRow, { kind: 'gap' }> => row.kind !== 'gap');
  const gapSpans = gaps.map((row) => ({
    row,
    start: minuteOfDay(new Date(row.gap.start).toISOString(), day, timeZone),
    end: minuteOfDay(new Date(row.gap.end).toISOString(), day, timeZone),
  }));
  const spans = timelineSpans(rows, day, timeZone, scale);
  const { from, to } = hourWindow([...spans, ...gapSpans.map(({ row, start, end }) => ({ key: row.key, start, end, minVisual: 0 }))]);
  const placed = placeSpans(spans, from);
  // More lanes at once than fit at their floor: the same rows as the ordered
  // list, which the large text sizes already use (#738).
  if (!lanesFit(placed, timelineLaneWidth(width), scale)) return <DayAgenda rows={allRows} day={day} importance />;
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
          {gapSpans.map(({ row, start, end }) => (
            <View key={row.key} style={{ position: 'absolute', top: yOf(start, from), start: 0, end: 4, zIndex: 0 }}>
              <GapRow gap={row.gap} day={day} quiet height={Math.max(44, yOf(end, from) - yOf(start, from))} />
            </View>
          ))}
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
                  <CommitmentCard row={row} marker={entry.height === 0} narrow={entry.lanes > 1} minHeight={entry.height} />
                </View>
              );
            }
            return (
              // The frame is the room the lanes kept (never under 44); the
              // card draws its duration inside it.
              <View key={entry.key} style={{ ...frame, height: Math.max(entry.visual, 44) }} testID={`m6-timeline-block-${entry.key}`}>
                {row.kind === 'busy'
                  ? <BusyCard row={row} height={entry.height} reserve={entry.visual} narrow={entry.lanes > 1} />
                  : <WeeklyCard occurrence={row.occurrence} height={entry.height} reserve={entry.visual} narrow={entry.lanes > 1} />}
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

/**
 * The day's timed rows as spans on the hours: where each starts and ends, and
 * the room its label needs — beside nothing, and as a column in a shared lane.
 * Pure, so the lane floor can be checked without a renderer.
 */
export function timelineSpans(rows: readonly Exclude<PlanRow, { kind: 'gap' }>[], day: string, timeZone: string, scale: number): TimelineSpan[] {
  return rows.map((row): TimelineSpan => {
    if (row.kind === 'commitment') {
      const start = minuteOfDay(row.clock!, day, timeZone);
      const until = rangeEndOf(row);
      const end = until ? minuteOfDay(until, day, timeZone) : null;
      return {
        key: row.key,
        start,
        // A commitment that names its end (a saved slot, or «من 9 لـ 5») is
        // drawn as long as it lasts (#738): a 09:00–17:00 offsite as one hour
        // made the 10:00 lawyer look free beside it. One with no end stays a
        // marker — inventing a length would be worse.
        end: end !== null && end > start ? end : null,
        // Padding, a title line and a time line in the Arabic face's line box;
        // a due aside and an overlap line each add one more.
        minVisual: (70 + (row.due ? 22 : 0) + (row.conflict ? 36 : 0)) * scale,
        // As a column the chip takes a line under the title, and the overlap
        // line may wrap once.
        narrowVisual: (98 + (row.due ? 22 : 0) + (row.conflict ? 56 : 0)) * scale,
      };
    }
    const startAt = row.kind === 'busy' ? row.block.startAt : row.occurrence.startAt;
    const endAt = row.kind === 'busy' ? row.block.endAt : row.occurrence.endAt;
    return {
      key: row.key,
      start: minuteOfDay(startAt, day, timeZone),
      end: minuteOfDay(endAt, day, timeZone),
      minVisual: 58 * scale,
      // As a column: «مشغول (من التقويم)» may wrap once and «حضّرني» sits
      // under it; a weekly block's «ثابت» takes a line above its title.
      narrowVisual: (row.kind === 'busy' ? 80 + (row.prep ? 52 : 0) : 88) * scale,
    };
  });
}

/** The same rows as a list in time order, for the large text sizes. */
export function DayAgenda({ rows, day, importance = false }: {
  rows: readonly PlanRow[];
  day: string;
  /** Each commitment says its importance in words (the timeline's fallback, #738). */
  importance?: boolean;
}) {
  return (
    <View testID="calendar-agenda-list" style={{ gap: 10 }}>
      {rows.map(row => row.kind === 'commitment'
        ? <CommitmentCard key={row.key} row={row} agenda importance={importance} />
        : row.kind === 'busy'
          ? <BusyCard key={row.key} row={row} />
          : row.kind === 'gap'
            ? <GapRow key={row.key} gap={row.gap} day={day} quiet />
            : <WeeklyOccurrenceRow key={row.key} occurrence={row.occurrence} testID={`calendar-weekly-${row.occurrence.weeklyBlockId}`} />)}
    </View>
  );
}

/**
 * «التزامات بلا وقت»: what the day holds with no hour on it, under the
 * timeline — and anything whose time is on another day, said with that day.
 */
export function UntimedSection({ rows, title }: { rows: readonly Extract<PlanRow, { kind: 'commitment' }>[]; title: string }) {
  const { p } = useApp();
  return (
    <View testID="calendar-untimed" style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingTop: 4 }}>
        <ReferenceIcon name="clipboard" size={18} color={p.mu} />
        <Txt role="section" size={16} weight={700} style={{ flexShrink: 1 }}>{title}</Txt>
        <CountChip count={rows.length} testID="calendar-untimed-count" />
      </View>
      {rows.map(row => <CommitmentCard key={row.key} row={row} agenda />)}
    </View>
  );
}

/** Where a commitment on the timeline ends: its saved slot's end, or its own `endAt` when it is drawn at its own time. */
function rangeEndOf(row: Extract<PlanRow, { kind: 'commitment' }>): string | null {
  const { item, clock } = row;
  if (!clock || row.offDay) return null;
  if (item.plannedAt && item.plannedAt === clock) return item.plannedEnd ?? null;
  if (item.dueAt && item.dueAt === clock && !item.allDay) return item.endAt ?? null;
  return null;
}
