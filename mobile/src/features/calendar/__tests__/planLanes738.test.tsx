/**
 * #738, second half (simulator pass 2026-10-23): five things overlapping at
 * 10:00 were drawn in five 56-point lanes, which broke «المحامي», «10:00» and
 * the importance chips inside themselves and stretched short cards into long
 * ranges. A lane now has a floor at the reader's text size, and a day whose
 * busiest moment needs more lanes than fit is drawn as the ordered list.
 *
 * The window is a 390-pt phone, not jest's default 750, because the floor is
 * about the width a person actually has.
 */
import React from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, within } from '@testing-library/react-native';
import { DayAgenda, DayTimeline, UntimedSection, timelineCardHeight, timelineLaneWidth, timelineSpans, type PlanRow } from '../PlanDay';
import { HOUR_HEIGHT, lanesFit, maxLanes, minLaneWidth, placeSpans } from '../dayTimeline';
import { LINE_HEIGHT } from '../../../theme/fonts';
import { layoutModeFor } from '../../../theme/textScale';
import { toViewModel, type CommitmentView } from '../../commitments/model';
import ar from '../../../i18n/locales/ar.json';
import { CalendarScreen } from '../../../screens/CalendarScreen';
import { NOW, Providers, TODAY, ZONE, commitment, flatStyle, instant, prepareM6, teardown, type M6Harness } from '../../../__acceptance__/m6/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 1 })),
}));

const dimensions = useWindowDimensions as unknown as jest.Mock<() => { width: number; height: number; scale: number; fontScale: number }>;
const atScale = (fontScale: number, width = 390) => dimensions.mockReturnValue({ width, height: 844, scale: 3, fontScale });

let harness: M6Harness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  atScale(1);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

/** A commitment at `from` local time, ranged to `to` when given. */
function ranged(id: string, title: string, from: string, to: string | null, level: 'high' | 'normal' | 'low' = 'normal') {
  return commitment(id, {
    title,
    priority: { level, source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'scheduled_event', dueAt: instant(TODAY, from), endAt: to ? instant(TODAY, to) : null, remindAt: null, allDay: false, timezone: ZONE },
  });
}

// «يوم عمل خارجي للفريق», «موعد مع المحامي», «موعد عند دكتور الأسنان», «مكالمة مع العميل الجديد».
const OFFSITE = ranged('offsite', 'يوم عمل خارجي للفريق', '09:00', '17:00');
const LAWYER = ranged('lawyer', 'موعد مع المحامي', '10:00', null, 'high');
const DENTIST = ranged('dentist', 'موعد عند دكتور الأسنان', '10:30', '11:30');
const CALL = ranged('call', 'مكالمة مع العميل الجديد', '11:00', '13:00', 'low');

function commitmentRow(item: ReturnType<typeof commitment>): Extract<PlanRow, { kind: 'commitment' }> {
  const view = toViewModel(item, NOW.toISOString());
  const clock = item.timeSpec.dueAt!;
  return { kind: 'commitment', key: `c-${item.id}`, at: Date.parse(clock), item: view, clock, offDay: false, due: null, conflict: null };
}

const WEEKLY: PlanRow = {
  kind: 'weekly', key: 'weekly-wb', at: Date.parse(instant(TODAY, '10:00')),
  occurrence: { occurrenceId: 'wb-1', weeklyBlockId: 'wb', title: 'دوام', startAt: instant(TODAY, '10:00'), endAt: instant(TODAY, '12:00') },
};

/** The simulator's day: 09:00–17:00, a weekly block 10:00–12:00, 10:00, 10:30–11:30, 11:00–13:00. */
const REPRO: PlanRow[] = [commitmentRow(OFFSITE), WEEKLY, commitmentRow(LAWYER), commitmentRow(DENTIST), commitmentRow(CALL)];
const REPRO_IDS = ['calendar-item-offsite', 'calendar-weekly-wb', 'calendar-item-lawyer', 'calendar-item-dentist', 'calendar-item-call'];

async function showTimeline(rows: PlanRow[]) {
  harness = await prepareM6('ar');
  await render(<Providers harness={harness}><DayTimeline rows={rows} day={TODAY} nowIso={null} /></Providers>);
}

function expectSafeList() {
  const list = screen.getByTestId('calendar-agenda-list');
  expect(screen.queryByTestId('calendar-timeline')).toBeNull();
  for (const id of REPRO_IDS) expect(within(list).queryByTestId(id)).not.toBeNull();
}

