/**
 * How dictated words join the text around them.
 *
 * Pure, so both halves of the rule are tested without a recogniser: the
 * composer adds a dictation to what is already in the field (it never replaces
 * it), and the service joins the finished parts of one long dictation.
 */

/**
 * The field after this dictation: what was there when the dictation started,
 * then the spoken words.
 *
 * One space separates them — none when the field is empty or already ends in
 * whitespace (a space or a new line the user typed stays theirs). The spoken
 * words are trimmed, because iOS 18 prefixes every segment after the first with
 * a space.
 */
export function appendDictation(base: string, spoken: string): string {
  const words = spoken.trim();
  if (words === '') return base;
  if (base.trim() === '') return words;
  return /\s$/.test(base) ? `${base}${words}` : `${base} ${words}`;
}

/** One dictation's finished segments, joined by single spaces. */
export function joinSegments(done: string, segment: string): string {
  const words = segment.trim();
  if (words === '') return done;
  return done === '' ? words : `${done} ${words}`;
}
