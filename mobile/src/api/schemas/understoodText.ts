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

const AR_LETTER = '\u0621-\u065F\u0670-\u06D3\u06FA-\u06FF';
const HE_LETTER = '\u05D0-\u05EA';

/** Arabic harakat and Quranic marks, Hebrew points, tatweel, zero-width and bidi controls. */
const FOLDED_AWAY = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0591-\u05C7\u0640\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

export function foldForClaims(text: string): string {
  return text.replace(FOLDED_AWAY, '').replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627').replace(/\s+/g, ' ').toLowerCase();
}

/** A word of its own in folded Arabic, with a joining و/ف in front. */
function arabicWords(words: readonly string[]): RegExp {
  return new RegExp(`(?:^|[^${AR_LETTER}])[\u0648\u0641]?(?:${words.map(foldForClaims).join('|')})(?=$|[^${AR_LETTER}])`);
}
function hebrewWords(words: readonly string[]): RegExp {
  return new RegExp(`(?:^|[^${HE_LETTER}])[\u05D5\u05E9]?(?:${words.join('|')})(?=$|[^${HE_LETTER}])`);
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
    '\u0636\u0641\u062A', '\u0636\u0641\u062A\u0647\u0627', '\u0636\u0641\u062A\u0647\u0645', '\u0636\u0641\u062A\u0644\u0643', '\u0636\u0641\u062A\u0644\u0643\u0647\u0627',
    '\u0623\u0636\u0641\u062A', '\u0623\u0636\u0641\u062A\u0647\u0627', '\u0623\u0636\u0641\u062A\u0647\u0645', '\u0623\u0636\u0641\u062A\u0644\u0643',
    '\u0627\u0646\u0636\u0627\u0641', '\u0627\u0646\u0636\u0627\u0641\u062A', '\u0627\u0646\u0636\u0627\u0641\u0648', '\u0627\u0646\u0636\u0627\u0641\u0648\u0627',
    '\u062D\u0641\u0638\u062A', '\u062D\u0641\u0638\u062A\u0647\u0627', '\u062D\u0641\u0638\u062A\u0647\u0645', '\u062D\u0641\u0638\u062A\u0644\u0643',
    '\u0627\u0646\u062D\u0641\u0638', '\u0627\u0646\u062D\u0641\u0638\u062A', '\u0627\u0646\u062D\u0641\u0638\u0648',
    '\u0633\u062C\u0644\u062A', '\u0633\u062C\u0644\u062A\u0647\u0627', '\u0633\u062C\u0644\u062A\u0647\u0645', '\u0633\u062C\u0644\u062A\u0644\u0643',
    '\u0627\u0646\u0633\u062C\u0644', '\u0627\u0646\u0633\u062C\u0644\u062A', '\u0627\u062A\u0633\u062C\u0644', '\u0627\u062A\u0633\u062C\u0644\u062A', '\u062A\u0633\u062C\u0644\u062A',
    '\u062D\u0637\u064A\u062A', '\u062D\u0637\u064A\u062A\u0647\u0627', '\u062D\u0637\u064A\u062A\u0647\u0645', '\u062D\u0637\u064A\u062A\u0644\u0643',
    '\u062C\u062F\u0648\u0644\u062A', '\u062C\u062F\u0648\u0644\u062A\u0647\u0627', '\u062C\u062F\u0648\u0644\u062A\u0644\u0643',
    '\u0636\u0628\u0637\u062A', '\u0636\u0628\u0637\u062A\u0647\u0627', '\u0636\u0628\u0637\u062A\u0644\u0643',
  ]),
  // «تم/تمت/صار (ال)حفظ/إضافة/تسجيل/جدولة/تذكير/ضبط»
  new RegExp(`(?:^|[^${AR_LETTER}])(?:\u062A\u0645|\u062A\u0645\u062A|\u0635\u0627\u0631) (?:\u0627\u0644)?(?:\u062D\u0641\u0638|\u0627\u0636\u0627\u0641\u0629|\u062A\u0633\u062C\u064A\u0644|\u062C\u062F\u0648\u0644\u0629|\u062A\u0630\u0643\u064A\u0631|\u0636\u0628\u0637)`),
  // A promised reminder: «رح ذكرك», «بذكرك», «حنبهك», «سأذكرك».
  new RegExp(`(?:^|[^${AR_LETTER}])(?:(?:\u0631\u062D|\u0631\u0627\u062D|\u062D) ?(?:\u0627|\u0646)?(?:\u0630\u0643\u0631\u0643|\u0646\u0628\u0647\u0643)|\u0628\u0630\u0643\u0631\u0643|\u0628\u0646\u0628\u0647\u0643|\u062D\u0630\u0643\u0631\u0643|\u062D\u0646\u0628\u0647\u0643|\u0633\u0627\u0630\u0643\u0631\u0643|\u0633\u0627\u0646\u0628\u0647\u0643)(?=$|[^${AR_LETTER}])`),
  hebrewWords([
    '\u05D4\u05D5\u05E1\u05E4\u05EA\u05D9', '\u05E9\u05DE\u05E8\u05EA\u05D9', '\u05E7\u05D1\u05E2\u05EA\u05D9', '\u05E8\u05E9\u05DE\u05EA\u05D9', '\u05EA\u05D6\u05DE\u05E0\u05EA\u05D9',
    '\u05D4\u05DB\u05E0\u05E1\u05EA\u05D9', '\u05E9\u05DE\u05EA\u05D9', '\u05E0\u05E9\u05DE\u05E8', '\u05E0\u05E9\u05DE\u05E8\u05D4', '\u05E0\u05E9\u05DE\u05E8\u05D5',
    '\u05E0\u05D5\u05E1\u05E3', '\u05E0\u05D5\u05E1\u05E4\u05D4', '\u05E0\u05D5\u05E1\u05E4\u05D5', '\u05E0\u05E7\u05D1\u05E2', '\u05E0\u05E7\u05D1\u05E2\u05D4',
    '\u05E0\u05E7\u05D1\u05E2\u05D5', '\u05E0\u05E8\u05E9\u05DD', '\u05E0\u05E8\u05E9\u05DE\u05D4', '\u05E0\u05E8\u05E9\u05DE\u05D5', '\u05D0\u05D6\u05DB\u05D9\u05E8',
  ]),
];

/**
 * A link of any kind: a scheme, `www.`, or a host name — letters, digits and
 * hyphens with at least one dot and a final label of two or more letters
 * ("example.dev", "zoom.us/j/1"; an e-mail's domain too). A decimal ("2.5"),
 * an abbreviation ("e.g."), a file name ("report.pdf") and an honorific
 * ("Mr.Smith") are not hosts — the server keeps those words as well.
 */
const FILE_EXTENSIONS = 'pdf|docx?|xlsx?|pptx?|txt|jpe?g|png|heic|mp3|mp4|zip';
const LINK = new RegExp(
  '(?:^|[^a-z0-9-])(?:[a-z][a-z0-9+.-]*:\\/\\/|www\\.|webcal:|'
  // A host — but not a file name («report.pdf») and not an honorific glued to
  // a name («Mr.Smith»): those are the person's words (M2a combined review F3).
  + `(?!(?:mr|mrs|ms|dr)\\.[a-z])[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?!(?:${FILE_EXTENSIONS})(?![a-z0-9-]))[a-z]{2,}(?![a-z0-9-]))`,
);

export function claimsSaved(text: string): boolean {
  const folded = foldForClaims(text);
  return SAVED_CLAIMS.some((pattern) => pattern.test(folded));
}

export function hasLink(text: string): boolean {
  return LINK.test(foldForClaims(text));
}
