/** Cutting a title at the server's own count, never through a character (M3B-A-R3-001). */
import { describe, expect, it } from '@jest/globals';
import { clampCodePoints, clampUnits } from '../titleBounds';

describe('title bounds', () => {
  it('code points: 120 emoji stay whole, the 121st is cut', () => {
    expect(clampCodePoints('🏃'.repeat(120), 120)).toBe('🏃'.repeat(120));
    expect(clampCodePoints('🏃'.repeat(121), 120)).toBe('🏃'.repeat(120));
  });

  it('units: an emoji that would straddle the bound is dropped whole, not split', () => {
    const cut = clampUnits(`${'a'.repeat(119)}🏃`, 120);
    expect(cut).toBe('a'.repeat(119));
    expect(clampUnits('🏃'.repeat(61), 120)).toBe('🏃'.repeat(60));
    expect(clampUnits('أ'.repeat(130), 120)).toHaveLength(120);
  });
});
