import type { Strings } from '../../i18n/strings';

/**
 * The four example sentences under the composer (UC-2.R2, #172).
 *
 * Copy, not behaviour. These used to live in `src/services/mockCapture.ts`
 * beside `analyzeText`, a rule engine that matched a sentence against these
 * same examples and returned a canned proposal — which is what the composer
 * ran instead of the server. That engine is gone; tapping a chip now types its
 * text into the real field, and the real endpoint reads it like any other.
 */
export type ExampleKey = 'doctor' | 'report' | 'sami' | 'study' | 'hi';

export const EXAMPLE_KEYS: readonly ExampleKey[] = ['doctor', 'report', 'sami', 'study', 'hi'];

/**
 * The three the composer shows. Five chips plus a hint stacked above the fold
 * pushed the field and Analyze under the keyboard. `doctor` is the field's own
 * placeholder, so a chip repeating it was the same sentence twice; `hi` is the
 * nothing-to-commit example, which is not what somebody opening the composer
 * came to do.
 */
export const COMPOSER_EXAMPLE_KEYS: readonly ExampleKey[] = ['report', 'sami', 'study'];

export function exampleText(key: ExampleKey, t: Strings): string {
  switch (key) {
    case 'doctor': return t.exDoctor;
    case 'report': return t.exReport;
    case 'sami': return t.exSami;
    case 'study': return t.exStudy;
    case 'hi': return t.exHi;
  }
}
