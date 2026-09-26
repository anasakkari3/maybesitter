/**
 * Chips that combine in a text field (closure CL2b, complaint #3).
 *
 * The Arabic cases are the real ones: the list comma is «، », and one of the
 * onboarding chips («بفيق بكير، وصبحي مشغول») has a comma inside it.
 */
import { describe, expect, it } from '@jest/globals';
import { chipSeparator, hasChip, toggleChip, toggleChipAmong } from '../chipText';
import ar from '../../i18n/locales/ar.json';

const SEP = chipSeparator('ar');
const A = ar.obSetupDayChip1; // «بفيق بكير، وصبحي مشغول» — a comma inside
const B = ar.obSetupDayChip2;
const C = ar.obSetupDayChip3;

describe('chipSeparator', () => {
  it('is the Arabic comma in Arabic, a Latin comma otherwise', () => {
    expect(chipSeparator('ar')).toBe('، ');
    expect(chipSeparator('en')).toBe(', ');
    expect(chipSeparator('he')).toBe(', ');
  });
});

describe('toggleChip', () => {
  it('puts the first chip in an empty field on its own', () => {
    expect(toggleChip('', C, SEP)).toBe(C);
  });

  it('joins a second chip with «، », in the order tapped', () => {
    expect(toggleChip(toggleChip('', C, SEP), B, SEP)).toBe(`${C}، ${B}`);
  });

  it('takes a chip out from the middle, the start, or the end', () => {
    const all = `${A}، ${B}، ${C}`;
    expect(toggleChip(all, B, SEP)).toBe(`${A}، ${C}`);
    expect(toggleChip(all, A, SEP)).toBe(`${B}، ${C}`);
    expect(toggleChip(all, C, SEP)).toBe(`${A}، ${B}`);
    expect(toggleChip(C, C, SEP)).toBe('');
  });

  it('keeps typed words and adds the chip after them', () => {
    expect(toggleChip('بشتغل مسائي ', B, SEP)).toBe(`بشتغل مسائي، ${B}`);
    expect(toggleChip('بشتغل مسائي،', B, SEP)).toBe(`بشتغل مسائي، ${B}`);
  });
});

describe('hasChip', () => {
  it('finds a chip with a comma inside it as one chip', () => {
    expect(hasChip(`${A}، ${B}`, A)).toBe(true);
    expect(hasChip(`${B}، ${A}`, A)).toBe(true);
    // Only half of it is not the chip.
    expect(hasChip('بفيق بكير', A)).toBe(false);
  });

  it('does not see a chip inside a longer sentence', () => {
    expect(hasChip('مشي بالحارة', 'مشي')).toBe(false);
    expect(hasChip('بحب المشي', 'مشي')).toBe(false);
    expect(hasChip('قراءة، مشي', 'مشي')).toBe(true);
  });
});

describe('toggleChipAmong (an exclusive chip)', () => {
  const NONE = ar.obSetupDoneChip5; // «ما بخطر ببالي شي»
  const chips = [ar.obSetupDoneChip1, ar.obSetupDoneChip2, NONE];
  const rule = { chips, exclusive: [NONE] };

  it('picking the exclusive chip clears the others and keeps typed words', () => {
    expect(toggleChipAmong(`نقلت بيت، ${ar.obSetupDoneChip1}، ${ar.obSetupDoneChip2}`, NONE, SEP, rule))
      .toBe(`نقلت بيت، ${NONE}`);
  });

  it('picking another chip clears the exclusive one', () => {
    expect(toggleChipAmong(NONE, ar.obSetupDoneChip2, SEP, rule)).toBe(ar.obSetupDoneChip2);
  });

  it('taking a chip out touches nothing else', () => {
    expect(toggleChipAmong(`${ar.obSetupDoneChip1}، ${ar.obSetupDoneChip2}`, ar.obSetupDoneChip1, SEP, rule))
      .toBe(ar.obSetupDoneChip2);
  });
});
