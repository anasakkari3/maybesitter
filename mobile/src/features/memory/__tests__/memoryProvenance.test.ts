/**
 * The wording rules for provenance, confidence and staleness (UC-3.16, #202).
 *
 * `MemoryScreen.test.tsx` asserts what a user sees; this asserts the decisions
 * underneath it, where the boundaries are, and that the copy for every value
 * the server can send actually exists in all three languages. A label with no
 * string renders as an empty chip — visible to nobody reviewing a diff, and
 * the one place a transparency screen must not go quiet.
 */
import { describe, expect, it } from '@jest/globals';
import type { MemoryItem, MemorySourceLabel } from '../../../api/schemas/profile';
import { memorySourceLabelSchema } from '../../../api/schemas/profile';
import { provenanceChip } from '../memoryDisplay';
import {
  CONFIDENCE_STRING,
  FAIRLY_SURE_AT,
  GROUP_STRING,
  MEMORY_GROUP_ORDER,
  ORIGIN_STRING,
  SOURCE_LABEL_STRING,
  confidenceBand,
  durationText,
  evidenceLines,
  groupOf,
  keptIndefinitely,
} from '../memoryProvenance';
import ar from '../../../i18n/locales/ar.json';
import en from '../../../i18n/locales/en.json';
import he from '../../../i18n/locales/he.json';

const LOCALES = { en, ar, he } as unknown as Record<string, Record<string, string>>;
const LABELS = memorySourceLabelSchema.options as readonly MemorySourceLabel[];

const RECORDED = '2026-09-13T09:00:00.000Z';
const TEN_YEARS = '2036-09-13T09:00:00.000Z';
const NINETY_DAYS = '2026-12-12T09:00:00.000Z';

function item(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'mem_1',
    kind: 'fact',
    content: 'I cook on Fridays',
    language: 'en',
    source: 'user_stated',
    sourceLabel: 'you_told_us',
    confidence: 1,
    createdAt: RECORDED,
    observedAt: RECORDED,
    staleAfter: TEN_YEARS,
    provenance: { origin: 'manual' },
    evidence: {
      origin: 'manual',
      observedAt: RECORDED,
      recordedAt: RECORDED,
      confirmedAt: null,
      edited: false,
      observationCount: 0,
    },
    ...over,
  } as MemoryItem;
}

const copy = { strings: LOCALES.en!, date: (iso: string) => iso.slice(0, 10) };

describe('every value the server can send has words', () => {
  it('maps every source label, in all three languages', () => {
    for (const label of LABELS) {
      const key = SOURCE_LABEL_STRING[label];
      expect({ label, key }).toEqual({ label, key: expect.any(String) });
      for (const [locale, bundle] of Object.entries(LOCALES)) {
        expect({ locale, label, text: bundle[key] ?? '' }).not.toEqual({ locale, label, text: '' });
      }
    }
  });

  it('maps every group heading and every origin, in all three languages', () => {
    const keys = [
      ...MEMORY_GROUP_ORDER.map(group => GROUP_STRING[group]),
      ...Object.values(ORIGIN_STRING),
      ...Object.values(CONFIDENCE_STRING),
    ];
    for (const key of keys) {
      for (const [locale, bundle] of Object.entries(LOCALES)) {
        expect({ locale, key, text: bundle[key] ?? '' }).not.toEqual({ locale, key, text: '' });
      }
    }
  });
});