/** The importance word a person reads on screen (the chip's text), not only what a screen reader hears. */
function importanceWord(importance: CommitmentView['importance']): string {
  return importance === 'must' ? ar.todayGroupMust : importance === 'should' ? ar.todayGroupShould : ar.todayGroupNice;
}

/** Q738-002: every commitment in the fallback list still says its importance in words. */
function expectVisibleImportance(items: ReturnType<typeof commitment>[]) {
  const words = new Set<string>();
  for (const item of items) {
    const word = importanceWord(toViewModel(item, NOW.toISOString()).importance);
    words.add(word);
    const card = screen.getByTestId(`calendar-item-${item.id}`);
    const chip = within(card).getByTestId(`calendar-importance-${item.id}`);
    expect(chip.props.children).toBe(word);
  }
  // The fixture spans all three words, so a constant label would not pass.
  expect(words.size).toBe(3);
}

describe('#738 the five-item day on a phone', () => {
  it('pure: the real rows need five lanes at once, more than a 390-pt phone holds at the floor', () => {
    const timed = REPRO.filter((row): row is Exclude<PlanRow, { kind: 'gap' }> => row.kind !== 'gap');
    const placed = placeSpans(timelineSpans(timed, TODAY, ZONE, 1), 8);
    expect(maxLanes(placed)).toBe(5);
    expect(lanesFit(placed, timelineLaneWidth(390), 1)).toBe(false);
  });

  it('at the default text size, the day is the ordered list, every row still there and still a button', async () => {
    await showTimeline(REPRO);
    expectSafeList();
    // Each row keeps its label and its role.
    const lawyer = screen.getByTestId('calendar-item-lawyer');
    expect(lawyer.props.accessibilityRole).toBe('button');
    expect(String(lawyer.props.accessibilityLabel)).toContain('المحامي');
    expect(screen.getByTestId('calendar-weekly-wb').props.accessibilityRole).toBe('button');
    expectVisibleImportance([OFFSITE, LAWYER, DENTIST, CALL]);
  });

  it('#788 every dense list (large text, a crowded day) says the importance in words, not by colour alone', async () => {
    harness = await prepareM6('ar');
    await render(<Providers harness={harness}><DayAgenda rows={REPRO} day={TODAY} /></Providers>);
    expectVisibleImportance([OFFSITE, LAWYER, DENTIST, CALL]);
  });

  it('#788 the untimed list says the importance in words too', async () => {
    harness = await prepareM6('ar');
    const untimed = REPRO.filter((row): row is Extract<PlanRow, { kind: 'commitment' }> => row.kind === 'commitment');
    await render(<Providers harness={harness}><UntimedSection rows={untimed} title="t" /></Providers>);
    expectVisibleImportance([OFFSITE, LAWYER, DENTIST, CALL]);
  });

  it.each<['ar' | 'en' | 'he', string]>([
    ['ar', 'موعدها بكرا · 15:00، قبل اجتماع الفريق الأسبوعي'],
    ['en', 'Due tomorrow · 15:00, before the weekly team meeting'],
    ['he', 'מועד היעד מחר · 15:00, לפני פגישת הצוות השבועית'],
  ])('#788 Q788-001 at AX5 a long due (%s) wraps beside the chip and is never line-clamped', async (lang, due) => {
    atScale(3.12);
    harness = await prepareM6(lang);
    const rows = [OFFSITE, LAWYER].map(item => ({ ...commitmentRow(item), due }));
    await render(<Providers harness={harness}><DayAgenda rows={rows} day={TODAY} /></Providers>);
    for (const item of [OFFSITE, LAWYER]) {
      const meta = screen.getByTestId(`calendar-meta-${item.id}`);
      const dueNode = within(meta).getByTestId(`calendar-due-${item.id}`);
      expect(dueNode.props.children).toBe(due);
      expect(dueNode.props.numberOfLines ?? 0).toBe(0);
      expect(StyleSheet.flatten(meta.props.style).flexWrap).toBe('wrap');
      expect(within(meta).getByTestId(`calendar-importance-${item.id}`)).toBeTruthy();
    }
  });

  it('#788 at AX5 the importance chip and the due share the second line and wrap, never clipped', async () => {
    atScale(3.12);
    harness = await prepareM6('ar');
    await render(<Providers harness={harness}><DayAgenda rows={REPRO} day={TODAY} /></Providers>);
    expectVisibleImportance([OFFSITE, LAWYER, DENTIST, CALL]);
    for (const item of [OFFSITE, LAWYER, DENTIST, CALL]) {
      const meta = screen.getByTestId(`calendar-meta-${item.id}`);
      expect(StyleSheet.flatten(meta.props.style).flexWrap).toBe('wrap');
      expect(within(meta).getByTestId(`calendar-importance-${item.id}`)).toBeTruthy();
    }
  });

  it('at AX5, the day is the ordered list too', async () => {
    atScale(3.12);
    await showTimeline(REPRO);
    expectSafeList();
    expectVisibleImportance([OFFSITE, LAWYER, DENTIST, CALL]);
  });

  it('at AX5, even two lanes are under the floor, so a day that fits at size 1 is the list', async () => {
    atScale(3.12);
    await showTimeline([commitmentRow(OFFSITE), commitmentRow(LAWYER)]);
    expect(screen.queryByTestId('calendar-agenda-list')).not.toBeNull();
    expect(screen.queryByTestId('calendar-timeline')).toBeNull();
  });

  it('through the Plan tab: four overlapping commitments (fewer than the count rule) take the list, not five lanes', async () => {
    harness = await prepareM6('ar', { commitments: [OFFSITE, LAWYER, DENTIST, CALL] });
    await render(<Providers harness={harness}><CalendarScreen /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('calendar-item-call')).not.toBeNull());
    const list = screen.getByTestId('calendar-agenda-list');
    expect(screen.queryByTestId('calendar-timeline')).toBeNull();
    for (const id of ['offsite', 'lawyer', 'dentist', 'call']) expect(within(list).queryByTestId(`calendar-item-${id}`)).not.toBeNull();
    expectVisibleImportance([OFFSITE, LAWYER, DENTIST, CALL]);
  });
});

