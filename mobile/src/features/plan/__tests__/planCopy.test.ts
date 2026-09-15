import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';
import { strings, type Lang } from '../../../i18n/strings';
import { editRefusalKey, editRefusalOf, unplacedReason, unplacedReasonKey } from '../reasons';
import { MAX_PLAN_GENERATIONS_PER_DAY, MAX_PLAN_REBUILDS_PER_DAY, canRegenerate, rebuildsLeft } from '../regenerateCap';
import { PlanEditRefusedError, NetworkError } from '../../../api/errors';

/**
 * What the plan screen is allowed to say, in all three languages.
 *
 * This product's own words: "There is no 'overdue'. Only active, done,
 * rearranged, or dropped on purpose." A morning screen that opened by telling
 * somebody what they failed at would be the exact opposite of what it is for,
 * and a single translated string is all it would take — which is why this is a
 * test and not a review note.
 */

const BUNDLES: [Lang, Record<string, unknown>][] = [
  ['en', en as unknown as Record<string, unknown>],
  ['ar', ar as unknown as Record<string, unknown>],
  ['he', he as unknown as Record<string, unknown>],
];

/** Every plan key in one bundle. */
function planCopy(bundle: Record<string, unknown>): [string, string][] {
  return Object.entries(bundle)
    .filter(([key, value]) => key.startsWith('plan') && typeof value === 'string')
    .map(([key, value]) => [key, value as string]);
}

/**
 * The words, and their equivalents in the two languages most of this product's
 * users read.
 *
 * Written out rather than machine-translated: "missed" and «فات» are the same
 * accusation, and a list that only covered English would have let the Arabic
 * copy say it freely — which, since Arabic is the default language, is where it
 * would actually have been read.
 *
 * ── `\b` cannot see Arabic or Hebrew ─────────────────────────────
 *
 * JS word boundaries are defined on `[A-Za-z0-9_]`. Every character of «فاتك»
 * is a non-word character to the engine, so the position after it is not a
 * boundary and `/فات(ك|ه|ت|وا)?\b/` matched **nothing** — this list looked
 * strict and let «فاتك وقتها اليوم» through, in the language the product
 * defaults to. That is the same wound #194's review found in the server's
 * explanation validator, and it was reproduced here by mutation: the Arabic
 * mutant left the suite green while the English one turned it red.
 *
 * So a boundary in these two scripts is written as "not another letter of this
 * script", which is what `\b` means and what it cannot express. It keeps
 * «فاتورة» (an invoice) from reading as an accusation while «فاتك» still does.
 */
const AR = '\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF';
const HE = '\u0590-\u05FF\uFB1D-\uFB4F';

/** `word`, not glued to another letter of the same script. */
function standalone(word: string, block: string): RegExp {
  return new RegExp(`(?<![${block}])(?:${word})(?![${block}])`, 'u');
}

const FORBIDDEN: [string, RegExp][] = [
  ['failed (en)', /\bfail(ed|ure|s)?\b/i],
  ['behind (en)', /\bbehind\b/i],
  ['missed (en)', /\bmiss(ed|ing)?\b/i],
  ['should have (en)', /\bshould\s+have\b/i],
  ['overdue (en)', /\boverdue\b/i],
  ['late (en)', /\blate\b/i],
  ['فشل (ar)', /فشل|فاشل/],
  ['متأخر (ar)', /متأخّ?ر/],
  ['فات (ar)', standalone('فات(?:ك|ه|ت|وا)?', AR)],
  ['ما لحق (ar)', /ما لحق/],
  ['كان لازم (ar)', /كان لازم|كان المفروض|مقصّر|تقصير/],
  ['נכשל (he)', /נכשל|כישלון/],
  ['פספס (he)', /פספס|החמצ/],
  ['מאחר (he)', standalone('מאחר', HE)],
  ['באיחור (he)', /באיחור|פיגור/],
  ['היית צריך (he)', /היית צריך|היה עליך/],
];

/**
 * The list can see what it claims to (`#195`).
 *
 * Without this, a pattern that matches nothing at all is indistinguishable
 * from copy that is clean — and that is exactly the state two of these were
 * shipped in. Each accusation is asserted to be caught in a sentence shaped
 * like the product's own copy, and each innocent neighbour to be let through.
 */
describe('the list itself can read the languages it polices', () => {
  const CAUGHT: [string, string][] = [
    ['en', 'You missed the free time it needed today.'],
    ['en', 'This is behind.'],
    ['en', 'You should have done it.'],
    ['ar', 'فاتك وقتها اليوم'],
    ['ar', 'ما لحق اليوم'],
    ['ar', 'كان لازم تعملها'],
    ['ar', 'الالتزام متأخّر'],
    ['he', 'פספסת את הזמן'],
    ['he', 'מאחר בתוכנית'],
    ['he', 'היית צריך לעשות את זה'],
  ];
  const INNOCENT = [
    'خبّيناها لوقت تاني.',
    'فاتورة الكهرباء',
    'ما لقينا فراغ طويل كفاية اليوم.',
    'שמרנו לפעם אחרת.',
    'There was no free stretch long enough today.',
  ];

  it.each(CAUGHT)('catches an accusation written in %s', (_locale, sentence) => {
    expect({ sentence, caught: FORBIDDEN.some(([, pattern]) => pattern.test(sentence)) })
      .toEqual({ sentence, caught: true });
  });

  it.each(INNOCENT)('lets %s through', sentence => {
    expect({ sentence, caught: FORBIDDEN.some(([, pattern]) => pattern.test(sentence)) })
      .toEqual({ sentence, caught: false });
  });
});

