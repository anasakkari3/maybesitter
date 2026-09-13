/**
 * Hebrew is offered *and* unreviewed, and both halves have to stay said.
 *
 * The second half is the one that rots. `he.json`'s copy was derived from a
 * terminology table, not written by a Hebrew speaker, and the moment the
 * language became selectable that stopped being an internal note and started
 * being something a user is owed. The failure mode is not that the copy is
 * wrong — it is known to be imperfect and shipped anyway, deliberately — it is
 * that a later change quietly presents it as reviewed: somebody edits three
 * strings, deletes the `_meta` marker because it "looks like leftover
 * scaffolding", and the product now vouches for text nobody has read.
 *
 * So the claim lives in three places and this binds them together. Removing the
 * marker, or the constant, or the README section, fails — and a real native
 * review is then a three-line change that says so in all three at once.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';
import { LOCALES, UNREVIEWED_LOCALES, type Locale } from '../locale';

const bundles: Record<Locale, Record<string, unknown>> = { en, ar, he };

/**
 * Whether a bundle admits to being machine translated.
 *
 * Read structurally rather than through a declared shape, because `en.json` and
 * `ar.json` have no `_meta` key at all — its *absence* is the claim that a
 * person wrote them, and a type that made the field optional everywhere would
 * quietly accept a third locale that simply forgot to say either way.
 */
function machineTranslated(bundle: Record<string, unknown>): boolean {
  const meta = bundle._meta;
  if (typeof meta !== 'object' || meta === null || !('machine_translated' in meta)) return false;
  return meta.machine_translated === true;
}

const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');

describe('machine-translated copy says so', () => {
  it('marks exactly the locales UNREVIEWED_LOCALES names, and no others', () => {
    const marked = LOCALES.filter(locale => machineTranslated(bundles[locale]));
    expect([...marked].sort()).toEqual([...UNREVIEWED_LOCALES].sort());
  });

  it('still names Hebrew, because no native speaker has read it', () => {
    // Deleting this line is the review. Deleting it without the review is the
    // thing this file exists to stop.
    expect([...UNREVIEWED_LOCALES]).toEqual(['he']);
    expect(he._meta.machine_translated).toBe(true);
  });

  it('offers it anyway, and the README explains that trade rather than hiding it', () => {
    expect(readme).toMatch(/machine translated/i);
    expect(readme).toMatch(/No native speaker has read the copy/i);
    // The claim has to name what is unreviewed, not just that something is.
    expect(readme).toMatch(/gender/i);
  });

  it('does not mark English or Arabic, which were written by people', () => {
    for (const locale of ['en', 'ar'] as const) {
      expect({ locale, marked: machineTranslated(bundles[locale]) }).toEqual({ locale, marked: false });
    }
  });
});
