/**
 * The Plan tab's timeline geometry (Stitch `02-plan`): equal hours, blocks as
 * tall as they last, commitments as markers with no invented duration, and
 * lanes only for what would otherwise sit on top of each other.
 */
import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_FROM_HOUR, DEFAULT_TO_HOUR, HOUR_HEIGHT,
  dayLoad, hourWindow, lanesFit, maxLanes, minLaneWidth, minuteOfDay, placeSpans, yOf, type TimelineSpan,
} from '../dayTimeline';

const ZONE = 'Asia/Jerusalem';
const DAY = '2026-10-01';

describe('minuteOfDay', () => {
  it('reads the clock in the given zone, not UTC', () => {
    // 15:30 UTC is 18:30 in Jerusalem (+03 in October).
    expect(minuteOfDay('2026-10-01T15:30:00.000Z', DAY, ZONE)).toBe(18 * 60 + 30);
  });

  it('clips an instant on another day to the edge of this one', () => {
    expect(minuteOfDay('2026-09-30T20:00:00.000Z', DAY, ZONE)).toBe(0); // 23:00 the day before
    expect(minuteOfDay('2026-10-01T22:00:00.000Z', DAY, ZONE)).toBe(24 * 60); // 01:00 the day after
  });
});

describe('hourWindow', () => {
  const span = (start: number, end: number | null): TimelineSpan => ({ key: `${start}`, start, end, minVisual: 44 });

  it('draws 08:00–23:00 when the day sits inside it', () => {
    expect(hourWindow([span(9 * 60, 10 * 60), span(17 * 60, null)])).toEqual({ from: DEFAULT_FROM_HOUR, to: DEFAULT_TO_HOUR });
  });

  it('widens to an early start and a late end, never past the day', () => {
    expect(hourWindow([span(6 * 60 + 30, 7 * 60)])).toEqual({ from: 6, to: DEFAULT_TO_HOUR });
    expect(hourWindow([span(23 * 60 + 30, 24 * 60)])).toEqual({ from: DEFAULT_FROM_HOUR, to: 24 });
    // A marker in the last hour still gets that hour under it.
    expect(hourWindow([span(23 * 60 + 15, null)])).toEqual({ from: DEFAULT_FROM_HOUR, to: 24 });
  });
});

describe('placeSpans', () => {
  it('makes every hour the same height and a block exactly as tall as it lasts', () => {
    const [block] = placeSpans([{ key: 'busy', start: 14 * 60, end: 15 * 60 + 30, minVisual: 44 }], 8);
    expect(block!.top).toBe(6 * HOUR_HEIGHT);
    expect(block!.height).toBe(1.5 * HOUR_HEIGHT);
    expect(yOf(9 * 60, 8) - yOf(8 * 60, 8)).toBe(yOf(22 * 60, 8) - yOf(21 * 60, 8));
  });

  it('gives a commitment no duration: a marker has no height of its own', () => {
    const [marker] = placeSpans([{ key: 'call', start: 17 * 60, end: null, minVisual: 70 }], 8);
    expect(marker!.top).toBe(9 * HOUR_HEIGHT);
    expect(marker!.height).toBe(0);
    // Its label still gets room, which is a separate number.
    expect(marker!.visual).toBe(70);
  });

  it('keeps a short block\'s true height while reserving room for its label', () => {
    const [short] = placeSpans([{ key: 'quick', start: 10 * 60, end: 10 * 60 + 15, minVisual: 58 }], 8);
    expect(short!.height).toBe(HOUR_HEIGHT / 4);
    expect(short!.visual).toBe(58);
  });

  it('sets overlapping entries side by side, and only those', () => {
    const placed = placeSpans([
      { key: 'busy', start: 18 * 60, end: 19 * 60, minVisual: 58 },
      { key: 'dentist', start: 18 * 60 + 30, end: null, minVisual: 70 },
      { key: 'match', start: 20 * 60, end: 22 * 60, minVisual: 58 },
    ], 8);
    const by = Object.fromEntries(placed.map(entry => [entry.key, entry]));
    expect(by.busy).toMatchObject({ lane: 0, lanes: 2 });
    expect(by.dentist).toMatchObject({ lane: 1, lanes: 2 });
    expect(by.match).toMatchObject({ lane: 0, lanes: 1 });
  });

  it('reuses a lane once the entry in it has ended', () => {
    const placed = placeSpans([
      { key: 'a', start: 9 * 60, end: 12 * 60, minVisual: 58 },
      { key: 'b', start: 9 * 60 + 30, end: 10 * 60, minVisual: 28 },
      { key: 'c', start: 10 * 60 + 30, end: 11 * 60, minVisual: 28 },
    ], 8);
    const by = Object.fromEntries(placed.map(entry => [entry.key, entry]));
    expect(by.b!.lane).toBe(1);
    expect(by.c!.lane).toBe(1);
    expect([by.a!.lanes, by.b!.lanes, by.c!.lanes]).toEqual([2, 2, 2]);
  });
});

