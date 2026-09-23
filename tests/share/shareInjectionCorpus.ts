/**
 * The committed corpus, read off disk (#193 step 5).
 *
 * A plain module and not a `.test.ts`: `shareInjectionSuite.test.ts` and
 * `shareCorpusShape.test.ts` both need it, and importing one test file from
 * another would run its tests twice under `node --test`.
 *
 * Parsed from `evaluation-data/share-injection-suite.jsonl` rather than
 * imported from the builder, on purpose. The shape suite then asserts the two
 * agree — so a corpus somebody trimmed by hand fails, which a suite that only
 * ever read the builder could not notice.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CorpusCase } from '../../scripts/fixtures/build-share-injection-fixtures';

export const CORPUS_PATH = join(
  import.meta.dirname, '..', '..', 'evaluation-data', 'share-injection-suite.jsonl',
);

export function corpusText(): string {
  return readFileSync(CORPUS_PATH, 'utf8');
}

export function committedCorpus(): readonly CorpusCase[] {
  return corpusText()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CorpusCase);
}
