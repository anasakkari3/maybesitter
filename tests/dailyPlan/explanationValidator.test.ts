/**
 * What the model is allowed to say about a plan (UC-3.10a, #194).
 *
 * Three of these are acceptance criteria in their own right: a time that is not
 * in the plan, a title nobody committed to, and a §13 forbidden phrase each
 * have to be refused, and each is one test rather than a row in a list, because
 * the issue asks for a test per case.
 *
 * The template is then checked *against the same validator*, in all three
 * locales. That closes the loop the whole design rests on: the fallback is only
 * safe if the fallback itself would pass, and a template that quietly violated
 * its own rules would be shipped to every user whose model call failed.
 *
 * ── Why the refusal table is not English ─────────────────────────
 *
 * Because it was, and that is the only reason the first version of this
 * validator shipped blind. The three rules did bite in English and mutation
 * tests proved it, while an Arabic sentence with invented times, an invented
 * count, shame, coercion, a persistence claim and a §13 claim was accepted and
 * stored `validated: true` — and no row in this file could see it. A refusal
 * table in one language is a statement about that language.
 *
 * `REFUSED` below therefore carries every sentence the 2026-09-15 review of
 * this branch found accepted, in the language it found them in, and asserts the
 * **exact** reason set rather than "something fired": an over-catching word list
 * is its own defect, and the ACCEPTED rows are what stop this file being made
 * green by refusing everything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EXPLANATION_CHARS,
  explanationFactsFrom,
  explanationRejections,
  isValidExplanation,
  templateExplanation,
  toAsciiDigits,
  type ExplanationFacts,
} from '../../lib/services/dailyPlan/explanationValidator.ts';
import type { Plan } from '../../src/contracts/v1/planningContracts.ts';
import type { UserLocale } from '../../lib/storage/userDocument.ts';

const TZ = 'Asia/Jerusalem';

/** 09:00-09:30 and 11:00-11:30 local, which is 06:00Z and 08:00Z in September. */
const PLAN: Plan = {
  version: 1,
  schema: 'planning-v1',
  scopeId: 'u:2026-09-15',
  horizon: { startsAt: '2026-09-14T21:00:00.000Z', endsAt: '2026-09-15T21:00:00.000Z' },
  scheduled: [
    {
      itemId: 'c1',
      interval: { startsAt: '2026-09-15T06:00:00.000Z', endsAt: '2026-09-15T06:30:00.000Z' },
      reservedInterval: { startsAt: '2026-09-15T06:00:00.000Z', endsAt: '2026-09-15T06:30:00.000Z' },
    },
    {
      itemId: 'c2',
      interval: { startsAt: '2026-09-15T08:00:00.000Z', endsAt: '2026-09-15T08:30:00.000Z' },
      reservedInterval: { startsAt: '2026-09-15T08:00:00.000Z', endsAt: '2026-09-15T08:30:00.000Z' },
    },
  ],
  unscheduled: [
    { itemId: 'c3', reason: { code: 'NO_FEASIBLE_SLOT', itemId: 'c3', detail: 'no room left' } },
  ],
  constraintReasons: [],
  inputDigest: 'digest-1',
} as unknown as Plan;

const TITLES = new Map([['c1', 'Write the summary'], ['c2', 'Call the bank'], ['c3', 'Book the train']]);

function facts(locale: UserLocale = 'en'): ExplanationFacts {
  return explanationFactsFrom(PLAN, TITLES, TZ, locale);
}

test('the facts are read off the plan, in the user\'s zone', () => {
  const derived = facts();
  assert.deepEqual([...derived.allowedTimes].sort(), ['09:00', '09:30', '11:00', '11:30']);
  assert.equal(derived.scheduledCount, 2);
  assert.equal(derived.unscheduledCount, 1);
  assert.equal(derived.firstStart, '09:00');
  assert.equal(derived.lastEnd, '11:30');
});

/* ── The three acceptance cases ──────────────────────────────────── */

test('a time that is not in the plan is refused', () => {
  const text = 'I placed 2 things between 09:00 and 14:45. 1 did not fit today.';
  assert.deepEqual(explanationRejections(text, facts()), ['time_not_in_plan']);
});

test('an invented title is refused', () => {
  const text = 'I placed 2 things between 09:00 and 11:30, including "Pick up the dry cleaning".';
  assert.deepEqual(explanationRejections(text, facts()), ['unknown_title']);
});

test('a §13 forbidden phrase is refused', () => {
  const text = 'I placed 2 things between 09:00 and 11:30. I manage your entire life from here.';
  assert.deepEqual(explanationRejections(text, facts()), ['prohibited_claim']);
});

