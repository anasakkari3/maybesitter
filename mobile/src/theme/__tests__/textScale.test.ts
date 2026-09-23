/**
 * Text size versus layout mode (Round 2 `--ts`, corrected).
 *
 * The one thing this ramp must never do is serve a reader less text than they
 * asked for. Text scale is the OS number, continuous and uncapped. Layout mode
 * is a separate, discrete answer to "which structure", and it saturates at
 * `xl` while the text keeps growing.
 */
import { describe, expect, it } from '@jest/globals';
import { LAYOUT_MODE_FROM, layoutModeFor, textScaleOf } from '../textScale';

describe('textScaleOf never caps and never rounds', () => {
  it('passes every real reading through untouched', () => {
    for (const s of [0.82, 1, 1.12, 1.35, 1.45, 1.64, 2.0, 2.35, 3.12]) expect(textScaleOf(s)).toBe(s);
  });

  it('reads a missing or nonsense value as an ordinary phone', () => {
    expect(textScaleOf(undefined)).toBe(1);
    expect(textScaleOf(NaN)).toBe(1);
    expect(textScaleOf(Infinity)).toBe(1);
    expect(textScaleOf(0)).toBe(1);
    expect(textScaleOf(-1)).toBe(1);
  });
});

describe('layoutModeFor follows the platform content-size categories', () => {
  it('is normal through xLarge (1.12)', () => {
    expect(layoutModeFor(1)).toBe('normal');
    expect(layoutModeFor(1.12)).toBe('normal');
    expect(layoutModeFor(1.2)).toBe('normal');
  });

  it('is large from xxLarge (1.24) up to the accessibility sizes', () => {
    expect(layoutModeFor(LAYOUT_MODE_FROM.large)).toBe('large');
    expect(layoutModeFor(1.35)).toBe('large');
    expect(layoutModeFor(1.45)).toBe('large');
  });

  it('is xl from AX1 (1.64) and saturates there', () => {
    expect(layoutModeFor(LAYOUT_MODE_FROM.xl)).toBe('xl');
    expect(layoutModeFor(2.0)).toBe('xl');
    expect(layoutModeFor(3.12)).toBe('xl');
  });

  it('does not degrade the structure on a missing reading', () => {
    expect(layoutModeFor(undefined)).toBe('normal');
    expect(layoutModeFor(NaN)).toBe('normal');
  });
});
