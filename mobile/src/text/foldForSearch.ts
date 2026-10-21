/**
 * Search folding (PLAN-M6a R54.1). Provisional app copy: Task B owns the
 * server copy in `src/text/foldForSearch.ts`, and the two must be
 * byte-identical (Gate B compares them); at integration this file is replaced
 * by Task B's.
 */
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const HEBREW_MARKS = /[֑-ׇ]/g;

export function foldForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase()
    .replace(ARABIC_MARKS, '').replace(HEBREW_MARKS, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** True when `needle` occurs in `haystack` at the start of a word (both already folded). */
export function isWordPrefixMatch(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    if (at === 0 || !WORD_CHAR.test(haystack[at - 1]!)) return true;
    from = at + 1;
  }
}

/** A folded query has something to search for: at least one letter or digit. */
export function isSearchable(folded: string): boolean {
  return WORD_CHAR.test(folded);
}
