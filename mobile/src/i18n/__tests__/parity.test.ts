import { describe, expect, it } from '@jest/globals';
import MessageFormat from 'intl-messageformat';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';
import { LOCALES, intlLocale, type Locale } from '../locale';

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
