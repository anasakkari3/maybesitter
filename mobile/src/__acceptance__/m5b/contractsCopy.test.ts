import { existsSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, jest } from '@jest/globals';
import ar from '../../i18n/locales/ar.json';
import en from '../../i18n/locales/en.json';
import he from '../../i18n/locales/he.json';
import { tFor } from '../../i18n';

const KEYS = [
  'm5bSummaryTitle', 'm5bSummaryLoading', 'm5bSummaryDisclosure', 'm5bSummaryMore',
  'm5bPlanBasisChanged', 'm5bPlanBasisChangedNoRebuild',
  'm5bEnergyAskTitle', 'm5bEnergyAskSub', 'm5bEnergyLow', 'm5bEnergyNoEffect',
  'm5bEnergyHealthLow', 'm5bEnergyHealthNoEffect', 'm5bEnergyNone', 'm5bEnergyStale',
  'm5bEnergyNever', 'm5bEnergyChange', 'm5bEnergyToday', 'm5bEnergyTodayHealth',
  'm5bEnergyLighter', 'm5bEnergyAskNow', 'm5bEnergyHideToday', 'm5bEnergyHideTodayA11y',
  'm5bEnergyLevelA11y',
] as const;

type Schema = {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
};

function strict(schema: Schema, value: Record<string, unknown>): void {
  expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
}

describe('M5b strict mobile wire', () => {
  it('M5B-017 m5b.ts strictly parses every additive response shape', () => {
    const file = join(__dirname, '..', '..', 'api', 'schemas', 'm5b.ts');
    expect(existsSync(file)).toBe(true);
    const schemas = jest.requireActual<Record<string, Schema>>('../../api/schemas/m5b');
    const capabilities = { success: true, memoryLearning: true };
    const ready = {
      success: true,
      summary: {
        status: 'ready', language: 'en',
        sentences: [{ text: 'Focus at 09:00.', memoryIds: ['memory-1'] }],
        coveredCount: 1, totalCount: 1,
      },
    };
    const applied = {
      source: 'check_in', energy: 2, band: 'low', bufferMinutesAdded: 15,
      observedAt: '2030-03-29T08:00:00.000Z',
    };
    const effect = {
      source: 'health', energy: null, band: 'steady', bufferMinutes: 0,
      staleReading: null,
    };
    const energy = { source: 'health', level: null, band: 'high', changedPick: false };

    expect(schemas.m5bCapabilitiesSchema?.parse(capabilities)).toEqual(capabilities);
    strict(schemas.m5bCapabilitiesSchema!, capabilities);
    expect(schemas.memorySummaryResponseSchema?.parse(ready)).toEqual(ready);
    strict(schemas.memorySummaryResponseSchema!, ready);
    expect(schemas.memorySummaryResponseSchema?.safeParse({ success: true, summary: { status: 'empty' } }).success).toBe(true);
    expect(schemas.memorySummaryResponseSchema?.safeParse({ success: true, summary: { status: 'unavailable' } }).success).toBe(true);
    expect(schemas.memorySummaryResponseSchema?.safeParse({
      ...ready,
      summary: { ...ready.summary, sentences: [{ ...ready.summary.sentences[0], unexpected: true }] },
    }).success).toBe(false);
    expect(schemas.readinessAppliedSchema?.parse(applied)).toEqual(applied);
    strict(schemas.readinessAppliedSchema!, applied);
    expect(schemas.readinessAppliedSchema?.safeParse(null).success).toBe(true);
    expect(schemas.planEffectSchema?.parse(effect)).toEqual(effect);
    strict(schemas.planEffectSchema!, effect);
    expect(schemas.nextStepEnergySchema?.parse(energy)).toEqual(energy);
    strict(schemas.nextStepEnergySchema!, energy);
  });
});

