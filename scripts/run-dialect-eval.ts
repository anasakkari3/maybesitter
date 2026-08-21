import { readFileSync } from 'node:fs';
import { extractWithOllama } from '../src/extraction/ollamaExtractor.ts';
import type { ExtractionContext } from '../src/extraction/extractionTypes.ts';

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
  path = 'evaluation-data/dialect-suite.jsonl',
): DialectCase[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DialectCase);
}

export async function runDialectEval(
  modelName: string,
  cases = loadDialectSuite(),
): Promise<DialectEvalReport> {
  const context: ExtractionContext = { now: new Date(), timezone: 'Asia/Jerusalem' };
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
    try {
      const result = await extractWithOllama(c.text, context);
      actual = { dueAt: result.dueAt, title: result.title, flags: result.ambiguityFlags };
      // A single ExtractionResult means one commitment; the flag means more.
      const sawMultiple = result.ambiguityFlags.includes('multiple_commitments');
      const splitOk = c.expectedCommitments > 1 ? sawMultiple : !sawMultiple;
      const timeOk =
        c.expectedTimes.length === 0
          ? true
          : c.expectedTimes.some((t) => (result.dueAt ?? '').includes(t));
      ok = splitOk && timeOk;
    } catch (error) {
      actual = { error: String(error) };
    }
    if (ok) byLanguage[c.lang].passed += 1;
    else failures.push({ id: c.id, text: c.text, expected: c.expectedCommitments, actual });
  }

  const passed = Object.values(byLanguage).reduce((sum, l) => sum + l.passed, 0);
  return {
    model: modelName,
    total: cases.length,
    passed,
    passRate: cases.length === 0 ? 0 : Number((passed / cases.length).toFixed(3)),
    byLanguage,
    failures,
  };
}
