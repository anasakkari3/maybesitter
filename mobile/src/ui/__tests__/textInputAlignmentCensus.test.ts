/**
 * Every TextInput states its alignment (first iPhone run, L7; review I3).
 *
 * A TextInput is not mirrored by the root's `direction` the way a Text is, so
 * one without a computed `textAlign` starts Arabic at the left edge. The lane
 * fixed the ones it found and missed one (`AiImportReviewStep`), so this is a
 * census rather than a list: every `<TextInput` in shipped source must set
 * `textAlign` in its own props, or through a style object defined in the same
 * file that does. The lint rule (`eslint.config.js`) forbids the literal
 * 'left'/'right'; this makes leaving it out a failure too.
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

/** The text of each `<TextInput …>` element's opening tag. */
function textInputs(source: string): string[] {
  const found: string[] = [];
  // Not `useRef<TextInput>(…)`: a type argument follows an identifier.
  const pattern = /(?<![\w$])<TextInput\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    // Walk to the end of the opening tag, skipping `>` inside `{…}`.
    let depth = 0;
    let i = match.index + '<TextInput'.length;
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    found.push(source.slice(match.index, i + 1));
  }
  return found;
}

/** Whether a style identifier used by the element is defined here with a textAlign. */
function styleVariableAligns(tag: string, source: string): boolean {
  const names = [...tag.matchAll(/(?:style=\{|\.\.\.)\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!);
  return names.some((name) => {
    const at = source.search(new RegExp(`const ${name}\\b[^=]*=`));
    if (at < 0) return false;
    return /textAlign\s*:/.test(source.slice(at, at + 800));
  });
}

describe('TextInput census', () => {
  const files = sourceFiles(SRC);

  it('finds the inputs it is about', () => {
    const count = files.reduce((n, file) => n + textInputs(readFileSync(file, 'utf8')).length, 0);
    expect(count).toBeGreaterThan(15);
  });

  it('every TextInput sets textAlign', () => {
    const missing: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const tag of textInputs(source)) {
        if (/textAlign\s*:/.test(tag) || styleVariableAligns(tag, source)) continue;
        const line = source.slice(0, source.indexOf(tag)).split('\n').length;
        missing.push(`${relative(SRC, file)}:${line}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
