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

/** A letter (never a digit, a mark or punctuation), and the scripts that decide a direction. */
const LETTER = /\p{L}/u;
const RTL_SCRIPT = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;

/**
 * The direction a piece of user text reads in by itself: its first strong
 * letter decides (the Unicode "first strong" rule), and text with none —
 * digits, punctuation — takes `fallback`. Used to lay out a fact written in a
 * language other than the app's on its own side (condition 53).
 */
/** The script of the first letter: what face a paragraph of user text is set in (M6A-INSPECT-R2-002). */
export function firstStrongScript(text: string): 'arabic' | 'hebrew' | 'latin' | null {
  for (const char of stripIsolates(text)) {
    if (!LETTER.test(char)) continue;
    return /\p{Script=Arabic}/u.test(char) ? 'arabic' : /\p{Script=Hebrew}/u.test(char) ? 'hebrew' : 'latin';
  }
  return null;
}

export function firstStrongDirection(text: string, fallback: 'ltr' | 'rtl'): 'ltr' | 'rtl' {
  // Code point by code point, letters only: «٣ Dentist» and «، Dentist» start
  // at the D (M6A-INSPECT-001).
  for (const char of stripIsolates(text)) {
    if (!LETTER.test(char)) continue;
    return RTL_SCRIPT.test(char) ? 'rtl' : 'ltr';
  }
  return fallback;
}
