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

/** Arabic or Hebrew letters: text whose Latin runs need isolating. */
const RTL_LETTER = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\uFB1D-\uFDFF\uFE70-\uFEFF]/;
/**
 * A Latin run: a word, or words joined by spaces, dots, hyphens, apostrophes
 * and parentheses — "Gemini", "Google (Vertex AI)", "(Vertex AI)" — opening
 * on a letter or "(" and ending on a letter, a digit or ")".
 */
const LATIN_RUN = /\(?[A-Za-z][A-Za-z0-9 .()'&-]*[A-Za-z0-9)]|[A-Za-z]/g;

/**
 * Each Latin run inside an Arabic or Hebrew sentence, isolated
 * (`isolateAuto`), so "(Vertex AI)" is not split and reordered by the
 * sentence around it and «لـGemini» keeps the brand whole after its
 * preposition. Text with no Arabic or Hebrew letter is returned unchanged.
 */
export function isolateLatinRuns(text: string): string {
  if (!RTL_LETTER.test(text)) return text;
  return text.replace(LATIN_RUN, (run) => isolateAuto(run));
}

/** The first strong (Arabic, Hebrew or Latin) letter of `text`, skipping isolates, digits and punctuation. */
const STRONG = /[\u0590-\u05FF\uFB1D-\uFB4F]|[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]|[A-Za-z\u00C0-\u024F]/;

/**
 * The direction a piece of user text reads in by itself: its first strong
 * letter decides (the Unicode "first strong" rule), and text with none —
 * digits, punctuation — takes `fallback`. Used to lay out a fact written in a
 * language other than the app's on its own side (condition 53).
 */
export function firstStrongDirection(text: string, fallback: 'ltr' | 'rtl'): 'ltr' | 'rtl' {
  const match = stripIsolates(text).match(STRONG);
  if (!match) return fallback;
  return /[A-Za-z\u00C0-\u024F]/.test(match[0]) ? 'ltr' : 'rtl';
}
