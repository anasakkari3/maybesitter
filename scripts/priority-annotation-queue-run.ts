/**
 * Priority annotation queue CLI (Sprint 05, issue #21).
 *
 * Builds the annotation queue, verifies the checksum lock on the held-out
 * evaluation split, loads whatever reviewed decisions exist, re-runs them
 * through the ingest checks, and writes the coverage report as markdown plus
 * JSON under docs/quality/reports/.
 *
 * Today it will report an **empty decision corpus**, and that is the expected
 * outcome, not a failure: Sprint 05 ships the ingestion point wired and
 * unpopulated. What *is* a failure is a broken split lock, a malformed decision
 * row, a duplicate, or a pair that leaked in from the locked split.
 *
 * The shipped corpus is re-ingested rather than merely parsed on purpose. Rows
 * can be appended to the file by hand, and a hand-appended row bypasses every
 * check the store performs; running them back through `ingestDecisions` means
 * the committed corpus is held to exactly the same standard as one that arrived
 * through the store.
 *
 * **This CLI owns the clock.** Every builder it calls takes `generatedAt` as a
 * parameter, so two runs over an unchanged corpus produce an unchanged report
 * body — the reports are committed artifacts, and a clock read inside a builder
 * would make every diff noise. Shape mirrors scripts/priority-agreement-run.ts.
 *
 * Usage:
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-annotation-queue-run.ts
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-annotation-queue-run.ts --json-only
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-annotation-queue-run.ts \
 *     --export-batch out/batch-01.json --batch-id batch-01 --batch-limit 8 --batch-offset 0
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  buildAnnotationQueue,
  exportAnnotationBatch,
} from '../lib/priority/annotation/annotationQueue';
import {
  DECISION_CORPUS_PATH,
  loadShippedDecisionCorpus,
} from '../lib/priority/annotation/decisionCorpus';
import { ingestDecisions } from '../lib/priority/annotation/decisionIngest';
import {
  buildQueueCoverageReport,
  generateQueueCoverageMarkdown,
} from '../lib/priority/annotation/queueCoverage';
import { verifySeedSetLock } from '../lib/priority/rubric/seedSetLock';
import { formatIssue } from '../lib/evaluation/registry/validationPrimitives';

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

function intFlag(name: string): number | undefined {
  const raw = flagValue(name);
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer, received '${raw}'`);
  return parsed;
}

const jsonOnly = process.argv.includes('--json-only');
const exportBatchPath = flagValue('--export-batch');

async function main(): Promise<void> {
  // The CLI owns the clock; every builder below takes it, so an unchanged
  // corpus produces an unchanged report body.
  const generatedAt = new Date().toISOString();

  const queue = buildAnnotationQueue({ enqueuedAt: generatedAt });
  const lock = verifySeedSetLock();
  const loaded = loadShippedDecisionCorpus();

  // Re-run the committed rows through ingest: a hand-appended row bypasses the
  // store's guards, so this is the only place a leaked or duplicated row in the
  // file itself would surface.
  const ingested = ingestDecisions(loaded.decisions, { queue: queue.items });

  const coverage = buildQueueCoverageReport({
    generatedAt,
    items: queue.items,
    decisions: ingested.accepted,
    conflicts: ingested.conflicts,
    withheldLockedPairIds: queue.withheldLockedPairIds,
  });

  const reportDir = join(process.cwd(), 'docs', 'quality', 'reports');
  mkdirSync(reportDir, { recursive: true });
  const coverageJson = join(reportDir, 'priority-annotation-queue-coverage.json');
  const coverageMd = join(reportDir, 'priority-annotation-queue-coverage.md');

  writeFileSync(coverageJson, `${JSON.stringify(coverage, null, 2)}\n`);
  if (!jsonOnly) writeFileSync(coverageMd, `${generateQueueCoverageMarkdown(coverage)}\n`);

  if (exportBatchPath) {
    const batch = exportAnnotationBatch(queue.items, {
      batchId: flagValue('--batch-id') ?? 'batch-01',
      exportedAt: generatedAt,
      limit: intFlag('--batch-limit'),
      offset: intFlag('--batch-offset'),
    });
    mkdirSync(dirname(exportBatchPath), { recursive: true });
    writeFileSync(exportBatchPath, `${JSON.stringify(batch, null, 2)}\n`);
    console.log(`Batch: ${batch.items.length} items -> ${exportBatchPath}`);
  }

  console.log('=== Priority Annotation Queue ===');
  console.log(
    `Queue items: ${coverage.totalItems} | Decided: ${coverage.decidedItems} | ` +
      `Pending: ${coverage.pendingItems} | Skipped: ${coverage.skippedItems}`,
  );
  console.log(
    `Withheld (locked split): ${coverage.withheldLockedPairIds.length}` +
      (coverage.withheldLockedPairIds.length > 0 ? ` [${coverage.withheldLockedPairIds.join(', ')}]` : ''),
  );
  console.log(`Locked-split checksum: ${lock.valid ? 'VERIFIED' : 'FAILED'}`);
  console.log(`Decision corpus: ${DECISION_CORPUS_PATH}`);
  console.log(`Provenance: ${loaded.provenance ?? 'UNDECLARED'} | Rubric: ${loaded.rubricVersion ?? 'UNDECLARED'}`);
  console.log(
    `Decisions: ${coverage.decisionCount} | Reviewers: ${coverage.reviewerCount} | ` +
      `Unresolved: ${coverage.unresolvedCount} | Retained conflicts: ${coverage.conflictCount}`,
  );

  if (coverage.corpusEmpty) {
    console.log(
      'CORPUS EMPTY: no reviewer decision has been recorded. The ingestion point is wired and unpopulated,',
    );
    console.log('which is the expected Sprint 05 state — see docs/quality/PRIORITY_ANNOTATION_QUEUE.md §5.');
  }

  for (const conflict of coverage.conflictCount > 0 ? ingested.conflicts : []) {
    console.log(
      `CONFLICT RETAINED: ${conflict.pairId} — ${conflict.verdicts.join(' vs ')} ` +
        `(${conflict.decisionIds.join(', ')})`,
    );
  }
  for (const rejection of ingested.rejected) {
    console.error(`REJECTED ${rejection.code}: ${rejection.decisionId}`);
  }
  for (const issue of ingested.issues) console.error(`INGEST: ${formatIssue(issue)}`);
  for (const issue of lock.issues) console.error(`LOCK: ${formatIssue(issue)}`);
  for (const issue of loaded.issues) console.error(`CORPUS: ${formatIssue(issue)}`);

  if (!jsonOnly) console.log(`Reports: ${coverageMd}`);

  if (!lock.valid || !loaded.valid || ingested.rejected.length > 0) {
    console.error('GATE FAILED: a broken split lock, a malformed decision row, a duplicate, or a leaked pair.');
    process.exitCode = 1;
    return;
  }
  console.log('GATE PASSED (locked split verified, decision corpus loads and re-ingests cleanly).');
}

main().catch((error) => {
  console.error('Priority annotation queue run failed:', error);
  process.exitCode = 1;
});
