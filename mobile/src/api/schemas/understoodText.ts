/**
 * Whether a line of «هيك فهمت» is plain words (M2a, M2A-REV-001): no link and
 * no claim that something was saved — nothing is saved before the confirm.
 *
 * The claims are the server's own (`lib/services/captureChat/chatReply.ts`,
 * `SAVED_CLAIMS`), read the way it reads them: diacritics, tatweel and
 * invisible marks folded away, every alef with a hamza or madda read as
 * a bare alef, so «حفّظت» or «حـفـظـت» is still «حفظت».
 *
 * Spelled for Hermes as the rest of the app is (`features/meetings/prepTargets.ts`):
 * word edges are letter ranges, with no `\b` beside Arabic or Hebrew, no
 * `\p{…}` class, no look-behind and no `String.prototype.normalize`.
 */

const AR_LETTER = 'ء-ٰٟ-ۓۺ-ۿ';
const HE_LETTER = 'א-ת';

/** Arabic harakat and Quranic marks, Hebrew points, tatweel, zero-width and bidi controls. */
const FOLDED_AWAY = /[ً-ٰٟۖ-ۭ֑-ׇـ​-‏‪-‮⁠-⁩﻿]/g;

export function foldForClaims(text: string): string {
  return text.replace(FOLDED_AWAY, '').replace(/[آأإٱ]/g, 'ا').replace(/\s+/g, ' ').toLowerCase();
}

/** A word of its own in folded Arabic, with a joining و/ف in front. */
function arabicWords(words: readonly string[]): RegExp {
  return new RegExp(`(?:^|[^${AR_LETTER}])[وف]?(?:${words.map(foldForClaims).join('|')})(?=$|[^${AR_LETTER}])`);
}
function hebrewWords(words: readonly string[]): RegExp {
  return new RegExp(`(?:^|[^${HE_LETTER}])[וש]?(?:${words.join('|')})(?=$|[^${HE_LETTER}])`);
}

const SAVED_CLAIMS: readonly RegExp[] = [
  /\b(?:i|we)(?:'ve|'d|\s+have|\s+just|\s+already|\s+now)*\s+(?:added|saved|scheduled|booked|created|stored|recorded|logged|entered|reminded|put\s+(?:it|them|that|this))\b/,
  /\b(?:i|we)(?:'ve|\s+have)\s+(?:just\s+|already\s+)?set\b/,
  /\b(?:i|we)(?:'ll|\s+will)\s+(?:be\s+sure\s+to\s+)?remind\b/,
  /\b(?:it|they|that|this|these|those|everything|reminders?)(?:'s|'re|\s+is|\s+are|\s+has|\s+have|\s+was|\s+were|\s+been|\s+now|\s+all)+\s+(?:added|saved|scheduled|booked|created|stored|recorded|set)\b/,
  /\b(?:added|saved|scheduled|booked|put)\b[^.!?\n]{0,20}\b(?:to|on|in|into)\s+(?:your|the)\s+(?:calendar|list|schedule|agenda|reminders?|plan|day)\b/,
  /\b(?:all set|you're all set)\b/,
  // «ضفت/أضفت/انضاف/حفظت/انحفظ/سجّلت/انسجل/حطيت/جدولت/ضبطت», each with its objects.
  arabicWords([
    'ضفت', 'ضفتها', 'ضفتهم', 'ضفتلك', 'ضفتلكها',
    'أضفت', 'أضفتها', 'أضفتهم', 'أضفتلك',
    'انضاف', 'انضافت', 'انضافو', 'انضافوا',
    'حفظت', 'حفظتها', 'حفظتهم', 'حفظتلك',
    'انحفظ', 'انحفظت', 'انحفظو',
    'سجلت', 'سجلتها', 'سجلتهم', 'سجلتلك',
    'انسجل', 'انسجلت', 'اتسجل', 'اتسجلت', 'تسجلت',
    'حطيت', 'حطيتها', 'حطيتهم', 'حطيتلك',
    'جدولت', 'جدولتها', 'جدولتلك',
    'ضبطت', 'ضبطتها', 'ضبطتلك',
  ]),
  // «تم/تمت/صار (ال)حفظ/إضافة/تسجيل/جدولة/تذكير/ضبط»
  new RegExp(`(?:^|[^${AR_LETTER}])(?:تم|تمت|صار) (?:ال)?(?:حفظ|اضافة|تسجيل|جدولة|تذكير|ضبط)`),
  // A promised reminder: «رح ذكرك», «بذكرك», «حنبهك», «سأذكرك».
  new RegExp(`(?:^|[^${AR_LETTER}])(?:(?:رح|راح|ح) ?(?:ا|ن)?(?:ذكرك|نبهك)|بذكرك|بنبهك|حذكرك|حنبهك|ساذكرك|سانبهك)(?=$|[^${AR_LETTER}])`),
  hebrewWords([
    'הוספתי', 'שמרתי', 'קבעתי', 'רשמתי', 'תזמנתי',
    'הכנסתי', 'שמתי', 'נשמר', 'נשמרה', 'נשמרו',
    'נוסף', 'נוספה', 'נוספו', 'נקבע', 'נקבעה',
    'נקבעו', 'נרשם', 'נרשמה', 'נרשמו', 'אזכיר',
  ]),
];

/**
 * A link of any kind: a scheme, `www.`, or a host name — letters, digits and
 * hyphens with at least one dot and a final label of two or more letters
 * ("example.dev", "zoom.us/j/1"). A decimal ("2.5") and an abbreviation
 * ("e.g.") are not hosts.
 */
const LINK = /(?:^|[^a-z0-9-])(?:[a-z][a-z0-9+.-]*:\/\/|www\.|webcal:|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![a-z0-9-]))/;

export function claimsSaved(text: string): boolean {
  const folded = foldForClaims(text);
  return SAVED_CLAIMS.some((pattern) => pattern.test(folded));
}

export function hasLink(text: string): boolean {
  return LINK.test(foldForClaims(text));
}
