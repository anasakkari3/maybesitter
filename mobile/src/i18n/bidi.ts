// Unicode bidi isolates (U+2066–U+2069). An isolate tells the bidi algorithm to
// resolve the run inside it on its own and treat the whole thing as one neutral
// character in the surrounding sentence. Without it, a time such as "9:00"
// dropped into an Arabic sentence drags the punctuation around it to the wrong
// side, and a Latin title at the end of an Arabic line jumps to the front.

const LRI = '⁦'; // LEFT-TO-RIGHT ISOLATE
const RLI = '⁧'; // RIGHT-TO-LEFT ISOLATE
const FSI = '⁨'; // FIRST STRONG ISOLATE
const PDI = '⁩'; // POP DIRECTIONAL ISOLATE

/** Wraps `text` so it reads in `dir` regardless of the sentence around it. */
export function isolate(text: string, dir: 'ltr' | 'rtl' = 'ltr'): string {
  return (dir === 'rtl' ? RLI : LRI) + text + PDI;
}

/**
 * Wraps `text` so its own first strong character decides its direction. Use it
 * for anything the user typed — a commitment title can be Arabic, Hebrew or
 * English and the app cannot know which.
 */
export function isolateAuto(text: string): string {
  return FSI + text + PDI;
}

/**
 * Removes every isolate control. Isolates are invisible but still count as
 * characters, so strip them before measuring length, comparing strings, or
 * sending text to the backend.
 */
export function stripIsolates(text: string): string {
  return text.replace(/[⁦-⁩]/g, '');
}

/**
 * Keeps times such as "9:00" left-to-right inside Arabic sentences. This is the
 * helper the screens have always called; it is `isolate(text, 'ltr')`.
 */
export const ltr = (text: string): string => isolate(text, 'ltr');