/* ── The rest of the reject matrix ───────────────────────────────── */

test('a count that is neither the placed nor the unplaced number is refused', () => {
  assert.deepEqual(
    explanationRejections('I placed 7 things between 09:00 and 11:30.', facts()),
    ['count_mismatch'],
  );
});

test('shame, coercion and a persistence claim are each refused', () => {
  assert.deepEqual(explanationRejections('You always let this slip.', facts()), ['shame']);
  assert.deepEqual(explanationRejections('You have to do this one first.', facts()), ['coercion']);
  assert.deepEqual(
    explanationRejections('I have scheduled these for you.', facts()),
    ['persistence_claim'],
  );
});

test('an empty answer and an over-long one are refused', () => {
  assert.deepEqual(explanationRejections('   ', facts()), ['empty']);
  assert.deepEqual(explanationRejections(null, facts()), ['empty']);
  const long = `Your day starts at 09:00. ${'a'.repeat(MAX_EXPLANATION_CHARS)}`;
  assert.ok(explanationRejections(long, facts()).includes('too_long'));
});

test('every reason is reported, not just the first', () => {
  const text = 'You always slip. I placed 9 things at 03:15.';
  const reasons = explanationRejections(text, facts());
  assert.ok(reasons.includes('time_not_in_plan'));
  assert.ok(reasons.includes('count_mismatch'));
  assert.ok(reasons.includes('shame'));
});

test('a quoted fragment that really is one of the titles is accepted', () => {
  assert.equal(
    isValidExplanation('I placed 2 things. "Call the bank" is at 11:00.', facts()),
    true,
  );
});

test('a capitalised run that opens a sentence is not read as a title', () => {
  assert.equal(isValidExplanation('Today Is quiet. I placed 2 things.', facts()), true);
});

/* ── The refusal table, in the languages this product is read in ── */

/**
 * Every row: a locale, a sentence, and the complete set of reasons it must be
 * refused for. The Arabic and Hebrew rows are the sentences the review ran
 * through the real `explanationRejections` against the real
 * `explanationFactsFrom` and found **accepted**.
 */
