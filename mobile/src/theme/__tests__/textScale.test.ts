/**
 * The text-size ramp (Round 2 `--ts`).
 *
 * Two claims worth a test:
 *
 *  1. Text never renders past the ceiling the design lays out. Without one,
 *     the OS scales labels without limit and the tab bar's pill breaks.
 *  2. A reader between two steps is never served *less* text than they asked
 *     for. The export snaps to one of three numbers; the app does not, and
 *     that difference is the whole reason `effectiveTextScale` is separate
 *     from `textStepFor`.
 */
import { describe, expect, it } from '@jest/globals';
import { MAX_TEXT_SCALE, TEXT_SCALE, effectiveTextScale, textStepFor } from '../textScale';

describe('textStepFor', () => {
  it('picks the step at each of the ramp values', () => {
    expect(textStepFor(TEXT_SCALE.default)).toBe('default');
    expect(textStepFor(TEXT_SCALE.large)).toBe('large');
    expect(textStepFor(TEXT_SCALE.xl)).toBe('xl');
  });

  it('switches at the midpoint between steps, not at the step itself', () => {
    // 1.1 is the midpoint of 1 and 1.2; 1.325 the midpoint of 1.2 and 1.45.
    expect(textStepFor(1.09)).toBe('default');
    expect(textStepFor(1.1)).toBe('large');
    expect(textStepFor(1.32)).toBe('large');
    expect(textStepFor(1.325)).toBe('xl');
  });

  it('stays at xl above the ramp', () => {
    // iOS accessibility sizes reach past 3x. There is no step beyond xl, and
    // the layout for it must not fall back to a smaller one.
    expect(textStepFor(2)).toBe('xl');
    expect(textStepFor(3.1)).toBe('xl');
  });

  it('reads a missing or nonsense scale as default, not as the most degraded layout', () => {
    expect(textStepFor(undefined)).toBe('default');
    expect(textStepFor(NaN)).toBe('default');
    // Infinity is nonsense, not "very large": it is treated like a missing
    // reading rather than trusted into the most degraded layout.
    expect(textStepFor(Infinity)).toBe('default');
    expect(effectiveTextScale(Infinity)).toBe(1);
  });
});

describe('effectiveTextScale', () => {
  it('holds at the ceiling', () => {
    expect(effectiveTextScale(3.1)).toBe(MAX_TEXT_SCALE);
    expect(effectiveTextScale(1.45)).toBe(1.45);
  });

  it('does not round a reader down to the nearest step', () => {
    // The export would serve 1.2 here. Serving someone less text than they
    // asked for is the one thing this ramp must not do.
    expect(effectiveTextScale(1.35)).toBe(1.35);
    expect(effectiveTextScale(1.05)).toBe(1.05);
  });

  it('never shrinks text below 1', () => {
    expect(effectiveTextScale(0.8)).toBe(1);
    expect(effectiveTextScale(undefined)).toBe(1);
    expect(effectiveTextScale(NaN)).toBe(1);
  });
});
