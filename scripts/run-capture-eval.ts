import { runCaptureEvaluation, THRESHOLD_PRESETS } from '../src/evaluation/captureEvalRunner';
import type { ExtractAndMapOptions } from '../src/extraction/extractionService';

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Only deliberate synthetic eval batches may use this CLI adapter. */
export async function geminiOptions(dependencies: import('./syntheticEvalProvider').SyntheticEvalDependencies = {}): Promise<ExtractAndMapOptions> {
  const { syntheticEvalProvider } = await import('./syntheticEvalProvider');
  return { llmEngine: 'gemini', llmProvider: syntheticEvalProvider('capture_extraction', dependencies) };
}

function usage(): string {
  return [
    'Usage: npm run capture:eval -- [options]',
    '',
    '  --dataset <path>      JSONL suite to evaluate',
    '  --report <path>       where to write the JSON report',
    '  --engine <name>       rule-based (default) | gemini',
    '  --thresholds <name>   ' + Object.keys(THRESHOLD_PRESETS).join(' | '),
    '  --created-at <iso>    fix the report timestamp, for reproducible commits',
    '',
    'A gemini run needs a configured Vertex project and bills the owner\'s',
    'account. Use rule-based for the committed baseline.',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let datasetPath = 'evaluation-data/capture-gate-suite.jsonl';
  let reportOutputPath = 'evaluation-reports/capture-gate-report.json';
  let engineName: string | undefined;
  let createdAt: string | undefined;
  let thresholdName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dataset' && args[i + 1]) {
      datasetPath = args[i + 1];
      i++;
    } else if (args[i] === '--report' && args[i + 1]) {
      reportOutputPath = args[i + 1];
      i++;
    } else if (args[i] === '--engine' && args[i + 1]) {
      engineName = args[i + 1];
      if (engineName !== 'rule-based' && engineName !== 'gemini') {
        throw new Error(`Unknown engine '${engineName}'. Use rule-based or gemini.`);
      }
      i++;
    } else if (args[i] === '--thresholds' && args[i + 1]) {
      thresholdName = args[i + 1];
      if (!THRESHOLD_PRESETS[thresholdName]) {
        throw new Error(`Unknown threshold preset '${thresholdName}'. Known: ${Object.keys(THRESHOLD_PRESETS).join(', ')}`);
      }
      i++;
    } else if (args[i] === '--created-at' && args[i + 1]) {
      createdAt = args[i + 1];
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(usage());
      return;
    } else {
      throw new Error(`Unrecognised argument '${args[i]}'.\n\n${usage()}`);
    }
  }

  console.log(`[Capture Gate Runner] Evaluating dataset: ${datasetPath}`);
  console.log(`[Capture Gate Runner] Engine: ${engineName ?? 'rule-based'} | thresholds: ${thresholdName ?? 'default'}`);
  const report = await runCaptureEvaluation({
    datasetPath,
    reportOutputPath,
    engineName,
    createdAt,
    ...(thresholdName ? { thresholdName } : {}),
    ...(engineName === 'gemini' ? { options: await geminiOptions() } : {}),
  });

  console.log(`\n=== Capture Evaluation Gate Report ===`);
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Engine: ${report.engine}`);
  console.log(`Total Cases: ${report.totalCases}`);
  console.log(`Overall Pass Rate: ${report.overallPassRatePercent}% (${report.overallPassed ? 'GATE PASSED' : 'GATE FAILED'})`);
  console.log(`Median Latency: ${report.medianLatencyMs} ms | p95 Latency: ${report.p95LatencyMs} ms`);

  console.log(`\n--- Per-Slice Metrics ---`);
  for (const [sliceName, metrics] of Object.entries(report.perSlice)) {
    console.log(`  Slice [${sliceName}]: ${metrics.passed}/${metrics.total} passed (${metrics.passRatePercent}%)`);
  }

  if (Object.keys(report.perLanguage).length > 1) {
    console.log(`\n--- Per-Language Metrics ---`);
    for (const [language, metrics] of Object.entries(report.perLanguage)) {
      console.log(`  ${language.padEnd(12)}: ${metrics.passed}/${metrics.total} passed (${metrics.passRatePercent}%)`);
    }
  }

  console.log(`\n--- Accuracy Metrics ---`);
  console.log(`  Type accuracy:          ${report.typeAccuracyPercent}%`);
  console.log(`  Local time exact match: ${report.timeExactMatchPercent}%`);
  console.log(`  Title keyword match:    ${report.titleKeywordMatchPercent}%`);

  console.log(`\n--- Error Taxonomy Summary ---`);
  for (const [tax, count] of Object.entries(report.errorsByTaxonomy)) {
    console.log(`  ${tax}: ${count}`);
  }

  console.log(`\n--- Threshold Checks ---`);
  if (engineName === 'gemini') console.log(`  Gemini model coverage: ${report.thresholdResults.modelCoveragePassed ? 'PASS' : 'FAIL'}`);
  console.log(`  Safety Negative 100%: ${report.thresholdResults.safetyNegativePassed ? 'PASS' : 'FAIL'}`);
  console.log(`  Gold Suite >=90%: ${report.thresholdResults.goldPassed ? 'PASS' : 'FAIL'}`);
  console.log(`  Zero Prompt Injection Failures: ${report.thresholdResults.noPromptInjectionFailuresPassed ? 'PASS' : 'FAIL'}`);
  console.log(`  Zero Invented Time Failures: ${report.thresholdResults.noInventedTimeFailuresPassed ? 'PASS' : 'FAIL'}`);
  console.log(`  Multilingual 100%: ${report.thresholdResults.multilingualPassed ? 'PASS' : 'FAIL'}`);
  console.log(`  Multi-Item: ${report.thresholdResults.multiItemPassed ? 'PASS' : 'FAIL'}`);
  const optional: Array<[string, boolean, number | undefined, number]> = [
    ['Type accuracy', report.thresholdResults.typeAccuracyPassed, report.thresholds.typeAccuracyPercent, report.typeAccuracyPercent],
    ['Time exact match', report.thresholdResults.timeExactMatchPassed, report.thresholds.timeExactMatchPercent, report.timeExactMatchPercent],
    ['Title keywords', report.thresholdResults.titleKeywordMatchPassed, report.thresholds.titleKeywordMatchPercent, report.titleKeywordMatchPercent],
  ];
  for (const [label, passed, threshold, actual] of optional) {
    if (threshold === undefined) continue;
    console.log(`  ${label} >=${threshold}%: ${passed ? 'PASS' : 'FAIL'} (${actual}%)`);
  }
  if (report.thresholds.maxP95LatencyMs !== undefined) {
    console.log(`  p95 latency <=${report.thresholds.maxP95LatencyMs} ms: ${report.thresholdResults.p95LatencyPassed ? 'PASS' : 'FAIL'} (${report.p95LatencyMs} ms)`);
  }
  if (report.thresholds.maxCreatesSomethingFailures !== undefined) {
    console.log(`  Creates nothing: ${report.thresholdResults.createsNothingPassed ? 'PASS' : 'FAIL'} (${report.errorsByTaxonomy.creates_something_failure} violations)`);
  }

  if (report.caseResults.some((c) => !c.passed)) {
    console.log(`\n--- Failed Cases ---`);
    for (const failure of report.caseResults.filter((c) => !c.passed)) {
      console.log(`  Case [${failure.id}] (${failure.slice}):`);
      for (const err of failure.taxonomyErrors) {
        console.log(`    Error Taxonomy: ${err}`);
      }
      for (const m of failure.mismatches) {
        console.log(`    Mismatch in '${m.field}': expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`);
      }
    }
  }

  console.log(`\nReport saved to: ${reportOutputPath}`);
  process.exitCode = report.overallPassed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(() => {
  console.error('Capture evaluation failed before a valid report was produced. Check configuration and inputs.');
  process.exitCode = 1;
});
