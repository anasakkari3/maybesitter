/**
 * User text in a visible template is isolated (condition 53, PLAN-M6a R53.2).
 *
 * A commitment title, a memory fact or a seed summary can be Arabic, Hebrew or
 * English. Dropped raw into a template next to a time or a «·», the neutral
 * characters at the boundary take the sentence's direction and the line
 * reorders: «· Dentist 10:00 +2» read backwards in the Arabic app. So every
 * `${x.title}` / `${x.content}` / `${x.summary}` interpolated into a template
 * literal in `src` must go through `isolateAuto` / `isolate` — except where
 * the template is not drawn: an accessibility label (a screen reader reads
 * logical order), a React key, a testID. Those are listed by the shape of
 * the line they are on, never by file.
 */
import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..', '..');
const RAW = /\$\{\s*[A-Za-z_][A-Za-z0-9_!?.\][]*\.(title|content|summary)\s*\}/g;
const NOT_DRAWN = /\b(accessibilityLabel|label|key|testID|hint)=\{|\bconst description = /;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' || entry === '__acceptance__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

describe('user text in visible templates', () => {
  it('is isolated wherever it is drawn', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (!RAW.test(line)) return;
        RAW.lastIndex = 0;
        if (NOT_DRAWN.test(line)) return;
        offenders.push(`${relative(SRC, file)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('would catch the folded Today preview as it was before M6a', () => {
    const before = "const preview = `· ${first.title}${firstWhen ? ` ${firstWhen}` : ''}`;";
    expect(RAW.test(before) && !NOT_DRAWN.test(before)).toBe(true);
    RAW.lastIndex = 0;
  });
});
