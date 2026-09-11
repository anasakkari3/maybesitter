import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { extractWithOllama } from '../src/extraction/ollamaExtractor.ts';
import { screenForInjection } from '../src/extraction/injectionBoundary.ts';
import type { ExtractionContext, ExtractionResult } from '../src/extraction/extractionTypes.ts';

/** The suite's times are wall-clock in this zone, not UTC. */
export const SUITE_TIMEZONE = 'Asia/Jerusalem';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface DialectCase {
  id: string;
  lang: 'ar' | 'he' | 'en';
  text: string;
  expectedCommitments: number;
  expectedTimes: string[];
}

export interface DialectEvalReport {
  model: string;
  total: number;
  passed: number;
  passRate: number;
  byLanguage: Record<'ar' | 'he' | 'en', { total: number; passed: number }>;
  failures: Array<{ id: string; text: string; expected: unknown; actual: unknown }>;
}

export function loadDialectSuite(
  // Resolved against the repo, not the shell's cwd: a harness that only works
  // when invoked from one directory is not reproducible.
  path = resolve(REPO_ROOT, 'evaluation-data/dialect-suite.jsonl'),
): DialectCase[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DialectCase);
}

/**
 * The wall-clock time a user in the suite's timezone would read off an instant.
 *
 * The expectations are local `HH:MM`; `dueAt` is normalised to UTC. Comparing
 * them directly scored a *correct* Asia/Jerusalem 05:00 (`02:00Z`) as wrong,
 * and passed an answer three hours off because `'08:00Z'` happens to contain
 * the substring `'08:00'`. Both directions of that error are in the committed
 * baseline report.
 */
export function localClock(iso: string, timezone = SUITE_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export interface CaseScore {
  splitOk: boolean;
  /** `null` when the case states no time expectation, so nothing was scored. */
  timeOk: boolean | null;
  ok: boolean;
}

/**
 * Score one case against one extraction.
 *
 * Split and time are scored separately because a single `ExtractionResult`
 * carries one `dueAt`: for a multi-commitment case only the split half is
 * meaningful, and pretending otherwise is how a harness reports a model as
 * wrong for an answer it never had room to give.
 */
export function scoreCase(c: DialectCase, result: ExtractionResult): CaseScore {
  const sawMultiple = result.ambiguityFlags.includes('multiple_commitments');
  const splitOk = c.expectedCommitments > 1 ? sawMultiple : !sawMultiple;

  let timeOk: boolean | null = null;
  if (c.expectedTimes.length > 0 && c.expectedCommitments === 1) {
    timeOk = result.dueAt !== null && localClock(result.dueAt) === c.expectedTimes[0];
  }

  return { splitOk, timeOk, ok: splitOk && timeOk !== false };
}

export async function runDialectEval(
  cases = loadDialectSuite(),
): Promise<DialectEvalReport> {
  // Read here, not from a caller-supplied label. The old signature took a name
  // that only ever reached the report: the model actually used comes from the
  // environment, so the two could disagree — and in the committed baseline
  // they do.
  const model = process.env.MAYBESITTER_LLM_MODEL ?? 'llama3.2';
  const context: ExtractionContext = { now: new Date(), timezone: SUITE_TIMEZONE };
  const byLanguage = {
    ar: { total: 0, passed: 0 },
    he: { total: 0, passed: 0 },
    en: { total: 0, passed: 0 },
  };
  const failures: DialectEvalReport['failures'] = [];

  for (const c of cases) {
    byLanguage[c.lang].total += 1;
    let actual: unknown = null;
    let ok = false;

    // The same boundary every other model call passes through. A fixture file
    // is not automatically trustworthy input, and this harness calls the model
    // directly rather than through extractWithFallback.
    const injection = screenForInjection(c.text);
    if (injection !== null) {
      actual = { blocked: injection };
    } else {
      try {
        const result = await extractWithOllama(c.text, context);
        actual = { dueAt: result.dueAt, title: result.title, flags: result.ambiguityFlags };
        ok = scoreCase(c, result).ok;
      } catch (error) {
        actual = { error: String(error) };
      }
    }

    if (ok) byLanguage[c.lang].passed += 1;
    else failures.push({ id: c.id, text: c.text, expected: c.expectedCommitments, actual });
  }

  const passed = Object.values(byLanguage).reduce((sum, l) => sum + l.passed, 0);
  return {
    model,
    total: cases.length,
    passed,
    passRate: cases.length === 0 ? 0 : Number((passed / cases.length).toFixed(3)),
    byLanguage,
    failures,
  };
}

/** Driver, so a committed report can be reproduced rather than described. */
async function main(): Promise<void> {
  const out = process.argv[2] ?? resolve(REPO_ROOT, 'evaluation-reports/dialect-run.json');
  const report = await runDialectEval();
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.model}: ${report.passed}/${report.total} -> ${out}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
