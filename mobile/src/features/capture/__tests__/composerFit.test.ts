/**
 * The composer field fits the room the keyboard leaves (UAT round 6, #5).
 *
 * On the iPhone with the software keyboard up, the field was 313–531pt, the
 * `capture-scroll` viewport ended at 462 and the «فهمها» footer covered
 * 462–538: the field kept its fixed 220pt cap, so its bottom 69pt — where the
 * caret sits while typing — was under the footer, and nothing scrolled.
 *
 * The numbers here are that device's: a viewport of ~207pt with the field's
 * top 58pt into the scroll content.
 */
import { describe, expect, it } from '@jest/globals';
import {
  FIELD_FLOOR,
  FIELD_MARGIN,
  FIELD_MIN_HEIGHT,
  FIELD_ONE_LINE,
  FIELD_PADDING,
  fieldHeights,
  revealOffset,
} from '../composerFit';

describe('fieldHeights', () => {
  it('before the ScrollView has been measured, keeps the resting cap', () => {
    expect(fieldHeights({ viewport: 0, fieldTop: 0, cap: 220 })).toEqual({ maxHeight: 220, minHeight: FIELD_MIN_HEIGHT });
  });

  it('with the keyboard down there is room: the resting cap and min stand', () => {
    expect(fieldHeights({ viewport: 560, fieldTop: 58, cap: 220 })).toEqual({ maxHeight: 220, minHeight: FIELD_MIN_HEIGHT });
    expect(fieldHeights({ viewport: 560, fieldTop: 58, cap: 260 }).maxHeight).toBe(260);
  });

  it('the UAT device: the field ends above the footer instead of 69pt under it', () => {
    const viewport = 207;
    const fieldTop = 58;
    const { maxHeight, minHeight } = fieldHeights({ viewport, fieldTop, cap: 220 });
    expect(fieldTop + maxHeight).toBeLessThanOrEqual(viewport - FIELD_MARGIN);
    expect(maxHeight).toBe(viewport - FIELD_MARGIN - fieldTop);
    expect(minHeight).toBeLessThanOrEqual(maxHeight);
  });

  it('when the space under the label is too small, keeps a usable floor (the ScrollView reveals it)', () => {
    const { maxHeight, minHeight } = fieldHeights({ viewport: 150, fieldTop: 58, cap: 220 });
    expect(maxHeight).toBe(FIELD_FLOOR);
    expect(minHeight).toBe(FIELD_FLOOR);
  });

  it('never taller than the viewport itself, so scrolling can always show all of it', () => {
    const { maxHeight } = fieldHeights({ viewport: 100, fieldTop: 58, cap: 220 });
    expect(maxHeight).toBe(100 - FIELD_MARGIN);
  });

  it('a viewport smaller than one line still leaves one line', () => {
    expect(fieldHeights({ viewport: 40, fieldTop: 58, cap: 220 }).maxHeight).toBe(FIELD_ONE_LINE);
  });

  it('at large Dynamic Type the floors follow the line: two lines before the label gives way, one always', () => {
    // Arabic at 20pt × 1.6 = 32pt a line, at fontScale 3: 96pt.
    const line = 96;
    expect(fieldHeights({ viewport: 330, fieldTop: 130, cap: 260, line }).maxHeight).toBe(FIELD_PADDING + 2 * line);
    expect(fieldHeights({ viewport: 120, fieldTop: 130, cap: 260, line }).maxHeight).toBe(FIELD_PADDING + line);
    // At the base size the constant floors hold.
    expect(fieldHeights({ viewport: 150, fieldTop: 58, cap: 220, line: 32 }).maxHeight).toBe(FIELD_FLOOR);
  });

  it('large Dynamic Type pushes the field lower; the fit follows the measured top', () => {
    // A two-line label at XXXL: the field starts 130pt in.
    const { maxHeight } = fieldHeights({ viewport: 330, fieldTop: 130, cap: 260 });
    expect(maxHeight).toBe(330 - FIELD_MARGIN - 130);
  });
});

describe('revealOffset', () => {
  it('a field that already fits needs no scroll', () => {
    expect(revealOffset({ scrollY: 0, fieldTop: 58, fieldHeight: 141, viewport: 207 })).toBeNull();
  });

  it('a field whose bottom is under the footer scrolls just far enough to show it', () => {
    // The old geometry: 220pt field in a 207pt viewport, 58pt down.
    const y = revealOffset({ scrollY: 0, fieldTop: 58, fieldHeight: 120, viewport: 150 });
    expect(y).toBe(58 + 120 + FIELD_MARGIN - 150);
  });

  it('scrolled past the field (reading the privacy line), comes back to its top', () => {
    expect(revealOffset({ scrollY: 300, fieldTop: 58, fieldHeight: 141, viewport: 207 })).toBe(58);
  });

  it('a partial scroll that still shows the whole field is left alone', () => {
    expect(revealOffset({ scrollY: 20, fieldTop: 58, fieldHeight: 120, viewport: 207 })).toBeNull();
  });

  it('a field taller than the viewport shows its bottom, where the caret types', () => {
    expect(revealOffset({ scrollY: 0, fieldTop: 58, fieldHeight: 300, viewport: 207 })).toBe(58 + 300 + FIELD_MARGIN - 207);
  });

  it('before anything is measured, does nothing', () => {
    expect(revealOffset({ scrollY: 0, fieldTop: 58, fieldHeight: 0, viewport: 207 })).toBeNull();
    expect(revealOffset({ scrollY: 0, fieldTop: 58, fieldHeight: 141, viewport: 0 })).toBeNull();
  });
});