const REFUSED: ReadonlyArray<readonly [string, UserLocale, string, readonly string[]]> = [
  [
    'ar: a wholly fabricated sentence in Arabic-Indic numerals',
    'ar',
    'حطيت ٩ إشيا بين ٠٥:٠٠ و٢٣:٤٥. و٤٢ إشي ما لحقوا.',
    ['time_not_in_plan', 'count_mismatch'],
  ],
  [
    'ar: an invented time, written ٠٥:٠٠',
    'ar',
    'حطيت 2 إشيا بين ٠٥:٠٠ و١١:٣٠.',
    ['time_not_in_plan'],
  ],
  [
    'ar: an invented count, written ٩',
    'ar',
    'حطيت ٩ إشيا بين ٠٩:٠٠ و١١:٣٠.',
    ['count_mismatch'],
  ],
  [
    'ar: shame and coercion',
    'ar',
    'إنت كسول ومهمل، وهاد ذنبك إنت، وما إلك خيار غير تعمل هالإشي هلق',
    ['shame', 'coercion'],
  ],
  [
    'ar: a persistence claim',
    'ar',
    'سجلت وحفظتلك كل إشي بالتقويم.',
    ['persistence_claim'],
  ],
  [
    'ar: a §13 medical and comprehensive-memory claim',
    'ar',
    'هاد بيعالج تشتت الانتباه عندك وبيعرفك أكتر ما بتعرف حالك.',
    ['prohibited_claim'],
  ],
  [
    'he: shame and coercion',
    'he',
    'אתה עצלן וחסר משמעת, וזו אשמתך. אין לך ברירה.',
    ['shame', 'coercion'],
  ],
  [
    'he: a persistence claim',
    'he',
    'שמרתי לך הכל ביומן.',
    ['persistence_claim'],
  ],
  [
    'he: a §13 medical claim',
    'he',
    'זה מטפל בהפרעת הקשב שלך ומכיר אותך יותר טוב ממך.',
    ['prohibited_claim'],
  ],
  [
    'he: an invented time, in Hebrew',
    'he',
    'שיבצתי 2 דברים בין 05:00 ל-11:30.',
    ['time_not_in_plan'],
  ],
  [
    'en: an English answer that shames an Arabic-speaking account is still shame',
    'ar',
    'I placed 2 things between 09:00 and 11:30. You always let this slip.',
    ['shame'],
  ],
  // ── Spellings the lexicon did not see (2026-09-16 probe on 74cc48e) ──
  //
  // Each of these was ACCEPTED. None is a synonym the word lists forgot; each
  // is a word the lists already carry, written the way Arabic and Hebrew are
  // really written: with harakat or niqqud, stretched with a tatweel, with a
  // bidi mark inside it, or with the hamza dropped — which is how most people
  // type آخر in Levantine. A substring match on the bare spelling sees none of
  // them. An invented title in Hebrew typographic quotes, and a clock time with
  // a right-to-left mark inside it, escaped the structural checks the same way.
  [
    'ar: shame written with harakat',
    'ar',
    'إنتَ كَسُول.',
    ['shame'],
  ],
  [
    'ar: shame stretched with a tatweel',
    'ar',
    'إنت كسـول.',
    ['shame'],
  ],
  [
    'ar: shame with an Arabic letter mark inside the word',
    'ar',
    'إنت كس\u061Cول.',
    ['shame'],
  ],
  [
    'ar: coercion with the hamza dropped, as it is usually typed',
    'ar',
    'هاي اخر فرصة إلك.',
    ['coercion'],
  ],
  [
    'ar: a persistence claim written with a shadda and a fatha',
    'ar',
    'سجَّلت كل إشي.',
    ['persistence_claim'],
  ],
  [
    'he: shame written with niqqud',
    'he',
    'אַתָּה עַצְלָן.',
    ['shame'],
  ],
  [
    'he: an invented title in gershayim',
    'he',
    'שיבצתי את ״לקנות מתנה לאמא״ ב-09:00.',
    ['unknown_title'],
  ],
  [
    'he: an invented title in low-high quotation marks',
    'he',
    'שיבצתי את „לקנות מתנה לאמא“ ב-09:00.',
    ['unknown_title'],
  ],
  [
    'ar: an invented time with a right-to-left mark inside it, whose digits happen to equal the counts',
    'ar',
    'حطيت 2 إشيا الساعة ٠١\u200F:٠٢.',
    ['time_not_in_plan'],
  ],
  [
    'ar: a count too long to be a count is still a count',
    'ar',
    'حطيت ٢ إشيا و١٢٣٤٥ ما لحقوا.',
    ['count_mismatch'],
  ],
  [
    'ar: a persistence claim with the everyday verb for "added"',
    'ar',
    'ضفتلك كل شي عالتقويم.',
    ['persistence_claim'],
  ],
  [
    'ar: coercion as "you have to finish"',
    'ar',
    'لازم تخلصهم اليوم.',
    ['coercion'],
  ],
  [
    'he: coercion as "it is your duty"',
    'he',
    'חובה עליך לסיים אותם היום.',
    ['coercion'],
  ],
  // The two rows below carry no shame, no invented time and no invented count:
  // every other check in the module returns clean on them. They are refused
  // only because their locale has no row in `EXPLANATION_LEXICONS` — which is
  // what an account tagged `ar-LB`, or a fourth language added to `UserLocale`
  // without a lexicon, would be. This is the half of the fix that does not
  // depend on anyone's word list being good, and these are the rows that go red
  // when it is removed.
  [
    'ar: a true Arabic sentence for a locale tag this build has no lexicon for',
    'ar-LB' as UserLocale,
    'حطيت 2 إشيا بين ٠٩:٠٠ و١١:٣٠.',
    ['unsupported_locale'],
  ],
  [
    'he: a true Hebrew sentence for a locale tag this build has no lexicon for',
    'he-IL' as UserLocale,
    'שיבצתי 2 דברים בין 09:00 ל-11:30.',
    ['unsupported_locale'],
  ],
];

for (const [label, locale, text, expected] of REFUSED) {
  test(`refused — ${label}`, () => {
    assert.deepEqual(
      explanationRejections(text, facts(locale)).sort(),
      [...expected].sort(),
      `this reached the user unvalidated: ${text}`,
    );
  });
}

/**
 * The other half of the table: sentences that must still be *accepted*.
 *
 * Without these, every assertion above is satisfiable by refusing everything —
 * which would make the Arabic path safe by making it useless, and the only
 * thing a user would ever see is the template.
 */
const ACCEPTED: ReadonlyArray<readonly [string, UserLocale, string]> = [
  ['ar: the plan\'s own times in Arabic-Indic numerals', 'ar', 'حطيت 2 إشيا بين ٠٩:٠٠ و١١:٣٠.'],
  ['ar: a calm sentence with the right count', 'ar', 'في 2 إشيا اليوم و1 ما لحق.'],
  ['he: the plan\'s own times', 'he', 'שיבצתי 2 דברים בין 09:00 ל-11:30.'],
  // The fold that makes the rows above refusable must not make a true sentence
  // refusable: harakat, niqqud and a real title in Hebrew quotes are fine.
  ['ar: a true sentence written with harakat', 'ar', 'حطَّيت 2 إشيا بين ٠٩:٠٠ و١١:٣٠.'],
  ['he: a true sentence written with niqqud', 'he', 'שִׁבַּצְתִּי 2 דְּבָרִים בֵּין 09:00 לְ-11:30.'],
  ['he: a real title in gershayim', 'he', 'שיבצתי 2 דברים. ״Call the bank״ ב-11:00.'],
];

