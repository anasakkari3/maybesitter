/**
 * The Plan tab's timeline geometry (Stitch `02-plan`): equal hours, blocks as
 * tall as they last, commitments as markers with no invented duration, and
 * lanes only for what would otherwise sit on top of each other.
 */
import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_FROM_HOUR, DEFAULT_TO_HOUR, HOUR_HEIGHT,
  dayLoad, hourWindow, minuteOfDay, placeSpans, yOf, type TimelineSpan,
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

describe('dayLoad', () => {
  it('is a word from what is on the day', () => {
    expect(dayLoad(0)).toBe('light');
    expect(dayLoad(1)).toBe('normal');
    expect(dayLoad(2)).toBe('normal');
    expect(dayLoad(3)).toBe('full');
  });
});
