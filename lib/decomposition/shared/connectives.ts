/**
 * The one lexicon of bare connectives, and the one way to normalise a title
 * before looking it up.
 *
 * Sprint 06 deliberately let #26 and #27 implement the shared violation
 * vocabulary independently, so a cross-track test could compare two readings.
 * That was right for *judgement* — whether a proposal is malformed — and wrong
 * for *data*. A word list and a normalisation rule are not judgements, and
 * three copies of them produced three different answers:
 *
 *   "after"    #26 clean          #27 CONJUNCTION_ONLY   #25 clean
 *   "أو"       #26 CONJUNCTION_ONLY #27 clean            #25 clean
 *   ", and"    #26 CONJUNCTION_ONLY #27 clean            #25 CONJUNCTION_ONLY
 *   "next"     #26 clean          #27 clean              #25 CONJUNCTION_ONLY
 *   "وَ"        #26 clean          #27 clean              #25 CONJUNCTION_ONLY
 *
 * 20 of 31 probed titles disagreed somewhere. The visible half of that is a
 * corpus row the evaluator scores clean and the engine rejects; the invisible
 * half is a quality report that describes a proposal nobody could have made.
 * Neither shows up in either track's own suite, because each is consistent
 * with itself.
 *
 * So: the codes stay independently implemented and independently compared, and
 * the vocabulary they are implemented *over* lives here, once.
 *
 * This is not the same normaliser as `normaliseForSourcing` in the evaluator.
 * That one answers "is this the same text as its spans"; this one answers "is
 * this word nothing but a connective". Folding them together would make one of
 * the two answers wrong.
 */

/**
 * Titles that are only a connective, in every language the product captures.
 *
 * The union of what the three tracks had *and* of the markers the rules
 * detector cuts on, because every entry any of them held
 * was a real artefact one of them had seen. Arabic `و` and Hebrew `ו` are here
 * as bare single characters because both languages write the conjunction as a
 * clitic prefixed onto the next word with no whitespace (`واطلب`, `ותזמין`); a
 * splitter that strips the prefix to find the boundary emits the bare letter as
 * if it were a step, and that artefact passes any "non-empty title" check.
 *
 * Matching is whole-title only. A title that merely *starts* with a connective
 * ("and order the cake", "واطلب الكعكة") is a real step, and rejecting those
 * would break the very rows the clitic handling exists to support.
 */
export const CONNECTIVE_TITLE_LIST: readonly string[] = Object.freeze([
  // English
  'and',
  'then',
  'and then',
  'also',
  'plus',
  'or',
  'next',
  'after',
  'after that',
  // Arabic
  'و',
  'ثم',
  'وثم',
  'بعدها',
  'وبعدها',
  'بعد ذلك',
  'أو',
  'او',
  // Hebrew
  'ו',
  'ואז',
  'אז',
  'או',
  'וגם',
  'ואחר כך',
  'אחכ',
  // Every marker the rules detector cuts on, folded in after a reviewer found
  // five it splits at that no track would then reject as a bare step. A word
  // the product's own splitter treats as a boundary is, by definition, an
  // artefact when it arrives back as a step title.
  'afterwards',
  'وبعد ذلك',
  'وكذلك',
  'אחר כך',
  'לאחר מכן',
]);

/** Lookup form. The list above is the iterable one — `tsconfig` targets es5, where a Set is not directly iterable. */
export const CONNECTIVE_TITLES: ReadonlySet<string> = new Set(CONNECTIVE_TITLE_LIST);

/**
 * Combining marks and invisible format characters, removed before any lookup.
 *
 * Both are ordinary in this product's real input and both defeated the
 * connective list outright: vocalised Arabic (`وَ` is waw + fatha) and a
 * right-to-left mark pasted in ahead of a word (`‏و`) are different strings
 * from the bare conjunction while looking identical on screen, so the artefact
 * walked straight through. Explicit BMP ranges rather than `\p{M}` with the `u`
 * flag, because the repo compiles to es5 where `u` is a compile error.
 *
 *  - `̀-ͯ` Latin combining diacritics
 *  - `֑-ֽ ֿ ׁ-ׂ ׄ-ׅ ׇ` Hebrew niqqud and cantillation
 *  - `ؐ-ؚ ً-ٟ ٰ ۖ-ۭ` Arabic harakat and Quranic marks
 *  - `​-‏ ؜ ‪-‮ ⁦-⁩ ﻿` zero-width and bidi controls
 */
const INVISIBLE_MARKS =
  /[̀-֑ͯ-ׇֽֿׁׂׅׄؐ-ًؚ-ٰٟۖ-ۭ​-‏؜‪-‮⁦-⁩﻿]/g;

/**
 * Punctuation, symbols and separators that carry no meaning on their own.
 *
 * Replaced with a space **everywhere**, not stripped from the ends only: a
 * splitter leaves the delimiter on whichever side it cut, so `", and"` is the
 * same artefact as `"and"`, and an interior one makes `"and-then"` the same
 * artefact as `"and then"`. Replacing with a space rather than deleting is what
 * keeps the interior case from becoming `"andthen"`, which is not a word.
 *
 * Written as an explicit class rather than `\p{P}` with the `u` flag, because
 * the repo compiles to es5 where `u` is a compile error. Note the ASCII hyphen
 * is listed last, on its own: inside a class, `‐-―` is the *range*
 * U+2010–U+2015, so a bare `-` would never be a literal member.
 */
const TITLE_NOISE =
  /[\s.,;:!?،؛؟۔׃"'`()[\]{}«»“”‘’\u2010-\u2015+/&*=~|_\\@#%^<>…·•、。「」\u00a0-]+/g;

/**
 * Normalise a title for connective lookup.
 *
 * Interior spacing survives as single spaces rather than being removed:
 * `"and then"` is a connective while `"andthen"` is not a word at all, so
 * collapsing runs is right and deleting them is not.
 */
export function normalizeConnectiveTitle(title: string): string {
  return title
    .replace(INVISIBLE_MARKS, '')
    .replace(TITLE_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isConnectiveOnly(title: string): boolean {
  const normalized = normalizeConnectiveTitle(title);
  return normalized.length > 0 && CONNECTIVE_TITLES.has(normalized);
}

/**
 * True when a title carries no content at all once punctuation and invisible
 * marks are removed — the `EMPTY_STEP` test, kept here so the two codes are
 * decided against the same normalisation and cannot disagree about which of
 * them a given string is.
 */
export function isEmptyTitle(title: string): boolean {
  return normalizeConnectiveTitle(title).length === 0;
}
