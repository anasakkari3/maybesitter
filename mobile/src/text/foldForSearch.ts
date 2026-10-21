/**
 * The shared, deliberately small search normalisation used by server and app.
 * Keep this file byte-identical to mobile/src/text/foldForSearch.ts.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

const LETTER_OR_NUMBER = new RegExp('[\\p{L}\\p{N}]', 'u');

/** True when needle starts the string or follows punctuation/spacing. */
export function isWordPrefixMatch(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    if (index === 0 || !LETTER_OR_NUMBER.test(haystack[index - 1]!)) return true;
    from = index + 1;
  }
}