function pluralCategories(message: string): string[][] {
  const answers: string[][] = [];
  const startPattern = /\{\s*\w+\s*,\s*plural\s*,/g;
  for (const match of message.matchAll(startPattern)) {
    const categories: string[] = [];
    let depth = 1;
    let token = '';
    for (let index = (match.index ?? 0) + match[0].length; index < message.length && depth > 0; index += 1) {
      const char = message[index]!;
      if (char === '{') {
        if (depth === 1) {
          const category = token.trim().split(/\s+/).at(-1);
          if (category) categories.push(category);
          token = '';
        }
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      } else if (depth === 1) token += char;
    }
    answers.push(categories);
  }
  return answers;
}

describe('M5b localized copy contracts', () => {
  it('M5B-017 every new key exists in ar, en, and he and Arabic contains only Latin digits', () => {
    const bundles = { ar, en, he } as const;
    for (const [locale, bundle] of Object.entries(bundles)) {
      const values = bundle as unknown as Record<string, unknown>;
      for (const key of KEYS) {
        expect({ locale, key, value: values[key] }).toEqual({ locale, key, value: expect.any(String) });
      }
    }
    for (const key of KEYS) {
      expect((ar as unknown as Record<string, string>)[key]).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/);
    }
  });

  it('M5B-017 every m5b plural has exactly its locale CLDR categories and no ellipsis placeholder', () => {
    const expected = {
      ar: ['few', 'many', 'one', 'other', 'two', 'zero'],
      en: ['one', 'other'],
      he: ['one', 'other', 'two'],
    } as const;
    const bundles = { ar, en, he } as const;
    const checked: string[] = [];
    for (const locale of ['ar', 'en', 'he'] as const) {
      for (const [key, value] of Object.entries(bundles[locale] as Record<string, unknown>)) {
        if (!key.startsWith('m5b') || typeof value !== 'string') continue;
        for (const categories of pluralCategories(value)) {
          checked.push(`${locale}.${key}`);
          expect([...categories].sort()).toEqual([...expected[locale]]);
          expect(value).not.toContain('…');
        }
      }
    }
    expect(checked).toEqual(expect.arrayContaining([
      'ar.m5bSummaryMore', 'en.m5bSummaryMore', 'he.m5bSummaryMore',
      'ar.m5bEnergyLow', 'en.m5bEnergyLow', 'he.m5bEnergyLow',
      'ar.m5bEnergyHealthLow', 'en.m5bEnergyHealthLow', 'he.m5bEnergyHealthLow',
    ]));
  });

  it('M5B-017 every new plural renders 0, 1, 2, 3, and 11 without leaking ICU syntax', () => {
    const bundles = { ar, en, he } as const;
    expect((ar as unknown as Record<string, unknown>).m5bSummaryMore).toEqual(expect.any(String));
    for (const locale of ['ar', 'en', 'he'] as const) {
      const translate = tFor(locale) as unknown as (key: string, values: Record<string, number>) => string;
      for (const [key, value] of Object.entries(bundles[locale] as Record<string, unknown>)) {
        if (!key.startsWith('m5b') || typeof value !== 'string' || pluralCategories(value).length === 0) continue;
        const args = Object.fromEntries([...value.matchAll(/\{\s*(\w+)/g)].map(match => [match[1]!, 1]));
        const pluralArgs = [...value.matchAll(/\{\s*(\w+)\s*,\s*plural\s*,/g)].map(match => match[1]!);
        for (const count of [0, 1, 2, 3, 11]) {
          const rendered = translate(key, {
            ...args,
            ...Object.fromEntries(pluralArgs.map(name => [name, count])),
          });
          expect({ locale, key, count, leaks: /plural|[{}]/.test(rendered) })
            .toEqual({ locale, key, count, leaks: false });
        }
      }
    }
  });

  it('M5B-013 m5bEnergyTodayHealth renders every band and the other branch', () => {
    expect((en as unknown as Record<string, unknown>).m5bEnergyTodayHealth).toEqual(expect.any(String));
    for (const locale of ['ar', 'en', 'he'] as const) {
      const translate = tFor(locale) as unknown as (key: string, values: Record<string, string>) => string;
      for (const band of ['low', 'steady', 'high', 'unexpected']) {
        const rendered = translate('m5bEnergyTodayHealth', { band });
        expect({ locale, band, leaks: /select|[{}]/.test(rendered) })
          .toEqual({ locale, band, leaks: false });
      }
    }
  });
});