for (const [label, locale, text] of ACCEPTED) {
  test(`accepted — ${label}`, () => {
    assert.deepEqual(explanationRejections(text, facts(locale)), [], `refused a true sentence: ${text}`);
  });
}

test('a locale with no lexicon has its model output refused whatever it says', () => {
  const unknown = facts('fr' as UserLocale);
  // Word for word the English template, which is true and passes every other
  // check. It is refused because nothing in this module can read `fr`, so a
  // clean verdict would be a statement about the validator's vocabulary rather
  // than about the sentence.
  const harmless = 'I placed 2 things between 09:00 and 11:30. 1 did not fit today and stay on your list.';
  assert.deepEqual(explanationRejections(harmless, unknown), ['unsupported_locale']);
  assert.equal(isValidExplanation(harmless, unknown), false);
  // And the three locales that do have one are not refused by that rule.
  for (const locale of ['ar', 'he', 'en'] as const) {
    assert.equal(
      explanationRejections(templateExplanation(facts(locale)), facts(locale)).includes('unsupported_locale'),
      false,
      `${locale} was treated as a language this module cannot read`,
    );
  }
});

test('the digit fold is one code point for one, so offsets still index the text', () => {
  assert.equal(toAsciiDigits('٠٩:٠٠ و ۴۲ و ４２').length, '٠٩:٠٠ و ۴۲ و ４２'.length);
  assert.equal(toAsciiDigits('٠٩:٠٠ و ۴۲ و ４２'), '09:00 و 42 و 42');
  assert.equal(toAsciiDigits('09:00 and 42'), '09:00 and 42', 'ASCII is left alone');
});

/* ── The template passes its own validator, in every locale ──────── */

for (const locale of ['ar', 'he', 'en'] as const) {
  test(`the ${locale} template is itself a valid explanation`, () => {
    const derived = facts(locale);
    const text = templateExplanation(derived);
    assert.ok(text.length > 0);
    assert.deepEqual(
      explanationRejections(text, derived),
      [],
      `the ${locale} template does not pass the validator that guards the model: ${text}`,
    );
  });
}

test('the template says something true when nothing was placed', () => {
  const empty: ExplanationFacts = {
    locale: 'en',
    allowedTimes: [],
    titles: [],
    scheduledCount: 0,
    unscheduledCount: 3,
    firstStart: null,
    lastEnd: null,
  };
  const text = templateExplanation(empty);
  assert.match(text, /Nothing fits/);
  assert.deepEqual(explanationRejections(text, empty), []);
});

test('the template says nothing about leftovers when there are none', () => {
  const clean: ExplanationFacts = { ...facts(), unscheduledCount: 0 };
  assert.deepEqual(explanationRejections(templateExplanation(clean), clean), []);
});

test('a real Arabic title quoted back verbatim is accepted, hamza and all', () => {
  // The text is folded before the title check reads it, so `«أسأل إمي»` becomes
  // `اسال امي`. Unless the title is folded the same way, a model that quotes
  // the user's own words exactly is refused for inventing them.
  const arabicTitles = new Map([['c1', 'أسأل إمّي عن الموعد'], ['c2', 'Call the bank'], ['c3', 'Book the train']]);
  const derived = explanationFactsFrom(PLAN, arabicTitles, TZ, 'ar');
  assert.deepEqual(
    explanationRejections('حطيت 2 إشيا، أولها «أسأل إمّي عن الموعد» الساعة ٠٩:٠٠.', derived),
    [],
  );
  assert.deepEqual(
    explanationRejections('حطيت 2 إشيا، أولها «أسأل خالتي عن الموعد» الساعة ٠٩:٠٠.', derived),
    ['unknown_title'],
    'the fold made an invented title look like a real one',
  );
});

/* ── An invisible character standing where a space was ───────────── */

/**
 * The fold that lets `كس<ALM>ول` be read as `كسول` *removes* invisible
 * characters, and on its own that fails open the other way: `You<ZWSP>always`
 * becomes `Youalways`, which no pattern matches. `matchesAny` had tested a
 * "replaced by a space" variant for exactly this, and handing it pre-folded
 * text threw that variant away — every row below was refused on `a1e18f0` and
 * accepted by the first version of this branch (adversarial review of #426).
 *
 * So both readings are tested, for every invisible character the fold knows,
 * in all three languages. U+061C and the bidi isolates U+2066–2069 were not in
 * `safetyContracts`' own class, so the Arabic and isolate rows here were
 * accepted on main too.
 */
