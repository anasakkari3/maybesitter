/**
 * The on-disk judgment corpus for the Priority annotation rubric
 * (Sprint 04, issue #19).
 *
 * This file is the ingestion point, and as of Sprint 04 the file it reads
 * contains **zero rows**. That is deliberate and load-bearing: the corpus is
 * human judgment data, none has been collected, and rows written by engineering
 * would read as human evidence while being nothing of the kind. Sprint 05
 * calibrates a ranking policy against exactly this data.
 *
 * Reading is separated from parsing so the parser stays pure and testable
 * against constructed inputs, and the only filesystem access sits here — the
 * same split lib/quality/fixtureCoverageReport.ts uses against its CLI.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  JUDGMENT_CORPUS_CONTRACT_VERSION,
  loadPairwiseJudgments,
  type JudgmentLoadResult,
  type LoadJudgmentsOptions,
} from './agreementReport';
import { PRIORITY_SEED_PAIRS } from '../../../tests/fixtures/prioritySeedSet';

/**
 * Resolved from this module rather than `process.cwd()`, so a CLI, a test and an
 * editor task all read the same file regardless of where they were launched.
 */
export const JUDGMENT_CORPUS_PATH = fileURLToPath(
  new URL('../../../data/quality/priority-judgments.json', import.meta.url),
);

export { JUDGMENT_CORPUS_CONTRACT_VERSION };

export function readJudgmentCorpusFile(path: string = JUDGMENT_CORPUS_PATH): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * Loads and validates the shipped corpus against the committed seed set.
 *
 * Expected result today: `valid: true`, `corpusEmpty: true`, zero judgments.
 * `tests/priority/prioritySeedSet.test.ts` asserts exactly that, and is written
 * to fail the moment rows appear — so adding the first real annotations is a
 * deliberate, reviewable act rather than a quiet drift.
 */
export function loadShippedJudgmentCorpus(options?: {
  path?: string;
  loadOptions?: LoadJudgmentsOptions;
}): JudgmentLoadResult {
  return loadPairwiseJudgments(
    readJudgmentCorpusFile(options?.path),
    options?.loadOptions ?? { seedPairs: PRIORITY_SEED_PAIRS },
  );
}
