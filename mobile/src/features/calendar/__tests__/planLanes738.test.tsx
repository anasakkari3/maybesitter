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
import { DayAgenda, DayTimeline, UntimedSection, timelineLaneWidth, timelineSpans, type PlanRow } from '../PlanDay';
import { HOUR_HEIGHT, lanesFit, maxLanes, placeSpans } from '../dayTimeline';
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
 * 12:00 «صلاة الظهر» block under it. The room kept for a shared-lane card is
 * now the most it can draw, with its title clamped to two lines.
 */
describe('Q788b-A a shared-lane card never covers the next block in its lane', () => {
  // A title that wraps in any lane the floor allows: «اتصال مع المحاسبة بخصوص الضرائب السنوية».
  const WRAPPING = ranged('accountant', 'اتصال مع المحاسبة بخصوص الضرائب السنوية', '10:00', null);
  const LONG_RANGE = ranged('conference', 'مؤتمر المبادرين بالجامعة', '09:00', '19:00', 'high');
  const weeklyAt = (from: string, to: string): PlanRow => ({
    kind: 'weekly', key: 'weekly-prayer', at: Date.parse(instant(TODAY, from)),
    occurrence: { occurrenceId: 'prayer-1', weeklyBlockId: 'prayer', title: 'صلاة الظهر', startAt: instant(TODAY, from), endAt: instant(TODAY, to) },
  });

  /**
   * The tallest the card can draw at `fontScale`, worked out apart from the
   * code under test: the border, padding and gaps stay; RN scales each text's
   * line box (15-pt title × 2 lines, 13-pt Latin time, the chip's word).
   */
  function tallestCard(fontScale: number): number {
    const compact = layoutModeFor(fontScale) !== 'normal';
    const line = (size: number, ratio: number) => Math.round(size * ratio) * fontScale;
    const title = 2 * line(15, LINE_HEIGHT.arabic);
    const time = line(13, LINE_HEIGHT.latin);
    const chip = (compact ? 4 : 8) + line(compact ? 11 : 13, LINE_HEIGHT.arabic);
    return 2 + 16 + title + 2 + time + 6 + chip;
  }

  function frameOf(testID: string) {
    const style = flatStyle(screen.getByTestId(testID));
    return { top: Number(style.top), height: Number(style.height), start: String(style.start), width: String(style.width) };
  }

  it.each<[string, number, number, string]>([
    ['default size on a phone', 1, 390, '12:30'],
    ['AX5 on a wide window', 3.12, 900, '17:30'],
  ])('%s: the two-line title above a short block in its lane keeps its whole height', async (_label, fontScale, width, blockAt) => {
    atScale(fontScale, width);
    const [h, m] = blockAt.split(':').map(Number) as [number, number];
    const blockEnd = `${String(h).padStart(2, '0')}:${String(m + 20).padStart(2, '0')}`;
    await showTimeline([commitmentRow(LONG_RANGE), commitmentRow(WRAPPING), weeklyAt(blockAt, blockEnd)]);
    expect(screen.queryByTestId('calendar-timeline')).not.toBeNull();

    const card = frameOf('m6-timeline-block-c-accountant');
    const block = frameOf('m6-timeline-block-weekly-prayer');
    // The scenario: the card and the short block share a lane, beside the long range.
    expect(card.start).toBe(block.start);
    expect(card.width).toBe('50%');
    expect(card.top).toBeLessThan(block.top);
    // The title stops at two lines, so the card can never draw past what was kept…
    expect(screen.getByTestId('m6-calendar-title-accountant').props.numberOfLines).toBe(2);
    // …and what was kept holds the tallest card, so it ends before the block starts.
    expect(card.height).toBeGreaterThanOrEqual(tallestCard(fontScale));
    expect(card.top + card.height).toBeLessThanOrEqual(block.top);
  });

  it('the screenshot\'s day (the block 2 h under the card): the block cannot share the card\'s lane, and three lanes do not fit a phone, so it is the list', async () => {
    await showTimeline([commitmentRow(LONG_RANGE), commitmentRow(WRAPPING), weeklyAt('12:00', '12:20')]);
    expect(screen.queryByTestId('calendar-timeline')).toBeNull();
    const list = screen.getByTestId('calendar-agenda-list');
    for (const id of ['calendar-item-conference', 'calendar-item-accountant', 'calendar-weekly-prayer']) expect(within(list).queryByTestId(id)).not.toBeNull();
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
