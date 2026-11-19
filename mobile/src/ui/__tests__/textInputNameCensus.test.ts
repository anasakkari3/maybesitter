/**
 * Every TextInput has a name of its own (de7fcb84 audit CX2.4 / CXX2.3).
 *
 * A placeholder is not a name: VoiceOver reads it only while the field is
 * empty, and once something is typed the field is "120, text field" with
 * nothing saying what 120 is. The audit found seven such fields; this is a
 * census, so the next one fails here instead of on a screen reader.
 */
import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' || entry === '__mocks__' || entry === '__fixtures__' ? [] : sourceFiles(path);
    }
    return entry.endsWith('.tsx') ? [path] : [];
  });
}

/** The text of each `<TextInput …>` opening tag, with its line. */
function textInputs(source: string): { tag: string; line: number }[] {
  const found: { tag: string; line: number }[] = [];
  const pattern = /(?<![\w$])<TextInput\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 0;
    let i = match.index + '<TextInput'.length;
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    found.push({ tag: source.slice(match.index, i + 1), line: source.slice(0, match.index).split('\n').length });
  }
  return found;
}

describe('TextInput name census', () => {
  const files = sourceFiles(SRC);

  it('finds the inputs it is about', () => {
    const count = files.reduce((n, file) => n + textInputs(readFileSync(file, 'utf8')).length, 0);
    expect(count).toBeGreaterThan(15);
  });

  it('every TextInput sets an accessibilityLabel', () => {
    const missing: string[] = [];
    for (const file of files) {
      for (const { tag, line } of textInputs(readFileSync(file, 'utf8'))) {
        if (!/accessibilityLabel=/.test(tag)) missing.push(`${relative(SRC, file)}:${line}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
