/**
 * No regex literal in the product may put a JS word boundary against an Arabic
 * or Hebrew letter (#401).
 *
 * ── The one rule, and why it is this narrow ──────────────────────
 *
 * `\b` is defined over `[A-Za-z0-9_]`. Next to a Latin letter it means "edge
 * of a word". Next to an Arabic or Hebrew letter it means "the neighbour is an
 * ASCII word character", which a space, a comma and every other Arabic letter
 * are not — so `/متى\b/` matches «متى» only when an ASCII letter or digit
 * follows it, and never in an Arabic sentence. The guard stays green in
 * English and stops guarding in the two scripts it was written for.
 *
 * This is not a lint for `\b`. An English word list matched with `\b` next to
 * an Arabic alternative that carries none — `/\b(?:today)\b|اليوم/` — is the
 * correct shape and this repository uses it everywhere. The hazard is
 * *adjacency*: a `\b` whose immediate neighbour, through whatever grouping,
 * can be an Arabic or Hebrew letter. That is decided by walking the pattern,
 * not by grepping the line, so the mixed literals report nothing and the two
 * shapes that shipped broken (#194's validator, #195's forbidden words, and
 * `messageKind`'s question openers found by this census) report one line each.
 *
 * ── What it does not claim ───────────────────────────────────────
 *
 * Only regex *literals* are read. A pattern built from a string
 * (`new RegExp('\\b' + word)`) is the caller's to check, and the data-driven
 * rows in `multilingualGuardSelfCheck.test.ts` are the check that reaches
 * behaviour rather than source. `\d` is not scanned either: it is ASCII-only
 * too, but whether that matters depends on whether the input was digit-folded
 * first, which no source scan can see.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SCANNED_DIRS = ['lib', 'src', 'app', 'mobile/src'];
const RTL = /[֐-׿؀-ۿݐ-ݿיִ-﷿ﹰ-﻿]/;

/* ── Finding the literals ──────────────────────────────────────── */

interface RegexLiteral {
  readonly source: string;
  readonly line: number;
}

/**
 * Every regex literal in a TypeScript source, with its line.
 *
 * A `/` starts a literal when the previous significant character cannot end
 * an expression. Strings, template literals and comments are skipped so a
 * `/` inside them is never read as a pattern. This is a tokenizer for the
 * shapes this repository writes, not a parser for the language.
 */
export function regexLiteralsIn(text: string): RegexLiteral[] {
  const found: RegexLiteral[] = [];
  let index = 0;
  let line = 1;
  let previous = '';
  const advance = (count = 1) => {
    for (let step = 0; step < count; step += 1) {
      if (text[index] === '\n') line += 1;
      index += 1;
    }
  };
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') advance();
      continue;
    }
    if (char === '/' && next === '*') {
      advance(2);
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) advance();
      advance(2);
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      advance();
      while (index < text.length && text[index] !== char) {
        if (text[index] === '\\') advance();
        advance();
      }
      advance();
      previous = char;
      continue;
    }
    if (char === '/' && !/[\w$)\]]/.test(previous)) {
      const start = index;
      const startLine = line;
      let inClass = false;
      advance();
      while (index < text.length && text[index] !== '\n') {
        const current = text[index];
        if (current === '\\') { advance(2); continue; }
        if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) break;
        advance();
      }
      if (text[index] === '/') {
        found.push({ source: text.slice(start + 1, index), line: startLine });
        advance();
        while (index < text.length && /[a-z]/.test(text[index])) advance();
        previous = '/';
        continue;
      }
      previous = '/';
      continue;
    }
    if (!/\s/.test(char)) previous = char;
    advance();
  }
  return found;
}

/* ── Reading a pattern ─────────────────────────────────────────── */

type Item =
  | { kind: 'char'; text: string }
  | { kind: 'boundary' }
  | { kind: 'other' }
  | { kind: 'group'; alternatives: Item[][] };

/** A pattern as alternatives of items; groups nest. Quantifiers are dropped. */
function parse(source: string): Item[][] {
  let index = 0;
  const alternatives = (): Item[][] => {
    const result: Item[][] = [[]];
    while (index < source.length) {
      const char = source[index];
      if (char === ')') return result;
      if (char === '|') { result.push([]); index += 1; continue; }
      const sequence = result[result.length - 1]!;
      if (char === '(') {
        index += 1;
        if (source[index] === '?') {
          // `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>`
          index += 1;
          if (source[index] === '<' && source[index + 1] !== '=' && source[index + 1] !== '!') {
            while (index < source.length && source[index] !== '>') index += 1;
            index += 1;
          } else {
            index += source[index] === '<' ? 2 : 1;
          }
        }
        sequence.push({ kind: 'group', alternatives: alternatives() });
        index += 1; // ')'
        continue;
      }
      if (char === '\\') {
        const escaped = source[index + 1] ?? '';
        index += 2;
        if (escaped === 'b') sequence.push({ kind: 'boundary' });
        else if (escaped === 'u' || escaped === 'x' || escaped === 'p' || escaped === 'P' || escaped === 'k') {
          // A code point or property escape: read the braces or hex digits and treat as opaque.
          if (source[index] === '{') { while (index < source.length && source[index] !== '}') index += 1; index += 1; }
          else index += escaped === 'x' ? 2 : 4;
          sequence.push({ kind: 'other' });
        } else if (/[dDwWsSntrfv0]/.test(escaped)) sequence.push({ kind: 'other' });
        else sequence.push({ kind: 'char', text: escaped });
        continue;
      }
      if (char === '[') {
        const start = index;
        index += 1;
        while (index < source.length && source[index] !== ']') { if (source[index] === '\\') index += 1; index += 1; }
        index += 1;
        sequence.push({ kind: 'char', text: source.slice(start, index) });
        continue;
      }
      if (char === '{') {
        while (index < source.length && source[index] !== '}') index += 1;
        index += 1;
        continue;
      }
      if (char === '*' || char === '+' || char === '?') { index += 1; continue; }
      if (char === '^' || char === '$' || char === '.') { index += 1; sequence.push({ kind: 'other' }); continue; }
      sequence.push({ kind: 'char', text: char });
      index += 1;
    }
    return result;
  };
  return alternatives();
}