describe('nothing on the plan screen accuses anybody', () => {
  it.each(BUNDLES)('keeps %s free of failure words', (locale, bundle) => {
    const offences: string[] = [];
    for (const [key, value] of planCopy(bundle)) {
      for (const [name, pattern] of FORBIDDEN) {
        if (pattern.test(value)) offences.push(`${locale}.${key} contains ${name}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('has the same plan keys in all three locales', () => {
    const keys = BUNDLES.map(([, bundle]) => planCopy(bundle).map(([key]) => key).sort());
    expect(keys[1]).toEqual(keys[0]);
    expect(keys[2]).toEqual(keys[0]);
    // The screen has copy at all — a bundle that lost every plan key would
    // otherwise pass every assertion above.
    expect(keys[0]!.length).toBeGreaterThan(30);
  });
});

describe('a reason code never reaches the screen', () => {
  // Every member of `PlanningReasonCode` in src/contracts/v1/planningContracts.
  const CODES = [
    'INVALID_INTERVAL', 'EFFORT_UNKNOWN', 'EFFORT_NOT_POSITIVE',
    'DEADLINE_BEFORE_EARLIEST_START', 'DEADLINE_BEYOND_HORIZON',
    'EFFORT_EXCEEDS_ITEM_WINDOW', 'NO_WORKING_WINDOW', 'SELF_DEPENDENCY',
    'CYCLIC_DEPENDENCY', 'UNKNOWN_DEPENDENCY', 'FIXED_EVENT_CONFLICT',
    'NONEXISTENT_LOCAL_TIME', 'AMBIGUOUS_LOCAL_TIME', 'NO_FEASIBLE_SLOT',
    'BLOCKED_BY_DEPENDENCY', 'DEPENDENCY_TOO_LATE', 'HORIZON_EXHAUSTED',
  ];

  it.each(CODES)('says something in words for %s, in every language', code => {
    for (const [lang] of BUNDLES) {
      const sentence = unplacedReason(code, strings[lang]);
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence).not.toContain(code);
      expect(sentence).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    }
  });

  it('answers a reason this build has never heard of without printing it', () => {
    // `UnplacedItemDto` widens the code to `string` on the wire on purpose, so
    // a new planning reason can reach an app already on somebody's phone.
    expect(unplacedReasonKey('SOME_REASON_FROM_THE_FUTURE')).toBe('planReasonKept');
    expect(unplacedReason('SOME_REASON_FROM_THE_FUTURE', strings.en))
      .not.toContain('SOME_REASON_FROM_THE_FUTURE');
  });
});

describe('a refused move is explained, not reported', () => {
  const REASONS = [
    'unknown_item', 'invalid_instant', 'invalid_interval', 'outside_horizon',
    'outside_working_window', 'overlaps_fixed_event', 'overlaps_scheduled_item', 'empty_edit',
  ] as const;

  it.each(REASONS)('has copy for %s', reason => {
    for (const [lang] of BUNDLES) {
      expect(String(strings[lang][editRefusalKey(reason)]).length).toBeGreaterThan(0);
    }
  });

  it('keeps the item the refusal was about', () => {
    expect(editRefusalOf(new PlanEditRefusedError('overlaps_fixed_event', 'i1')))
      .toEqual({ itemId: 'i1', key: 'planEditBusy' });
  });

  it('is not an explanation for a failure that is not a refusal', () => {
    // "That time is already taken" about a request that never reached a server
    // would be a confident lie. Everything else goes through
    // `userFacingMessage`, like every other error in this app.
    expect(editRefusalOf(new NetworkError('no signal'))).toBeNull();
    expect(editRefusalOf(null)).toBeNull();
  });
});

describe('the rebuild cap is the server’s', () => {
  const SERVER = readFileSync(
    join(__dirname, '..', '..', '..', '..', '..', 'lib', 'services', 'dailyPlan', 'planSettings.ts'),
    'utf8',
  );

  it('mirrors MAX_PLAN_GENERATIONS_PER_DAY as the server declares it', () => {
    // Read out of the server's own source. When somebody changes the cap there,
    // this goes red — rather than a user meeting a 429 behind a button this
    // screen still had enabled.
    const declared = /export const MAX_PLAN_GENERATIONS_PER_DAY = (\d+);/.exec(SERVER);
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(MAX_PLAN_GENERATIONS_PER_DAY);
  });

  it('is four rebuilds, because the morning build is generation one', () => {
    expect(SERVER).toContain('MAX_PLAN_REBUILDS_PER_DAY = MAX_PLAN_GENERATIONS_PER_DAY - 1');
    expect(MAX_PLAN_REBUILDS_PER_DAY).toBe(4);
  });

  it('counts down from the generation the plan carries', () => {
    expect(rebuildsLeft(1)).toBe(4);
    expect(rebuildsLeft(4)).toBe(1);
    expect(rebuildsLeft(5)).toBe(0);
    expect(canRegenerate(4)).toBe(true);
    expect(canRegenerate(5)).toBe(false);
  });

  it('never counts below zero for a plan built by a newer server', () => {
    expect(rebuildsLeft(9)).toBe(0);
    expect(canRegenerate(9)).toBe(false);
  });
});
