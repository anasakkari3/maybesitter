/**
 * Rendering a calibration report (Sprint 05, issue #22).
 *
 * Two things the rendering must never do, both of which would be easy:
 *
 *  - Print a concordance rate without its coverage. "83%" over six of forty
 *    pairs is not a measurement of the ranking, and the two figures are one
 *    fact rather than a headline with a footnote.
 *  - Print a candidate's weights in a form that reads like something to copy
 *    into `priorityPolicy.ts`. With a synthetic corpus those numbers are the
 *    output of a pipeline test, and the document says so at the top, in the
 *    same place a reader looks for the headline.
 */
import type { ConcordanceMetric } from '../../../src/contracts/v1/calibrationContracts';
import type { PriorityCalibrationReport } from './calibrate';

function coverageOf(metric: ConcordanceMetric): string {
  const total = metric.scorablePairs + metric.unscorablePairs;
  const rate = metric.rate === null ? 'not computable' : `${(metric.rate * 100).toFixed(1)}%`;
  return `${rate} over ${metric.scorablePairs} of ${total} pairs (${metric.concordantPairs} concordant)`;
}

export function generateCalibrationMarkdown(report: PriorityCalibrationReport): string {
  const synthetic = report.manifest.corpusProvenance === 'synthetic_pipeline_proof';
  const lines: string[] = [
    '# Priority Calibration Report',
    '',
  ];

  if (synthetic) {
    lines.push(
      '> **SYNTHETIC — PIPELINE PROOF ONLY — NOT HUMAN EVIDENCE.** The judgments behind this run are',
      '> labelled `synthetic_pipeline_proof`. They demonstrate that the calibration pipeline runs. They say',
      '> nothing about what any person would prefer, and no weight in this report may be shipped on their',
      '> authority.',
      '',
    );
  }

  lines.push(
    `Generated: ${report.manifest.generatedAt}`,
    `Status: **${report.status}**`,
    `Base policy: \`${report.manifest.basePolicyVersion}\` | Schema: \`${report.version}\``,
    '',
    '## Manifest',
    '',
    '| field | value |',
    '|---|---|',
    `| corpus digest | \`${report.manifest.corpusDigest}\` |`,
    `| corpus provenance | \`${report.manifest.corpusProvenance}\` |`,
    `| search seed | ${report.manifest.searchSeed} |`,
    `| candidates evaluated | ${report.manifest.candidatesEvaluated} |`,
    `| locked split used | ${report.manifest.lockedSplitUsed ? 'yes' : 'no'} |`,
    '',
    'Re-running from this manifest, against the same corpus and base policy, reproduces this report',
    'byte for byte.',
    '',
    '## Concordance',
    '',
    `Baseline: ${coverageOf(report.baseline.overall)}`,
    report.best === null
      ? 'Best admissible candidate: **none**.'
      : `Best admissible candidate (\`${report.best.policy.version}\`): ${coverageOf(report.best.overall)}`,
    '',
    `Admissible candidates: ${report.admissibleCandidateCount} of ${report.candidates.length}. ` +
      `Rejected for a hard-constraint violation despite beating the baseline: ${report.rejectedForConstraintCount}.`,
    '',
    'Hard-constraint preservation is a filter, not a scoring term: a candidate that reorders a constrained',
    'pair is rejected outright, whatever it does to the aggregate.',
    '',
  );

  if (report.baseline.overall.rate === null) {
    lines.push(
      '> No pair in this corpus was scorable, so no rate is reported. A rate of 0 here would present the',
      '> absence of judgments as a measurement of total disagreement.',
      '',
    );
  }

  const target = report.best ?? report.baseline;
  lines.push('## Slices', '', '| slice | before | after |', '|---|---|---|');
  for (const slice of target.bySlice) {
    lines.push(`| \`${slice.slice}\` | ${coverageOf(slice.before)} | ${coverageOf(slice.after)} |`);
  }

  lines.push('', '## Regressions', '');
  if (report.regressions.length === 0) {
    lines.push('No slice lost concordance under the selected candidate.');
  } else {
    for (const slice of report.regressions) {
      lines.push(`- \`${slice.slice}\`: ${coverageOf(slice.before)} → ${coverageOf(slice.after)}`);
    }
  }

  lines.push('', '### Pairs the candidate gets wrong that the baseline got right', '');
  if (report.regressedPairs.length === 0) {
    lines.push('None.');
  } else {
    for (const pair of report.regressedPairs) {
      lines.push(
        `- \`${pair.pairId}\` (\`${pair.slice}\`): judged \`${pair.targetVerdict}\`, ` +
          `baseline ordered \`${pair.baselinePredicted}\`, candidate orders \`${pair.candidatePredicted}\``,
      );
    }
  }

  lines.push(
    '',
    '## What this report is not',
    '',
    'It is not a configuration change. `policyUnchanged` is `true` and is typed as the literal `true`:',
    'shipping any weight found here is a separate, deliberate edit to `lib/priority/priorityPolicy.ts`,',
    'visible in review, and blocked by `tests/priority/policyFreeze.test.ts` until someone changes that',
    'test on purpose.',
    '',
    '---',
    '*End of report.*',
  );

  return lines.join('\n');
}