/** Whether `item`, seen from one side, can begin or end with an RTL letter. */
function touchesRtl(item: Item | undefined, side: 'first' | 'last'): boolean {
  if (!item) return false;
  if (item.kind === 'char') return RTL.test(item.text);
  if (item.kind === 'group') {
    return item.alternatives.some((sequence) => {
      const edge = side === 'first' ? sequence[0] : sequence[sequence.length - 1];
      return touchesRtl(edge, side);
    });
  }
  return false;
}

/** Every `\b` whose immediate neighbour can be an Arabic or Hebrew letter. */
export function boundaryHazards(source: string): number {
  let hazards = 0;
  const walk = (alternatives: Item[][]) => {
    for (const sequence of alternatives) {
      sequence.forEach((item, position) => {
        if (item.kind === 'group') walk(item.alternatives);
        if (item.kind !== 'boundary') return;
        if (touchesRtl(sequence[position + 1], 'first') || touchesRtl(sequence[position - 1], 'last')) hazards += 1;
      });
    }
  };
  walk(parse(source));
  return hazards;
}

/* ── The scan ──────────────────────────────────────────────────── */

function sourceFiles(directory: string): string[] {
  let entries: string[];
  try { entries = readdirSync(directory); } catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) { files.push(...sourceFiles(path)); continue; }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry) || entry.endsWith('.d.ts')) continue;
    files.push(path);
  }
  return files;
}

test('boundary scan: the reader tells adjacency from mere co-occurrence', () => {
  // The two shapes that shipped broken.
  assert.equal(boundaryHazards(String.raw`^\s*(?:متى|إمتى)\b`), 1);
  assert.equal(boundaryHazards(String.raw`^\s*(?:מה|מתי)\b`), 1);
  assert.equal(boundaryHazards(String.raw`\bالساعة`), 1);
  assert.equal(boundaryHazards(String.raw`^(?:and\b|ثم\b|ו)\s*`), 1);
  assert.equal(boundaryHazards(String.raw`\b(?:today|اليوم)\b`), 2);
  // The correct mixed shapes this repository is full of.
  assert.equal(boundaryHazards(String.raw`\b(?:today|tonight)\b|اليوم|היום`), 0);
  assert.equal(boundaryHazards(String.raw`(?:\b(?:at|by|around)\b|الساعة|בשעה)\s*(\d{1,2})`), 0);
  assert.equal(boundaryHazards(String.raw`\bignore\b.{0,50}(التعليمات|הוראות)`), 0);
  assert.equal(boundaryHazards(String.raw`(?:תזכיר לי|ذكرني|remind me)\s+not\b`), 0);
  assert.equal(boundaryHazards(String.raw`^\s*(?:متى|מתי)(?![\p{L}\p{N}])`), 0);
  // A character class of RTL letters is a letter for this purpose — when it is
  // written in the script. A class written as `\u` escapes is opaque to the
  // scan, and stated as such: the rows in multilingualGuardSelfCheck.test.ts
  // are the check that reaches behaviour; this one reads spelling.
  assert.equal(boundaryHazards('\\b[\\u0600-\\u06FF]+'), 0);
  assert.equal(boundaryHazards(String.raw`\b[؀-ۿ]+`), 1);
});

test('boundary scan: the tokenizer finds literals and skips strings and comments', () => {
  const sample = [
    "const a = /\\bfoo\\b/i; // a comment with /متى\\b/ in it",
    "const b = 'not /a\\b/ literal';",
    "/* /also\\b/ not one */",
    "const c = x / y / z;",
    "const d = [/^\\s*(?:متى)\\b/.source, /שלום/].join('|');",
  ].join('\n');
  const literals = regexLiteralsIn(sample);
  assert.deepEqual(literals.map((literal) => literal.line), [1, 5, 5]);
  assert.equal(literals[1]!.source, '^\\s*(?:متى)\\b');
});

test('boundary scan: no product regex literal puts \\b against an Arabic or Hebrew letter', () => {
  const findings: string[] = [];
  let literals = 0;
  for (const directory of SCANNED_DIRS) {
    for (const file of sourceFiles(join(ROOT, directory))) {
      const text = readFileSync(file, 'utf8');
      for (const literal of regexLiteralsIn(text)) {
        literals += 1;
        if (!RTL.test(literal.source) || !literal.source.includes('\\b')) continue;
        const hazards = boundaryHazards(literal.source);
        if (hazards > 0) findings.push(`${relative(ROOT, file)}:${literal.line}  /${literal.source}/  (${hazards})`);
      }
    }
  }
  assert.ok(literals > 500, `the scan read ${literals} regex literals; a count this low means it is not reading the product`);
  assert.deepEqual(findings, [], `\\b next to an Arabic or Hebrew letter never matches inside that script (#401). Use (?<![\\p{L}\\p{N}]) / (?![\\p{L}\\p{N}]) with the u flag:\n${findings.join('\n')}`);
});
