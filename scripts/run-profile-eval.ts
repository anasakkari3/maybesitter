/**
 * The self-description eval (UC-2.7b, #168).
 *
 *   npm run profile:eval -- --engine gemini
 *
 * Requires a configured model. Without one it refuses rather than reporting a
 * vacuous pass: every case would produce nothing, every safety target would be
 * trivially met, and the report would say the extraction is safe when nothing
 * was extracted.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { loadProfileEvalCases, runProfileEvaluation } from '../src/evaluation/profileEvalRunner';

const SUITE = join(process.cwd(), 'evaluation-data', 'profile-extraction-v1.jsonl');
const REPORT = join(process.cwd(), 'evaluation-reports', 'profile-extraction-report.json');

export async function geminiComplete(dependencies: import('./syntheticEvalProvider').SyntheticEvalDependencies = {}): Promise<(prompt: string) => Promise<string>> {
  const { syntheticEvalProvider } = await import('./syntheticEvalProvider');
  return syntheticEvalProvider('profile_extraction', dependencies);
}

async function main(): Promise<void> {
  const engine = process.argv.includes('--engine')
    ? process.argv[process.argv.indexOf('--engine') + 1]
    : 'gemini';
  if (engine !== 'gemini') {
    throw new Error(`Only --engine gemini is meaningful here; got ${String(engine)}.`);
  }

  const cases = loadProfileEvalCases(SUITE);
  const report = await runProfileEvaluation(cases, { complete: await geminiComplete() });

  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`cases                ${report.cases}`);
  console.log(`sensitive leaks      ${report.sensitiveLeaks}   (target 0)`);
  console.log(`invented goals       ${report.inventedGoals}   (target 0)`);
  console.log(`stated goal recall   ${(report.recall * 100).toFixed(1)}%   (target 85%)`);
  for (const failure of report.failures) console.log(`  FAIL  ${failure}`);
  console.log(report.pass ? 'RESULT: PASS' : 'RESULT: FAIL');
  console.log(`Report saved to: ${REPORT}`);

  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
