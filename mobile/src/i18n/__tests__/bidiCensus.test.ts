/**
 * A localised date is never forced left-to-right (UAT 2026-09-26, #16).
 *
 * `ltr()` is for times and digits. A date with a month name in it — «26
 * سبتمبر» — forced into a left-to-right isolate reverses: the week header
 * read «سبتمبر – 2 أكتوبر 26». A date is wrapped with `isolateAuto` (its own
 * first strong character decides), and a range goes through `formatDayRange`.
 */
import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

describe('bidi census', () => {
  it('no localised date is wrapped in ltr()', () => {
    const pattern = /\b(ltr|isolate)\(\s*(`[^`]*\$\{\s*)?format(Date|RelativeDay|DayKey|DayRange)\(/;
    const offenders = sourceFiles(SRC)
      .filter((path) => pattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });
});