describe('#738 what still fits stays on the hours', () => {
  it('a 09:00–17:00 range beside the 10:00 lawyer: two lanes, the range drawn eight hours tall', async () => {
    await showTimeline([commitmentRow(OFFSITE), commitmentRow(LAWYER)]);
    expect(screen.queryByTestId('calendar-timeline')).not.toBeNull();
    expect(screen.queryByTestId('calendar-agenda-list')).toBeNull();
    expect(Number(flatStyle(screen.getByTestId('calendar-item-offsite')).minHeight)).toBe(8 * HOUR_HEIGHT);
  });

  it('a weekly block sharing its hour sets «ثابت» above its title, so the title keeps the lane\'s width', async () => {
    await showTimeline([WEEKLY, commitmentRow(LAWYER)]);
    expect(screen.queryByTestId('calendar-timeline')).not.toBeNull();
    expect(flatStyle(screen.getByTestId('calendar-weekly-wb-body')).flexDirection).toBe('column');
  });

  it('a weekly block alone keeps its row', async () => {
    await showTimeline([WEEKLY]);
    expect(flatStyle(screen.getByTestId('calendar-weekly-wb-body')).flexDirection).toBe('row');
  });

  it('busy time sharing its hour drops its icon width and stacks', async () => {
    const busy: PlanRow = {
      kind: 'busy', key: 'busy-1', at: Date.parse(instant(TODAY, '14:00')),
      block: { nativeId: 'evt-1', startAt: instant(TODAY, '14:00'), endAt: instant(TODAY, '16:00'), allDay: false }, prep: null,
    };
    await showTimeline([busy, commitmentRow(ranged('later', 'x', '15:00', null))]);
    expect(screen.queryByTestId('calendar-timeline')).not.toBeNull();
    expect(flatStyle(screen.getByTestId('calendar-busy-body')).flexDirection).toBe('column');
  });
});

