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
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadProfileEvalCases, runProfileEvaluation } from '../src/evaluation/profileEvalRunner';

const SUITE = join(process.cwd(), 'evaluation-data', 'profile-extraction-v1.jsonl');
const REPORT = join(process.cwd(), 'evaluation-reports', 'profile-extraction-report.json');

async function geminiComplete(): Promise<(prompt: string) => Promise<string>> {
  const { captureLlmProvider } = await import('../lib/llm/captureProvider');
  const { configuredProviderName } = await import('../src/extraction/llm');

  if (configuredProviderName() === 'none') {
    throw new Error(
      'No model is configured. Set MAYBESITTER_LLM_PROVIDER and the Vertex variables. '
      + 'This suite has nothing to measure without one.',
    );
  }
  // A dedicated uid, so an evaluation batch does not spend a real user's daily
  // allowance — and so case 25 of 30 cannot fall back mid-run and turn the
  // report into a mixture of two engines.
  const uid = process.env.MAYBESITTER_EVAL_UID ?? 'profile-eval-harness';
  return captureLlmProvider(uid, { purpose: 'profile_extraction' });
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

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