describe('grouping', () => {
  it('files by who asserted the fact, not by kind', () => {
    expect(groupOf(item({ sourceLabel: 'you_told_us' }))).toBe('told');
    expect(groupOf(item({ sourceLabel: 'you_answered_onboarding' }))).toBe('told');
    expect(groupOf(item({ sourceLabel: 'noticed_from_confirmed' }))).toBe('noticed');
    expect(groupOf(item({ sourceLabel: 'model_suggested' }))).toBe('suggested');
    expect(groupOf(item({ sourceLabel: 'model_suggested_you_confirmed' }))).toBe('suggested');
  });

  it('never disagrees with the chip the short card shows for the same record', () => {
    // Two places decide how a record is presented — `provenanceChip` for the
    // card on Knows and `groupOf` for the screen's headings. They are allowed
    // to differ in wording; they are not allowed to put the same record on
    // different sides of "did I say this, or did you decide it?".
    const cases: readonly [MemorySourceLabel, string, ReturnType<typeof provenanceChip>][] = [
      ['you_answered_onboarding', 'routine_survey', 'survey'],
      ['you_told_us', 'manual', 'you'],
      ['you_told_us', 'self_description', 'you'],
      ['you_told_us', 'capture', 'capture'],
    ];
    for (const [label, origin, chip] of cases) {
      expect(provenanceChip({ origin }, 'user_stated')).toBe(chip);
      expect(groupOf(item({ sourceLabel: label }))).toBe('told');
    }
    expect(provenanceChip({ origin: 'manual' }, 'model_inferred')).toBe('ai');
    expect(groupOf(item({ sourceLabel: 'model_suggested' }))).toBe('suggested');
    // A kept suggestion is "noticed" on both surfaces, and becomes the user's
    // own on both once they rewrite it (#202).
    expect(provenanceChip({ origin: 'behaviour_rule' }, 'deterministic_rule')).toBe('noticed');
    expect(groupOf(item({ sourceLabel: 'noticed_from_confirmed' }))).toBe('noticed');
    expect(provenanceChip({ origin: 'behaviour_rule' }, 'user_stated')).toBe('you');
    expect(groupOf(item({ sourceLabel: 'you_told_us' }))).toBe('told');
  });
});

describe('confidence, in words', () => {
  it('bands on the stated boundary, inclusive', () => {
    expect(confidenceBand(1)).toBe('certain');
    expect(confidenceBand(FAIRLY_SURE_AT)).toBe('fairly_sure');
    expect(confidenceBand(FAIRLY_SURE_AT - 0.01)).toBe('not_sure_yet');
    expect(confidenceBand(0)).toBe('not_sure_yet');
  });

  it('reads a nonsense number as the least confident thing it can say', () => {
    // Never "certain" by accident: a malformed value must not upgrade a guess.
    expect(confidenceBand(Number.NaN)).toBe('not_sure_yet');
  });
});

describe('staleness', () => {
  it('treats a ten-year TTL as "until you change it" and ninety days as a real expiry', () => {
    expect(keptIndefinitely(item({ staleAfter: TEN_YEARS }))).toBe(true);
    expect(keptIndefinitely(item({ staleAfter: NINETY_DAYS }))).toBe(false);
  });
});

describe('the "Why?" lines', () => {
  it('never produces a blank line', () => {
    const lines = evidenceLines(item(), copy);
    expect(lines.every(line => line.text.trim() !== '')).toBe(true);
  });

  it('says nothing was observed rather than omitting the question', () => {
    const lines = evidenceLines(item(), copy);
    expect(lines.find(line => line.key === 'observations')?.text).toBe(en.memoryWhyNoObservations);
  });

  it('counts observations when there are any', () => {
    const lines = evidenceLines(item({ evidence: { ...item().evidence, observationCount: 8 } }), copy);
    expect(lines.find(line => line.key === 'observations')?.text).toContain('8');
  });

  it('does not repeat "you confirmed it" for a fact the user typed and we stored', () => {
    // confirmedAt === recordedAt is the same event twice. Printing both reads
    // as two separate acts of agreement.
    const lines = evidenceLines(item({ evidence: { ...item().evidence, confirmedAt: RECORDED } }), copy);
    expect(lines.some(line => line.key === 'confirmed')).toBe(false);
  });

  it('prints the confirmation when it really happened later', () => {
    const lines = evidenceLines(
      item({ evidence: { ...item().evidence, confirmedAt: '2026-09-20T09:00:00.000Z' } }),
      copy,
    );
    expect(lines.find(line => line.key === 'confirmed')?.text).toContain('2026-09-20');
  });

  it('omits the origin line for a record that has no provenance', () => {
    const lines = evidenceLines(item({ evidence: { ...item().evidence, origin: null } }), copy);
    expect(lines.some(line => line.key === 'origin')).toBe(false);
  });
});