describe('Q738-001 a block\'s duration is drawn apart from its label and its target', () => {
  it('a five-minute weekly block beside the lawyer: a sliver of duration, a full-size button laid out in the room the lanes kept', async () => {
    const short: PlanRow = {
      kind: 'weekly', key: 'weekly-short', at: Date.parse(instant(TODAY, '10:00')),
      occurrence: { occurrenceId: 'short-1', weeklyBlockId: 'short', title: 'x', startAt: instant(TODAY, '10:00'), endAt: instant(TODAY, '10:05') },
    };
    await showTimeline([short, commitmentRow(LAWYER)]);
    expect(screen.queryByTestId('calendar-timeline')).not.toBeNull();
    expect(flatStyle(screen.getByTestId('calendar-weekly-short-body')).flexDirection).toBe('column');
    // The duration: five minutes of a 56-pt hour.
    expect(Number(flatStyle(screen.getByTestId('calendar-weekly-short-duration')).height)).toBeCloseTo((5 * HOUR_HEIGHT) / 60, 5);
    // The button and its frame: the stacked label's reserved room (88 pt), never under 44.
    const button = Number(flatStyle(screen.getByTestId('calendar-weekly-short')).height);
    const frame = Number(flatStyle(screen.getByTestId('m6-timeline-block-weekly-short')).height);
    expect(button).toBe(88);
    expect(frame).toBe(88);
    expect(button).toBeGreaterThanOrEqual(44);
  });

  it('an hour of busy time with the prepare action beside a commitment: the stacked action lies inside its card, laid out in the reserved room', async () => {
    const busy: PlanRow = {
      kind: 'busy', key: 'busy-prep', at: Date.parse(instant(TODAY, '14:00')),
      block: { nativeId: 'evt-prep', startAt: instant(TODAY, '14:00'), endAt: instant(TODAY, '15:00'), allDay: false },
      prep: { startAt: instant(TODAY, '14:00'), endAt: instant(TODAY, '15:00') },
    };
    await showTimeline([busy, commitmentRow(ranged('later', 'x', '14:30', null))]);
    expect(screen.queryByTestId('calendar-timeline')).not.toBeNull();
    expect(flatStyle(screen.getByTestId('calendar-busy-body')).flexDirection).toBe('column');
    expect(Number(flatStyle(screen.getByTestId('calendar-busy-duration')).height)).toBe(HOUR_HEIGHT);
    // 80 for the stacked text and 52 for the action under it.
    const card = Number(flatStyle(screen.getByTestId('calendar-busy-row')).height);
    const frame = Number(flatStyle(screen.getByTestId('m6-timeline-block-busy-prep')).height);
    expect(card).toBe(132);
    expect(frame).toBe(132);
    expect(Number(flatStyle(screen.getByTestId('calendar-busy-prepare')).minHeight)).toBeGreaterThanOrEqual(44);
    expect(within(screen.getByTestId('calendar-busy-row')).queryByTestId('calendar-busy-prepare')).not.toBeNull();
  });

  it('a long block is still drawn exactly as long as it lasts, its card no taller', async () => {
    const busy: PlanRow = {
      kind: 'busy', key: 'busy-long', at: Date.parse(instant(TODAY, '14:00')),
      block: { nativeId: 'evt-long', startAt: instant(TODAY, '14:00'), endAt: instant(TODAY, '17:00'), allDay: false }, prep: null,
    };
    await showTimeline([busy]);
    expect(Number(flatStyle(screen.getByTestId('calendar-busy-duration')).height)).toBe(3 * HOUR_HEIGHT);
    expect(Number(flatStyle(screen.getByTestId('calendar-busy-row')).height)).toBe(3 * HOUR_HEIGHT);
  });
});

/**
 * Q788b-A (simulator pass 2026-10-23, screenshot 21): on Sunday the 25th,
 * «اتصال مع المحاسبة» at 10:00 wrapped to two lines in its shared lane and
 * drew 126 pt, but only 98 had been kept for it, so it covered the top of the
 * 12:00 «صلاة الظهر» block under it.
 *
 * Q788B-001/002/003: every text on a timeline card — title, due, overlap — is
 * clamped, beside nothing as well as in a shared lane, and the room kept is
 * the tallest the card can then draw: fixed chrome as it is, text line boxes
 * at the reader's size. Safe (never under) and tight (never over, so the
 * reserve cannot invent a lane).
 */
