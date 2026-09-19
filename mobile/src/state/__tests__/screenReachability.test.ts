import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Every member of the `Screen` union must be reachable (#486).
 *
 * `closeout` and `firstmove` sat in the union and in `Root`'s switch for
 * months while nothing — no tab, no `go(...)`, no jump case — could open them.
 * They rendered seeded mock data in release builds the whole time, and no test
 * noticed because each screen passed its own tests in isolation.
 *
 * So this test reads the union from `state/types.ts` and requires every member
 * to have a way in: a place in `tabScreens`, a `go('<name>')` call, a
 * `screen: '<name>'` assignment (`openDetail`, `openPlan`, the jump list), or a
 * `case '<name>'` in that list. A screen added to the union without one fails
 * here, not in a design review.
 */

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** The quoted members of `export type Screen = ...`, comments stripped. */
function screenUnion(): string[] {
  const source = readFileSync(join(SRC, 'state', 'types.ts'), 'utf8');
  const start = source.indexOf('export type Screen =');
  const block = source.slice(start, source.indexOf(';', start));
  const withoutComments = block.replace(/\/\/[^\n]*/g, '');
  return [...withoutComments.matchAll(/'([A-Za-z]+)'/g)].map(m => m[1] as string);
}

/**
 * Screens that exist as state but are never navigated to — transient or
 * overlay states the union carries for a reason. Empty today: sheets are a
 * separate `Sheet` union, and the two screens that would have been listed
 * here are what #486 cut. Add a name only with the reason it cannot have a
 * call site.
 */
const TRANSIENT: string[] = [];

describe('screen reachability', () => {
  // `types.ts` itself is excluded: the union definition would otherwise be a
  // "reference" for every member and the test could never fail.
  const sources = sourceFiles(SRC)
    .filter(path => !path.includes('__tests__'))
    .filter(path => !path.endsWith(join('state', 'types.ts')))
    .map(path => readFileSync(path, 'utf8'))
    .join('\n');

  const tabScreens = [
    .../tabScreens = \[([^\]]*)\]/.exec(sources)?.[1]?.matchAll(/'([A-Za-z]+)'/g) ?? [],
  ].map(m => m[1] as string);

  it('reads a non-empty union from state/types.ts', () => {
    expect(screenUnion().length).toBeGreaterThan(3);
  });

  it.each(screenUnion())("'%s' has a way in", screen => {
    if (TRANSIENT.includes(screen)) return;
    const reachable =
      tabScreens.includes(screen) ||
      new RegExp(`\\bgo\\('${screen}'\\)`).test(sources) ||
      new RegExp(`\\bscreen: '${screen}'`).test(sources) ||
      new RegExp(`\\bcase '${screen}'`).test(sources);
    expect({ screen, reachable }).toEqual({ screen, reachable: true });
  });
});
