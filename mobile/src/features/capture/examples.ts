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

export function exampleText(key: ExampleKey, t: Strings): string {
  switch (key) {
    case 'doctor': return t.exDoctor;
    case 'report': return t.exReport;
    case 'sami': return t.exSami;
    case 'study': return t.exStudy;
    case 'hi': return t.exHi;
  }
}
