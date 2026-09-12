import { describe, expect, it } from '@jest/globals';
import { findOverlaps, intervalsOverlap, isPositiveInterval, mergeBusy } from '../overlap';

/**
 * The conflict rule, pinned against the server's.
 *
 * `lib/planning/shared/time.ts` fixed one convention for the whole product:
 * half-open `[start, end)`, strict `<` on both sides, and a zero-length
 * interval intersecting nothing. A demo that drifted from it would refuse a
 * time the real planner allows — and both halves would look correct in
 * isolation, which is why this is asserted rather than reviewed.
 */

const at = (hour: number, minute = 0) =>
  `2026-09-17T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
const span = (fromHour: number, toHour: number) => ({ start: at(fromHour), end: at(toHour) });

describe('two intervals', () => {
  it('overlap when they share any time', () => {
    expect(intervalsOverlap(span(9, 11), span(10, 12))).toBe(true);
    expect(intervalsOverlap(span(10, 12), span(9, 11))).toBe(true);
    // Fully contained, both ways round.
    expect(intervalsOverlap(span(9, 17), span(10, 11))).toBe(true);
    expect(intervalsOverlap(span(10, 11), span(9, 17))).toBe(true);
  });

  it('do not overlap when they merely abut', () => {
    // The whole content of "end times are exclusive". A back-to-back meeting
    // is not a conflict, and a rule that said otherwise would make the app
    // refuse every sensible afternoon.
    expect(intervalsOverlap(span(9, 10), span(10, 11))).toBe(false);
    expect(intervalsOverlap(span(10, 11), span(9, 10))).toBe(false);
  });

  it('do not overlap when they are simply apart', () => {
    expect(intervalsOverlap(span(9, 10), span(14, 15))).toBe(false);
  });

  it('never overlap when either is zero-length or reversed', () => {
    // `[09:00, 09:00)` is the empty set. The textbook formula reports it as
    // overlapping anything containing 09:00, which is wrong.
    expect(intervalsOverlap({ start: at(9), end: at(9) }, span(8, 10))).toBe(false);
    expect(intervalsOverlap(span(8, 10), { start: at(9), end: at(9) })).toBe(false);
    expect(intervalsOverlap({ start: at(11), end: at(10) }, span(8, 12))).toBe(false);
  });

  it('refuses to guess at a value that is not an instant', () => {
    expect(() => isPositiveInterval({ start: 'thursday', end: at(10) })).toThrow();
  });
});

describe('finding what a proposed time collides with', () => {
  const busy = [span(9, 10), span(13, 14), span(16, 18)];

  it('names every colliding block, not just the first', () => {
    expect(findOverlaps([span(9, 11), span(10, 12)], span(10, 11))).toEqual([span(9, 11), span(10, 12)]);
  });

  it('finds nothing for a free time', () => {
    expect(findOverlaps(busy, span(11, 12))).toEqual([]);
  });

  it('finds nothing for a time that starts exactly when a block ends', () => {
    expect(findOverlaps(busy, span(10, 11))).toEqual([]);
    expect(findOverlaps(busy, span(14, 16))).toEqual([]);
  });

  it('finds the one block a partly-overlapping time hits', () => {
    expect(findOverlaps(busy, span(17, 19))).toEqual([span(16, 18)]);
  });

  it('finds nothing for a zero-length candidate', () => {
    expect(findOverlaps(busy, { start: at(9, 30), end: at(9, 30) })).toEqual([]);
  });
});

describe('merging busy time for display', () => {
  it('collapses the same meeting reported by two calendars', () => {
    expect(mergeBusy([span(9, 10), span(9, 10)])).toEqual([span(9, 10)]);
  });

  it('joins overlapping and abutting blocks into one', () => {
    // For *display* abutting blocks do join: 09:00–10:00 then 10:00–11:00 is
    // one busy stretch of two hours, even though it is not a conflict.
    expect(mergeBusy([span(9, 10), span(10, 11), span(10, 12)])).toEqual([span(9, 12)]);
  });

  it('keeps separate blocks separate, in time order', () => {
    expect(mergeBusy([span(16, 18), span(9, 10)])).toEqual([span(9, 10), span(16, 18)]);
  });

  it('keeps a block that is fully inside another from shortening it', () => {
    expect(mergeBusy([span(9, 17), span(10, 11)])).toEqual([span(9, 17)]);
  });

  it('drops degenerate intervals rather than rendering an empty row', () => {
    expect(mergeBusy([{ start: at(9), end: at(9) }, span(10, 11)])).toEqual([span(10, 11)]);
  });
});