describe('a "Later" duration in words (UC-3.14, #532)', () => {
  // The buckets R2 can produce, at every length the wording changes. Pinned
  // rather than derived: the dual forms are the whole reason this is not a
  // single `{count} hours` template.
  it.each([
    [30, en.memoryDurationHalfHour, ar.memoryDurationHalfHour, he.memoryDurationHalfHour],
    [60, en.memoryDurationHour, ar.memoryDurationHour, he.memoryDurationHour],
    [90, en.memoryDurationHourAndHalf, ar.memoryDurationHourAndHalf, he.memoryDurationHourAndHalf],
    [120, en.memoryDurationTwoHours, ar.memoryDurationTwoHours, he.memoryDurationTwoHours],
    [150, en.memoryDurationTwoHoursAndHalf, ar.memoryDurationTwoHoursAndHalf, he.memoryDurationTwoHoursAndHalf],
  ])('words %s minutes from its own string in every language', (minutes, english, arabic, hebrew) => {
    expect(durationText(minutes as number, LOCALES.en!)).toBe(english);
    expect(durationText(minutes as number, LOCALES.ar!)).toBe(arabic);
    expect(durationText(minutes as number, LOCALES.he!)).toBe(hebrew);
  });

  it('counts past two hours, with and without the half', () => {
    expect(durationText(180, LOCALES.en!)).toBe('3 hours');
    expect(durationText(210, LOCALES.en!)).toBe('3.5 hours');
    expect(durationText(1440, LOCALES.en!)).toBe('24 hours');
    for (const bundle of Object.values(LOCALES)) {
      for (const minutes of [180, 210, 1440]) {
        expect(durationText(minutes, bundle)).toContain(String(Math.floor(minutes / 60)));
      }
    }
  });

  it('falls back to bare minutes for a length no bucket ever produced', () => {
    expect(durationText(45, LOCALES.en!)).toBe('45 minutes');
    expect(durationText(45, LOCALES.ar!)).toContain('45');
    expect(durationText(45, LOCALES.he!)).toContain('45');
  });

  it('never leaves a placeholder or an empty string, in any language', () => {
    for (const bundle of Object.values(LOCALES)) {
      for (const minutes of [30, 45, 60, 90, 120, 150, 180, 210, 1440]) {
        const text = durationText(minutes, bundle);
        expect(text.trim()).not.toBe('');
        expect(text).not.toMatch(/\{|\}/);
      }
    }
  });
});

describe('a kept R2 pattern (#532)', () => {
  const deferred = item({
    source: 'deterministic_rule',
    sourceLabel: 'noticed_from_confirmed',
    provenance: { origin: 'behaviour_rule', originRef: 'R2_defer_default:60m', confirmedByUserAt: RECORDED },
    evidence: {
      origin: 'behaviour_rule',
      observedAt: RECORDED,
      recordedAt: RECORDED,
      confirmedAt: RECORDED,
      edited: false,
      observationCount: 4,
      pattern: { ruleId: 'R2_defer_default', deferMinutes: 60 },
    },
  });

  it('reads the duration into the pattern line, not a window', () => {
    const lines = evidenceLines(deferred, copy);
    const pattern = lines.find(line => line.key === 'pattern')?.text ?? '';
    expect(pattern).toContain(en.memoryDurationHour);
    expect(pattern).not.toMatch(/\{|\}/);
  });

  it('does not claim the plan uses it, because nothing does', () => {
    const lines = evidenceLines(deferred, copy);
    expect(lines.find(line => line.key === 'plan')?.text).toBe(en.memoryWhyDeferNoPlanUse);
  });
});
