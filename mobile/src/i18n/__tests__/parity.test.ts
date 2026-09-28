import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import MessageFormat from 'intl-messageformat';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';
import { LOCALES, SELECTABLE_LOCALES, intlLocale, type Locale } from '../locale';
import { strings } from '../strings';

// A locale file that drifts is not a bug you see: a missing key silently falls
// back to English and a renamed placeholder silently renders empty. These tests
// are the only thing standing between a translation edit and that.

type Bundle = Record<string, unknown>;
const bundles = { en, ar, he } as unknown as Record<Locale, Bundle>;

/** he.json's provenance marker. It is not copy, so it is never compared. */
const PROVENANCE = '_meta';

function keysOf(bundle: Bundle): string[] {
  return Object.keys(bundle)
    .filter(key => key !== PROVENANCE)
    .sort();
}

/** Every formattable message, with the day-name lists flattened to `days.0`… */
function messagesOf(bundle: Bundle): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(bundle)) {
    if (key === PROVENANCE) continue;
    if (typeof value === 'string') out.set(key, value);
    else if (Array.isArray(value)) value.forEach((item, i) => out.set(`${key}.${i}`, String(item)));
    else throw new Error(`${key} is neither a message nor a list of messages`);
  }
  return out;
}

type AstNode = {
  type: number;
  value?: unknown;
  options?: Record<string, { value: AstNode[] }>;
  children?: AstNode[];
};
const LITERAL = 0;
const POUND = 7;

/** The argument names a message reads, whatever depth of plural they sit at. */
function argumentsOf(message: string, locale: string): string[] {
  const ast = new MessageFormat(message, locale, undefined, { ignoreTag: true }).getAst() as unknown as AstNode[];
  const found = new Set<string>();
  const walk = (nodes: AstNode[]): void => {
    for (const node of nodes) {
      if (node.type !== LITERAL && node.type !== POUND && typeof node.value === 'string') found.add(node.value);
      if (node.options) for (const branch of Object.values(node.options)) walk(branch.value);
      if (node.children) walk(node.children);
    }
  };
  walk(ast);
  return [...found].sort();
}

describe('locale file parity', () => {
  it('covers every supported locale', () => {
    expect(Object.keys(bundles).sort()).toEqual([...LOCALES].sort());
  });

  /**
   * The screens read `strings[lang]`, not the JSON. That view was `{ ar, en }`
   * while `he.json` sat in i18next's resources, so every test in this file
   * could hold Hebrew to English's standard and the screens still had no way
   * to reach it. The two maps are the same set now, and stay so.
   */
  it('is the same set the screens can actually render', () => {
    expect(Object.keys(strings).sort()).toEqual([...LOCALES].sort());
    expect([...SELECTABLE_LOCALES].sort()).toEqual([...LOCALES].sort());
  });

  it('has the same key set in every locale', () => {
    const template = keysOf(bundles.en);
    expect(template.length).toBeGreaterThan(150);
    for (const locale of LOCALES) expect(keysOf(bundles[locale])).toEqual(template);
  });

  it.each(LOCALES)('parses every %s message with intl-messageformat', locale => {
    const failures: string[] = [];
    for (const [key, message] of messagesOf(bundles[locale])) {
      try {
        new MessageFormat(message, intlLocale(locale), undefined, { ignoreTag: true });
      } catch (error) {
        failures.push(`${key}: ${String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('uses the same placeholders for a key in every locale', () => {
    const template = messagesOf(bundles.en);
    for (const locale of LOCALES) {
      if (locale === 'en') continue;
      const translated = messagesOf(bundles[locale]);
      for (const [key, message] of template) {
        const other = translated.get(key);
        expect(other).toBeDefined();
        expect({ key, args: argumentsOf(other ?? '', intlLocale(locale)) }).toEqual({
          key,
          args: argumentsOf(message, intlLocale('en')),
        });
      }
    }
  });

  it('keeps the three count messages plural in every locale', () => {
    for (const key of ['confirmN', 'lockedTitle', 'progressWords']) {
      for (const locale of LOCALES) {
        expect(`${locale}:${String(bundles[locale][key]).includes(', plural,')}`).toBe(`${locale}:true`);
      }
    }
  });

  it('marks Hebrew as machine translated', () => {
    expect((he as { _meta?: { machine_translated?: boolean } })._meta?.machine_translated).toBe(true);
  });
});

/**
 * Every key in every object of a raw JSON text, with its dotted path, in
 * order — duplicates included. `JSON.parse` and `import` keep only the last of
 * two equal keys, so a duplicate is invisible to every test above: the
 * 2026-09-28 closure merge of main produced `xPrepareBody` and `xWeeklyBody`
 * twice in en.json and he.json, with no conflict marker, and the app showed
 * the later (wrong) copy. This reads the text itself.
 */
function duplicateKeys(text: string): string[] {
  const duplicates: string[] = [];
  const stack: { keys: Set<string>; path: string; isObject: boolean; pendingKey: string | null }[] = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { value += text.slice(j, j + 2); j += 2; continue; }
        value += text[j];
        j += 1;
      }
      const top = stack[stack.length - 1];
      if (top?.isObject && expectKey) {
        const key = JSON.parse(`"${value}"`) as string;
        if (top.keys.has(key)) duplicates.push(top.path ? `${top.path}.${key}` : key);
        top.keys.add(key);
        top.pendingKey = key;
        expectKey = false;
      }
      i = j;
    } else if (ch === '{' || ch === '[') {
      const parent = stack[stack.length - 1];
      const segment = parent ? (parent.isObject ? parent.pendingKey ?? '' : '[]') : '';
      const path = parent?.path ? `${parent.path}.${segment}` : segment;
      stack.push({ keys: new Set(), path, isObject: ch === '{', pendingKey: null });
      expectKey = ch === '{';
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      expectKey = false;
    } else if (ch === ',') {
      expectKey = stack[stack.length - 1]?.isObject === true;
    }
  }
  return duplicates;
}

describe('locale files, as text', () => {
  it('finds a duplicate key the parser would hide, at any depth, and nothing else', () => {
    expect(duplicateKeys('{"a": "1", "b": "x", "a": "2"}')).toEqual(['a']);
    expect(duplicateKeys('{"_meta": {"k": 1, "k": 2}, "k": "fine"}')).toEqual(['_meta.k']);
    expect(duplicateKeys('{"a": "\\"a\\": 1, \\"a\\"", "b": ["a", "a"], "c": {"a": 1}}')).toEqual([]);
  });

  it.each(['ar', 'en', 'he'])('%s.json has no key twice in any object', (locale) => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'locales', `${locale}.json`), 'utf8');
    expect(duplicateKeys(text)).toEqual([]);
  });
});
