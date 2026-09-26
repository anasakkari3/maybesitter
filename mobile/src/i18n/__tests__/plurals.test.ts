import { describe, expect, it } from '@jest/globals';
import { tFor } from '../index';

// Arabic has six plural categories and Hebrew three. The old `fill()` copy
// («أكّد {n} التزامات») was right for 3–10 and wrong everywhere else. Each row
// below is a count that used to read as broken Arabic.

const ARABIC_INDIC = /[٠-٩۰-۹]/;

describe('confirmN', () => {
  const arabic: Record<number, string> = {
    0: 'ما في شي لتأكيده',
    1: 'أكّد التزام واحد',
    2: 'أكّد التزامين',
    3: 'أكّد 3 التزامات',
    11: 'أكّد 11 التزامًا',
    100: 'أكّد 100 التزام',
  };
  const hebrew: Record<number, string> = {
    0: 'אין מה לאשר',
    1: 'אישור התחייבות אחת',
    2: 'אישור שתי התחייבויות',
    3: 'אישור 3 התחייבויות',
    11: 'אישור 11 התחייבויות',
    100: 'אישור 100 התחייבויות',
  };

  const t = { ar: tFor('ar'), he: tFor('he'), en: tFor('en') };

  for (const [n, expected] of Object.entries(arabic)) {
    it(`renders Arabic for n=${n}`, () => {
      expect(t.ar('confirmN', { n: Number(n) })).toBe(expected);
    });
  }

  for (const [n, expected] of Object.entries(hebrew)) {
    it(`renders Hebrew for n=${n}`, () => {
      expect(t.he('confirmN', { n: Number(n) })).toBe(expected);
    });
  }

  it('uses Latin digits in Arabic', () => {
    for (const n of [3, 11, 100]) expect(t.ar('confirmN', { n })).not.toMatch(ARABIC_INDIC);
    expect(t.ar('confirmN', { n: 11 })).toContain('11');
  });

  it('uses Latin digits in Hebrew too, and reaches the two-form for n=2', () => {
    // Hebrew's `two` is a different word, not a number with a plural noun:
    // «שתי התחייבויות» rather than «2 התחייבויות». A build whose ICU parser
    // lost the locale renders `other` for every count and still looks like
    // Hebrew, so the pair below is what tells them apart.
    expect(t.he('confirmN', { n: 2 })).not.toMatch(/2/);
    expect(t.he('confirmN', { n: 3 })).toContain('3');
    for (const n of [3, 11, 100]) expect(t.he('confirmN', { n })).not.toMatch(ARABIC_INDIC);
  });

  it('still reads as English', () => {
    expect(t.en('confirmN', { n: 0 })).toBe('Nothing to confirm');
    expect(t.en('confirmN', { n: 1 })).toBe('Confirm 1 commitment');
    expect(t.en('confirmN', { n: 7 })).toBe('Confirm 7 commitments');
  });
});

describe('the other two count messages', () => {
  const ar = tFor('ar');
  const he = tFor('he');

  it('inflects lockedTitle for the Arabic dual and for n>=11', () => {
    expect(ar('lockedTitle', { n: 1 })).toBe('اليوم، إشي واحد');
    expect(ar('lockedTitle', { n: 2 })).toBe('اليوم، إشيين');
    expect(ar('lockedTitle', { n: 3 })).toBe('اليوم، 3 أشياء');
    expect(ar('lockedTitle', { n: 11 })).toBe('اليوم، 11 إشي');
  });

  it('inflects progressWords', () => {
    expect(ar('progressWords', { d: 0, n: 3 })).toBe('ما تمّ ولا إشي من 3');
    expect(ar('progressWords', { d: 1, n: 3 })).toBe('تمّ واحد من 3');
    expect(ar('progressWords', { d: 2, n: 3 })).toBe('تمّ تنين من 3');
    expect(ar('progressWords', { d: 3, n: 3 })).toBe('تمّت 3 من 3');
    expect(he('progressWords', { d: 2, n: 5 })).toBe('הושלמו שניים מתוך 5');
  });
});
