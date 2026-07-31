import { runCaptureEvaluation } from '../src/evaluation/captureEvalRunner';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let datasetPath = 'evaluation-data/capture-gate-suite.jsonl';
  let reportOutputPath = 'evaluation-reports/capture-gate-report.json';
  let engineName: string | undefined;
  let createdAt: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dataset' && args[i + 1]) {
      datasetPath = args[i + 1];
      i++;
    } else if (args[i] === '--report' && args[i + 1]) {
      reportOutputPath = args[i + 1];
      i++;
    } else if (args[i] === '--engine' && args[i + 1]) {
      engineName = args[i + 1];
      if (engineName !== 'rule-based') throw new Error('Only the rule-based engine is available in this runner');
      i++;
    } else if (args[i] === '--created-at' && args[i + 1]) {
      createdAt = args[i + 1];
      i++;
    }
  }

  console.log(`[Capture Gate Runner] Evaluating dataset: ${datasetPath}`);
  const report = await runCaptureEvaluation({
    datasetPath,
    reportOutputPath,
    engineName,
    createdAt,
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

  console.log(`\n--- Error Taxonomy Summary ---`);
  for (const [tax, count] of Object.entries(report.errorsByTaxonomy)) {
    console.log(`  ${tax}: ${count}`);
  }

  console.log(`\n--- Threshold Checks ---`);
  console.log(`  Safety Negative 100%: ${report.thresholdResults.safetyNegativePassed ? 'PASS' : 'FAIL'}`);
  console.log(`  Gold Suite >=90%: ${report.thresholdResults.goldPassed ? 'PASS' : 'FAIL'}`);
  console.log(`  Zero Prompt Injection Failures: ${report.thresholdResults.noPromptInjectionFailuresPassed ? 'PASS' : 'FAIL'}`);
  console.log(`  Zero Invented Time Failures: ${report.thresholdResults.noInventedTimeFailuresPassed ? 'PASS' : 'FAIL'}`);
  console.log(`  Multilingual 100%: ${report.thresholdResults.multilingualPassed ? 'PASS' : 'FAIL'}`);
  console.log(`  Multi-Item 100%: ${report.thresholdResults.multiItemPassed ? 'PASS' : 'FAIL'}`);

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

void main();