describe('Q788b-A a timeline card never covers the next entry in its lane', () => {
  // A title that wraps in any lane the floor allows: «اتصال مع المحاسبة بخصوص الضرائب السنوية».
  const WRAPPING = ranged('accountant', 'اتصال مع المحاسبة بخصوص الضرائب السنوية', '10:00', null);
  const LONG_RANGE = ranged('conference', 'مؤتمر المبادرين بالجامعة', '09:00', '19:00', 'high');
  const weeklyAt = (from: string, to: string): PlanRow => ({
    kind: 'weekly', key: 'weekly-prayer', at: Date.parse(instant(TODAY, from)),
    occurrence: { occurrenceId: 'prayer-1', weeklyBlockId: 'prayer', title: 'صلاة الظهر', startAt: instant(TODAY, from), endAt: instant(TODAY, to) },
  });
  const SCRIPT = { ar: 'arabic', en: 'latin', he: 'hebrew' } as const;

  /**
   * The tallest the card can draw, worked out from the components' own
   * metrics apart from the code under test: border 2, padding 8 (marker) or
   * 12 (ranged) each side, the 28/40-pt icon at the normal layout beside
   * nothing, the gaps (2 under the title, 6 before the chip or overlap) and
   * the chip's and overlap box's padding stay as they are; RN scales every
   * text's line box (`Txt`: round(size × ratio)). Title, due and overlap at
   * two lines each.
   */
  function tallestCard({ ranged: isRanged = false, narrow = false, due = false, conflict = false, fontScale = 1, script = 'arabic' as keyof typeof LINE_HEIGHT }) {
    const compact = layoutModeFor(fontScale) !== 'normal';
    const line = (size: number, ratio: number) => Math.round(size * ratio) * fontScale;
    const column = 2 * line(15, LINE_HEIGHT[script]) + 2 + line(13, LINE_HEIGHT.latin) + (due ? 2 * line(13, LINE_HEIGHT[script]) : 0);
    const chip = compact ? 4 + line(11, LINE_HEIGHT[script]) : 8 + line(13, LINE_HEIGHT[script]);
    const icon = compact || narrow ? 0 : isRanged ? 40 : 28;
    const row = narrow ? column + 6 + chip : Math.max(icon, column, chip);
    const overlap = conflict ? 6 + 8 + 2 * line(13, LINE_HEIGHT[script]) : 0;
    return Math.ceil(2 + (isRanged ? 24 : 16) + row + overlap);
  }

  /** `HH:MM`, `minutes` after `from`. */
  function clockAfter(from: string, minutes: number): string {
    const [h, m] = from.split(':').map(Number) as [number, number];
    const total = h * 60 + m + minutes;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  /** The first whole minute at or after `points` of timeline. */
  const minutesFor = (points: number) => Math.ceil((points * 60) / HOUR_HEIGHT);

  function frameOf(testID: string) {
    const style = flatStyle(screen.getByTestId(testID));
    return { top: Number(style.top), height: Number(style.height), start: String(style.start), width: String(style.width) };
  }

  it.each<[string, number, number, string]>([
    ['default size on a phone', 1, 390, '12:30'],
    ['AX5 on a wide window', 3.12, 900, '17:30'],
  ])('%s: the two-line title above a short block in its shared lane keeps exactly its tallest height', async (_label, fontScale, width, blockAt) => {
    atScale(fontScale, width);
    await showTimeline([commitmentRow(LONG_RANGE), commitmentRow(WRAPPING), weeklyAt(blockAt, clockAfter(blockAt, 20))]);
    expect(screen.queryByTestId('calendar-timeline')).not.toBeNull();
    const card = frameOf('m6-timeline-block-c-accountant');
    const block = frameOf('m6-timeline-block-weekly-prayer');
    // The scenario: the card and the short block share a lane, beside the long range.
    expect(card.start).toBe(block.start);
    expect(card.width).toBe('50%');
    expect(screen.getByTestId('m6-calendar-title-accountant').props.numberOfLines).toBe(2);
    // Safe and tight: exactly the tallest card, and it ends before the block.
    expect(card.height).toBe(tallestCard({ narrow: true, fontScale }));
    expect(card.top + card.height).toBeLessThanOrEqual(block.top);
  });

  it('the screenshot\'s day (the block 2 h under the card): the block cannot share the card\'s lane, and three lanes do not fit a phone, so it is the list', async () => {
    await showTimeline([commitmentRow(LONG_RANGE), commitmentRow(WRAPPING), weeklyAt('12:00', '12:20')]);
    expect(screen.queryByTestId('calendar-timeline')).toBeNull();
    const list = screen.getByTestId('calendar-agenda-list');
    for (const id of ['calendar-item-conference', 'calendar-item-accountant', 'calendar-weekly-prayer']) expect(within(list).queryByTestId(id)).not.toBeNull();
  });

  it('Q788B-001 beside nothing: a two-line title is clamped and reserved, and the next entry at the lane boundary is not covered', async () => {
    const tallest = tallestCard({});
    expect(tallest).toBe(90); // 2 + 16 + 2 × 26 + 2 + 18: the 70 kept before was 20 short.
    const next = clockAfter('10:00', minutesFor(tallest));
    await showTimeline([commitmentRow(WRAPPING), weeklyAt(next, clockAfter(next, 20))]);
    const card = frameOf('m6-timeline-block-c-accountant');
    const block = frameOf('m6-timeline-block-weekly-prayer');
    expect(card.width).toBe('100%');
    expect(block.width).toBe('100%');
    expect(screen.getByTestId('m6-calendar-title-accountant').props.numberOfLines).toBe(2);
    expect(String(screen.getByTestId('calendar-item-accountant').props.accessibilityLabel)).toContain('اتصال مع المحاسبة بخصوص الضرائب السنوية');
    expect(card.height).toBe(tallest);
    expect(card.top + card.height).toBeLessThanOrEqual(block.top);
  });

  it('Q788B-001 at text size 0.8, a short ranged card keeps its fixed icon and padding: never under-reserved', async () => {
    atScale(0.8);
    await showTimeline([commitmentRow(ranged('short', 'x', '10:00', '10:15'))]);
    const card = frameOf('m6-timeline-block-c-short');
    // 2 + 24 + the 40-pt icon at least: the text shrinks, the chrome does not.
    expect(card.height).toBeGreaterThanOrEqual(66);
    expect(card.height).toBe(tallestCard({ ranged: true, fontScale: 0.8 }));
  });

  it('Q788B-001 pure: where the text is shorter than the icon tile, the tile sets the row (fixed 2 + 24 + 40)', () => {
    for (const script of ['latin', 'arabic', 'hebrew'] as const) {
      const height = timelineCardHeight({ ranged: true, narrow: false, due: false, conflict: false, scale: 0.5, script });
      expect(height).toBe(tallestCard({ ranged: true, fontScale: 0.5, script }));
      expect(height).toBeGreaterThanOrEqual(66);
    }
    expect(timelineCardHeight({ ranged: false, narrow: false, due: false, conflict: false, scale: 0.3, script: 'latin' })).toBe(2 + 16 + 28);
  });

  // A due and an all-day overlap that wrap in a 138-pt lane, clamped at two lines each.
  const DUES = {
    ar: 'موعدها بكرا · 15:00، قبل اجتماع الفريق الأسبوعي مع المدير الجديد',
    en: 'Due tomorrow · 15:00, before the weekly team meeting with the new manager',
    he: 'מועד היעד מחר · 15:00, לפני פגישת הצוות השבועית עם המנהל החדש',
  } as const;
  it.each<['ar' | 'en' | 'he']>([['ar'], ['en'], ['he']])('Q788B-002 (%s) at the minimum lane width, a wrapping due and a three-line overlap are clamped and reserved exactly', async (lang) => {
    // Two lanes of exactly the floor: 2 × minLaneWidth(1) = 276 pt of lanes.
    const width = 276 + 390 - timelineLaneWidth(390);
    expect(timelineLaneWidth(width) / 2).toBe(minLaneWidth(1));
    atScale(1, width);
    harness = await prepareM6(lang);
    const busy = { nativeId: 'all-day', startAt: instant(TODAY, '00:00'), endAt: instant(TODAY, '23:59'), allDay: true };
    const row = { ...commitmentRow(WRAPPING), due: DUES[lang], conflict: busy };
    await render(<Providers harness={harness}><DayTimeline rows={[commitmentRow(LONG_RANGE), row]} day={TODAY} nowIso={null} /></Providers>);
    expect(screen.queryByTestId('calendar-timeline')).not.toBeNull();
    const card = frameOf('m6-timeline-block-c-accountant');
    expect(card.width).toBe('50%');
    expect(screen.getByTestId('calendar-due-accountant').props.numberOfLines).toBe(2);
    expect(screen.getByTestId('calendar-conflict-text-accountant').props.numberOfLines).toBe(2);
    // The clamped words are still all said.
    const label = String(screen.getByTestId('calendar-item-accountant').props.accessibilityLabel);
    expect(label).toContain(DUES[lang]);
    expect(label).toContain(String(screen.getByTestId('calendar-conflict-text-accountant').props.children));
    expect(card.height).toBe(tallestCard({ narrow: true, due: true, conflict: true, script: SCRIPT[lang] }));
  });

  it('Q788B-002 the ordered list still never clamps the due or the overlap', async () => {
    harness = await prepareM6('ar');
    const busy = { nativeId: 'all-day', startAt: instant(TODAY, '00:00'), endAt: instant(TODAY, '23:59'), allDay: true };
    await render(<Providers harness={harness}><DayAgenda rows={[{ ...commitmentRow(WRAPPING), due: DUES.ar, conflict: busy }]} day={TODAY} /></Providers>);
    expect(screen.getByTestId('calendar-due-accountant').props.numberOfLines ?? 0).toBe(0);
    expect(screen.getByTestId('calendar-conflict-text-accountant').props.numberOfLines ?? 0).toBe(0);
  });

  it('Q788B-003 tight at large text: the compact chip and unscaled chrome keep a block in the card\'s lane, so no third lane and no list', async () => {
    atScale(1.35, 500);
    const tallest = tallestCard({ narrow: true, fontScale: 1.35 });
    // Scaling the whole 126-pt card instead would keep 170 and push the block into a third lane.
    expect(tallest).toBeLessThan(126 * 1.35);
    const next = clockAfter('10:00', minutesFor(tallest));
    await showTimeline([commitmentRow(LONG_RANGE), commitmentRow(WRAPPING), weeklyAt(next, clockAfter(next, 20))]);
    expect(screen.queryByTestId('calendar-timeline')).not.toBeNull();
    const card = frameOf('m6-timeline-block-c-accountant');
    const block = frameOf('m6-timeline-block-weekly-prayer');
    expect(card.width).toBe('50%');
    expect(block.start).toBe(card.start);
    expect(card.height).toBe(tallest);
    expect(card.top + card.height).toBeLessThanOrEqual(block.top);
  });
});

/**
 * Q788b-B (simulator pass 2026-10-23, screenshot 08): at AX5 the dense row's
 * «بدون وقت» sat beside the title and squeezed it until «فاتورة» broke inside
 * itself. At the large text sizes the time moves onto the second line, beside
 * the importance chip, and the title has the row to itself.
 */
describe('Q788b-B the dense row gives the title its whole row at large text', () => {
  // «فاتورة الكهربا» with no hour: the untimed list says «بدون وقت».
  const BILL = commitment('bill', { title: 'فاتورة الكهربا', timeSpec: { kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: ZONE } });
  const billRow = (): Extract<PlanRow, { kind: 'commitment' }> => ({
    kind: 'commitment', key: 'c-bill', at: Number.POSITIVE_INFINITY, item: toViewModel(BILL, NOW.toISOString()), clock: null, offDay: false, due: null, conflict: null,
  });

  it('at AX5 the title and the time are not in one row: the time sits on the second line', async () => {
    atScale(3.12);
    harness = await prepareM6('ar');
    await render(<Providers harness={harness}><UntimedSection rows={[billRow()]} title="t" /></Providers>);
    const titleRow = screen.getByTestId('calendar-title-row-bill');
    expect(within(titleRow).queryByTestId('m6-calendar-title-bill')).not.toBeNull();
    expect(within(titleRow).queryByTestId('calendar-time-bill')).toBeNull();
    const time = within(screen.getByTestId('calendar-meta-bill')).getByTestId('calendar-time-bill');
    expect(time.props.children).toBe(ar.noTimeYet);
  });

  it('at the default size the time stays beside the title', async () => {
    harness = await prepareM6('ar');
    await render(<Providers harness={harness}><UntimedSection rows={[billRow()]} title="t" /></Providers>);
    const titleRow = screen.getByTestId('calendar-title-row-bill');
    expect(flatStyle(titleRow).flexDirection).toBe('row');
    expect(within(titleRow).queryByTestId('m6-calendar-title-bill')).not.toBeNull();
    expect(within(titleRow).getByTestId('calendar-time-bill').props.children).toBe(ar.noTimeYet);
    expect(within(screen.getByTestId('calendar-meta-bill')).queryByTestId('calendar-time-bill')).toBeNull();
  });
});