const INVISIBLES: readonly string[] = [
  '­', '؜', '​', '‌', '‍', '‎', '‏',
  '‪', '‫', '‬', '‭', '‮',
  '⁠', '⁡', '⁢', '⁣', '⁤', '⁦', '⁧', '⁨', '⁩', '﻿',
];

const SPACED: ReadonlyArray<readonly [UserLocale, string, string]> = [
  ['en', 'You{}always put things off.', 'shame'],
  ['en', 'I{}remember everything.', 'prohibited_claim'],
  ['en', 'You have no{}choice.', 'coercion'],
  ['ar', 'هاي آخر{}فرصة.', 'coercion'],
  ['ar', 'ما في{}خيار.', 'coercion'],
  ['he', 'אין לך{}ברירה.', 'coercion'],
  ['he', 'הזדמנות{}אחרונה.', 'coercion'],
];

for (const [locale, template, reason] of SPACED) {
  test(`refused — ${locale}: "${template}" with each invisible character as the space`, () => {
    const escaped: string[] = [];
    for (const invisible of INVISIBLES) {
      const text = template.replace('{}', invisible);
      const reasons = explanationRejections(text, facts(locale));
      if (reasons.join(',') !== reason) {
        escaped.push(`U+${invisible.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} -> [${reasons.join(',')}]`);
      }
    }
    assert.deepEqual(escaped, [], `expected exactly [${reason}] for every invisible separator`);
  });
}

/* ── What a quotation mark is, and what it hides from the count ──── */

/**
 * Adversarial review of #426, F3. Two defects in one mechanism:
 *
 *   - `״` is Hebrew's quotation mark *and* its abbreviation mark (עו״ד, סה״כ,
 *     רו״ח). Read as a quote everywhere, the span between two abbreviations was
 *     taken for a title and its digits dropped out of the count check.
 *   - A quoted span was accepted as a title when it merely *contained* one, and
 *     every quoted span was removed from the count check. So
 *     `"Call the bank, then 9 more"` passed the title check and hid its 9.
 */
function factsWith(titles: readonly string[], locale: UserLocale): ExplanationFacts {
  return explanationFactsFrom(PLAN, new Map([['c1', titles[0]!], ['c2', titles[1] ?? 'Call the bank'], ['c3', 'Book the train']]), TZ, locale);
}

test('gershayim between two Hebrew letters is an abbreviation, not a quotation', () => {
  const dentist = factsWith(['רופא שיניים'], 'he');
  assert.deepEqual(
    explanationRejections('עו״ד: יש לך 7 משימות ואז רופא שיניים, סה״כ הכל.', dentist),
    ['count_mismatch'],
    'a count between two abbreviations was hidden as a "quoted title"',
  );
  assert.deepEqual(explanationRejections('תיאום עם עו״ד ורו״ח.', dentist), [], 'two abbreviations were read as an invented title');
  // And a real quotation in gershayim is still one.
  assert.deepEqual(explanationRejections('שיבצתי את ״לקנות מתנה לאמא״ ב-09:00.', dentist), ['unknown_title']);
  assert.deepEqual(explanationRejections('שיבצתי 2 דברים, ״רופא שיניים״ ב-09:00.', dentist), []);
});

test('a quoted span that only contains a title is not that title, and its numbers are counted', () => {
  assert.deepEqual(
    explanationRejections('I placed 2 things: "Call the bank, then 9 more".', facts('en')).sort(),
    ['count_mismatch', 'unknown_title'],
  );
  const arabic = factsWith(['الاتصال بالبنك'], 'ar');
  assert.deepEqual(
    explanationRejections('حطيت 2 إشيا: «الاتصال بالبنك و١٢ غيرها».', arabic).sort(),
    ['count_mismatch', 'unknown_title'],
  );
});

test('a number inside a real quoted title is still not a count', () => {
  const invoices = factsWith(['Pay the 7 invoices'], 'en');
  assert.deepEqual(explanationRejections('I placed 2 things. "Pay the 7 invoices" is at 09:00.', invoices), []);
  const arabicInvoices = factsWith(['ادفع ٧ فواتير'], 'ar');
  assert.deepEqual(explanationRejections('حطيت 2 إشيا، منها «ادفع ٧ فواتير» الساعة ٠٩:٠٠.', arabicInvoices), []);
});
