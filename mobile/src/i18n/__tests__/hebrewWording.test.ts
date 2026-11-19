/**
 * Two Hebrew slips from QA v3 (after #879), held where they would come back.
 *
 * 1. A list joined with the Arabic comma «، » for every language but English
 *    put «،» in Hebrew text (the unplaced steps of a plan, the families a chat
 *    save counted). The list comma is `chipSeparator(lang)`.
 * 2. A goal was «מטרה» on most screens and «יעד» on others. «מטרה» is the
 *    word the file uses most, so it is the word; «תאריך יעד» (a due date) is
 *    not a goal and stays.
 */
import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import heJson from '../locales/he.json';

/** The strings only: `_meta` is not copy. */
const he = Object.fromEntries(Object.entries(heJson).filter(([, value]) => typeof value === 'string')) as Record<string, string>;

const SRC = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === '__acceptance__' ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('Hebrew wording', () => {
  it('no list gives the Arabic comma to a language that is not Arabic', () => {
    // `lang === 'en' ? ', ' : '، '`: Hebrew falls to the Arabic branch.
    const ARABIC_FOR_ALL_BUT_ENGLISH = /lang\s*===\s*'en'\s*\?\s*', '\s*:\s*'، '/;
    const offenders = sources(SRC)
      .filter((path) => ARABIC_FOR_ALL_BUT_ENGLISH.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it('a goal is «מטרה» everywhere; «יעד» is left only for a due date', () => {
    const DUE_DATE_KEYS = new Set(['financialAddBillDate']);
    const stray = Object.entries(he)
      .filter(([key, value]) => /יעד/.test(value) && !DUE_DATE_KEYS.has(key))
      .map(([key]) => key);
    expect(stray).toEqual([]);
    expect(he.financialAddBillDate).toContain('תאריך יעד');
  });
});
