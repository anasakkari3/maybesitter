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
import { useWindowDimensions } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, within } from '@testing-library/react-native';
import { DayTimeline, timelineLaneWidth, timelineSpans, type PlanRow } from '../PlanDay';
import { HOUR_HEIGHT, lanesFit, maxLanes, placeSpans } from '../dayTimeline';
import { toViewModel } from '../../commitments/model';
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
const atScale = (fontScale: number) => dimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });

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
function ranged(id: string, title: string, from: string, to: string | null) {
  return commitment(id, {
    title,
    timeSpec: { kind: 'scheduled_event', dueAt: instant(TODAY, from), endAt: to ? instant(TODAY, to) : null, remindAt: null, allDay: false, timezone: ZONE },
  });
}

// «يوم عمل خارجي للفريق», «موعد مع المحامي», «موعد عند دكتور الأسنان», «مكالمة مع العميل الجديد».
const OFFSITE = ranged('offsite', 'يوم عمل خارجي للفريق', '09:00', '17:00');
const LAWYER = ranged('lawyer', 'موعد مع المحامي', '10:00', null);
const DENTIST = ranged('dentist', 'موعد عند دكتور الأسنان', '10:30', '11:30');
const CALL = ranged('call', 'مكالمة مع العميل الجديد', '11:00', '13:00');

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
  });

  it('at AX5, the day is the ordered list too', async () => {
    atScale(3.12);
    await showTimeline(REPRO);
    expectSafeList();
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
