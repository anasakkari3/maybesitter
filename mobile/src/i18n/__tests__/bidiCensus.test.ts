/**
 * Nothing with words in it is forced left-to-right (UAT 2026-09-26, #16).
 *
 * A left-to-right isolate — `ltr(x)`, or `isolate(x)` with its default
 * direction — is right for a time, a number, an address: runs that read
 * left-to-right in every language. Put words inside one and an Arabic run
 * reverses around its neighbours: the week header's `ltr(range)` read
 * «سبتمبر – 2 أكتوبر 26», and the morning plan's `ltr(next)` read
 * «07:00 · بكرا».
 *
 * So every LTR isolate in `src` is found, its argument read, and the argument
 * must be one of the shapes below. Anything else — a variable, a date, a
 * title, a translated string — fails here. Words go through `isolateAuto`
 * (their first letter decides), a date range through `formatDayRange`, and a
 * "day · time" line isolates only the time.
 */
import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..', '..');

/** Arguments that are a time, a number, or Latin by construction. */
const ALLOWED: readonly RegExp[] = [
  /^formatTime\(/, // HH:MM from the one time formatter
  /^time$/, // FootballSettingsScreen: `formatTime(kickoff…)` one line up
  /^item\.timeLabel$/, // widget snapshot: `input.formatTime(...)`
  /^(morning\.)?deliveryLocalTime$/, // "07:00" as stored
  /^`\$\{fmt\.format\(start\)\}–\$\{fmt\.format\(end\)\}`$/, // formatTimeRange
  /^`\$\{start\}–\$\{end\}`$/, // formatClockRange: "22:30–07:30"
  /^(user\.)?email$/, /^user\.email$/, // an address
  /^String\(Math\.max\(1, Math\.round\(kb\)\)\)$/, /^\(kb \/ 1024\)\.toFixed\(1\)$/, // a size
  /^`\$\{sign\}\$\{major\.toLocaleString\('en-US'\)\}\.\$\{cents\} \$\{currency\}`$/, // an amount
  /^new Date\([^)]*\)\.toISOString\(\)/, // an ISO date or timestamp
  /^String\(conflict\.(providerValue|manualValue)\)$/, // a number from the ledger
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !path.endsWith(join('i18n', 'bidi.ts')) ? [path] : [];
  });
}

/** Comments out, line numbers kept: prose may name `ltr()` freely. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** The top-level arguments of the call whose `(` is at `open`. */
function callArguments(source: string, open: number): string[] {
  const args: string[] = [];
  // Each frame is code (with its own bracket depth) or the inside of a
  // template literal; `${` opens a code frame inside a template.
  const stack: { kind: 'code' | 'template' | 'string'; depth: number; quote?: string }[] = [{ kind: 'code', depth: 0 }];
  let current = '';
  for (let i = open + 1; i < source.length; i += 1) {
    const ch = source[i]!;
    const top = stack[stack.length - 1]!;
    if (top.kind === 'string') {
      current += ch;
      if (ch === '\\') { current += source[i + 1] ?? ''; i += 1; } else if (ch === top.quote) stack.pop();
      continue;
    }
    if (top.kind === 'template') {
      current += ch;
      if (ch === '\\') { current += source[i + 1] ?? ''; i += 1; } else if (ch === '`') stack.pop();
      else if (ch === '$' && source[i + 1] === '{') { current += '{'; i += 1; stack.push({ kind: 'code', depth: 0 }); }
      continue;
    }
    if (ch === "'" || ch === '"') { stack.push({ kind: 'string', depth: 0, quote: ch }); current += ch; continue; }
    if (ch === '`') { stack.push({ kind: 'template', depth: 0 }); current += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { top.depth += 1; current += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (top.depth === 0) {
        if (stack.length === 1) { args.push(current.trim()); return args; }
        stack.pop(); // the `}` that closes a `${`
        current += ch;
        continue;
      }
      top.depth -= 1;
      current += ch;
      continue;
    }
    if (ch === ',' && top.depth === 0 && stack.length === 1) { args.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  return args;
}

/** Every left-to-right isolate call in a file, as `file:line` and its first argument. */
function ltrIsolates(path: string, raw: string): { at: string; arg: string }[] {
  const source = stripComments(raw);
  const found: { at: string; arg: string }[] = [];
  const call = /(?<![\w.])(ltr|isolate)\(/g;
  for (let match = call.exec(source); match; match = call.exec(source)) {
    const line = source.slice(0, match.index).split('\n').length;
    const args = callArguments(source, match.index + match[0].length - 1);
    const direction = args[1];
    if (match[1] === 'isolate' && direction !== undefined && direction !== "'ltr'") continue;
    found.push({ at: `${relative(SRC, path)}:${line}`, arg: (args[0] ?? '').replace(/\s+/g, ' ') });
  }
  return found;
}

describe('bidi census', () => {
  it('finds the shapes it is meant to refuse', () => {
    // The two defects this census exists for, in the shape they shipped.
    expect(ltrIsolates(join(SRC, 'x.tsx'), 'eyebrow={ltr(range)}')).toEqual([{ at: 'x.tsx:1', arg: 'range' }]);
    expect(ltrIsolates(join(SRC, 'x.tsx'), "{ when: ltr(next) }")).toEqual([{ at: 'x.tsx:1', arg: 'next' }]);
    expect(ltrIsolates(join(SRC, 'x.tsx'), "isolate(title)")).toEqual([{ at: 'x.tsx:1', arg: 'title' }]);
    expect(ltrIsolates(join(SRC, 'x.tsx'), "isolate(title, 'rtl')")).toEqual([]);
    expect(ltrIsolates(join(SRC, 'x.tsx'), 'isolateAuto(title)')).toEqual([]);
  });

  it('no left-to-right isolate holds anything but a time, a number or an address', () => {
    const offenders = sourceFiles(SRC).flatMap((path) =>
      ltrIsolates(path, readFileSync(path, 'utf8'))
        .filter(({ arg }) => !ALLOWED.some((shape) => shape.test(arg)))
        .map(({ at, arg }) => `${at}  ${arg}`));
    expect(offenders).toEqual([]);
  });
});
