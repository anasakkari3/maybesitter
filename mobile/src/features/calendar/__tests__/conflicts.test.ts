/**
 * What a commitment runs into (UC-3.2, #186 step 7).
 *
 * The edges are the whole content of this file. A commitment at exactly the
 * instant a meeting ends is *not* in it, and one at exactly the instant a
 * meeting starts *is* — that is the half-open rule the rest of the product
 * uses, and getting it the other way round means a chip on the 15:00 item for
 * the 14:00–15:00 call the user has just walked out of, every single day.
 *
 * Instants are derived from the clock this process runs on, so the file says
 * the same thing in the developer's zone and in CI's UTC.
 */
import { describe, expect, it } from '@jest/globals';
import { busyAt, chipBlock, conflictsFor } from '../conflicts';
import type { DeviceBusyBlock } from '../busyBlocks';

const NOW = new Date();
const MINUTE = 60_000;

function at(minutes: number): string {
  return new Date(NOW.getTime() + minutes * MINUTE).toISOString();
}

function block(from: number, to: number, allDay = false): DeviceBusyBlock {
  return { nativeId: `b${from}`, startAt: at(from), endAt: at(to), allDay };
}

describe('an instant against a busy interval', () => {
  const lecture = block(60, 120);

  it('is inside it when it is inside it', () => {
    expect(busyAt(at(90), [lecture])).toEqual([lecture]);
  });

  it('is inside it at the very instant it begins', () => {
    expect(busyAt(at(60), [lecture])).toEqual([lecture]);
  });

  it('is not inside it at the instant it ends', () => {
    expect(busyAt(at(120), [lecture])).toEqual([]);
  });

  it('is not inside it a minute before it begins', () => {
    expect(busyAt(at(59), [lecture])).toEqual([]);
  });

  it('reports every overlapping block, earliest first', () => {
    const wide = block(0, 240);
    expect(busyAt(at(90), [lecture, wide]).map((found) => found.startAt)).toEqual([at(0), at(60)]);
  });

  it('answers nothing for a time nobody could parse', () => {
    expect(busyAt('tomorrow-ish', [lecture])).toEqual([]);
  });
});

describe('a screen full of items', () => {
  const blocks = [block(60, 120), block(300, 360, true)];

  it('names only the items that run into something', () => {
    const map = conflictsFor([
      { id: 'a', at: at(90) },
      { id: 'b', at: at(200) },
      { id: 'c', at: at(330) },
    ], blocks);
    expect([...map.keys()].sort()).toEqual(['a', 'c']);
  });

  it('says nothing about an item with no time yet', () => {
    expect(conflictsFor([{ id: 'a', at: null }], blocks).size).toBe(0);
  });

  it('says nothing at all when the calendar is empty', () => {
    expect(conflictsFor([{ id: 'a', at: at(90) }], []).size).toBe(0);
  });
});

describe('which block a chip names', () => {
  it('prefers a timed one, because it has times to show', () => {
    const timed = block(60, 120);
    expect(chipBlock([block(0, 60 * 24, true), timed])).toBe(timed);
  });

  it('falls back to the all-day one when that is all there is', () => {
    const holiday = block(0, 60 * 24, true);
    expect(chipBlock([holiday])).toBe(holiday);
  });

  it('is null when there is nothing to name', () => {
    expect(chipBlock([])).toBeNull();
  });
});