describe('#738: a lane never gets narrower than its words', () => {
  // The simulator pass of 2026-10-23, with the label room PlanDay asks for at
  // text size 1: a commitment 70 (98 as a column), a block 58 (88).
  const commitment = (key: string, start: number, end: number | null): TimelineSpan => ({ key, start, end, minVisual: 70, narrowVisual: 98 });
  const repro: TimelineSpan[] = [
    commitment('offsite', 9 * 60, 17 * 60),
    { key: 'weekly', start: 10 * 60, end: 12 * 60, minVisual: 58, narrowVisual: 88 },
    commitment('lawyer', 10 * 60, null),
    commitment('dentist', 10 * 60 + 30, 11 * 60 + 30),
    commitment('call', 11 * 60, 13 * 60),
  ];
  // The lanes' width on a 402-pt and a 390-pt phone: the window less the
  // screen's padding (2×16), the timeline card's (2×9) and the hour gutter (52).
  const PRO = 402 - 102;
  const PHONE = 390 - 102;

  it('the five-item day needs five lanes at once, which a phone cannot hold at the floor, so it is not drawn on hours', () => {
    const placed = placeSpans(repro, 8);
    expect(maxLanes(placed)).toBe(5);
    expect(PRO / 5).toBeLessThan(minLaneWidth(1));
    expect(lanesFit(placed, PRO, 1)).toBe(false);
    expect(lanesFit(placed, PHONE, 1)).toBe(false);
  });

  it('whenever the lanes are kept, none is narrower than the floor', () => {
    const placed = placeSpans(repro, 8);
    for (let width = 200; width <= 1400; width += 10) {
      for (const scale of [1, 1.12, 1.2, 1.35, 1.64, 3.12]) {
        if (lanesFit(placed, width, scale)) {
          for (const entry of placed) expect(width / entry.lanes).toBeGreaterThanOrEqual(minLaneWidth(scale));
        }
      }
    }
  });

  it('keeps the first half of #738: a 09:00–17:00 range beside the 10:00 lawyer still fits a phone in two lanes', () => {
    const placed = placeSpans([commitment('offsite', 9 * 60, 17 * 60), commitment('lawyer', 10 * 60, null)], 8);
    expect(maxLanes(placed)).toBe(2);
    expect(lanesFit(placed, PHONE, 1)).toBe(true);
    expect(placed.find(entry => entry.key === 'offsite')!.height).toBe(8 * HOUR_HEIGHT);
  });

  it('raises the floor with the text: the same two lanes do not fit at AX5', () => {
    const placed = placeSpans([commitment('offsite', 9 * 60, 17 * 60), commitment('lawyer', 10 * 60, null)], 8);
    expect(minLaneWidth(3.12)).toBeGreaterThan(minLaneWidth(1));
    expect(lanesFit(placed, PHONE, 3.12)).toBe(false);
  });

  it('reserves a shared entry\'s room at its column height, and one alone at its row height', () => {
    const placed = placeSpans([commitment('a', 9 * 60, null), commitment('b', 9 * 60 + 30, null), commitment('c', 15 * 60, null)], 8);
    const by = Object.fromEntries(placed.map(entry => [entry.key, entry]));
    expect([by.a!.lanes, by.b!.lanes]).toEqual([2, 2]);
    expect([by.a!.visual, by.b!.visual]).toEqual([98, 98]);
    expect(by.c).toMatchObject({ lanes: 1, visual: 70 });
  });
});

describe('dayLoad', () => {
  it('is a word from what is on the day', () => {
    expect(dayLoad(0)).toBe('light');
    expect(dayLoad(1)).toBe('normal');
    expect(dayLoad(2)).toBe('normal');
    expect(dayLoad(3)).toBe('full');
  });
});
