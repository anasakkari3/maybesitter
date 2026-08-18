/**
 * Feedback backfill/replay CLI (Sprint 03, issue #14).
 *
 * Reads an export of the raw feedback log, recomputes every scope's aggregate
 * from the events, and writes a **reconciliation report** — markdown plus JSON,
 * in the shape of scripts/alpha-quality-run.ts and scripts/fixture-coverage-run.ts.
 *
 * It writes no aggregates. That is the point of the command: aggregates are
 * derived on every read, so the only thing worth persisting is the evidence
 * that a replay of the log reproduces them exactly. A cached total would be a
 * second source of truth that can drift from the history it came from, and the
 * user's revocations would stop taking effect the moment it did.
 *
 * Usage:
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/feedback-replay.ts \
 *     --input=<log-export.json> [--now=<iso>] [--window-days=<n>] \
 *     [--out-dir=<dir>] [--json-only]
 *
 * The export is `{ now?, windowDays?, scopes: [{ scopeId, events, baseline }] }`.
 * --now exists because the aggregation never reads the system clock; the CLI is
 * the boundary where a real clock is legitimate, and passing it explicitly makes
 * a run reproducible. The report records which of the two it used.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFeedbackReconciliation,
  generateFeedbackReconciliationMarkdown,
  parseFeedbackLogExport,
  type ReplayNowSource,
} from '../lib/feedback/feedbackReconciliation';

function flag(name: string): string | undefined {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : undefined;
}

const USAGE =
  'Usage: feedback-replay.ts --input=<log-export.json> [--now=<iso>] [--window-days=<n>] [--out-dir=<dir>] [--json-only]';

function main(): void {
  const inputPath = flag('input');
  if (!inputPath) {
    console.error(`feedback-replay: --input=<path> is required.\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const jsonOnly = process.argv.includes('--json-only');
  const outDir = flag('out-dir') ?? join(process.cwd(), 'docs', 'quality', 'reports');
  const windowDaysFlag = flag('window-days');

  const parsed = parseFeedbackLogExport(JSON.parse(readFileSync(inputPath, 'utf8')));

  // Precedence: an explicit flag, then whatever the export was taken at, then
  // the wall clock — recorded either way, because a report stamped from the
  // wall clock cannot be reproduced and a reader has to know that.
  const nowFlag = flag('now');
  const nowSource: ReplayNowSource = nowFlag ? 'flag' : parsed.now ? 'input-file' : 'system-clock';
  const now = nowFlag ?? parsed.now ?? new Date().toISOString();

  const report = buildFeedbackReconciliation({
    scopes: parsed.scopes,
    now,
    nowSource,
    windowDays: windowDaysFlag !== undefined ? Number(windowDaysFlag) : parsed.windowDays,
  });

  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, 'feedback-replay-latest.md');
  const jsonPath = join(outDir, 'feedback-replay-latest.json');
  if (!jsonOnly) writeFileSync(mdPath, generateFeedbackReconciliationMarkdown(report));
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log('=== Feedback Replay Reconciliation ===');
  console.log(
    `Scopes: ${report.scopeCount} | Events: ${report.totalEvents} | Revoked: ${report.totalRevoked} | Late: ${report.totalLate} | With baseline: ${report.scopesWithBaseline}`,
  );
  console.log(`Window: ${report.windowDays}d from ${report.windowStart} | now from: ${report.nowSource}`);
  console.log(`Global window: ${report.global.scopeCount} contributing scope(s)`);
  console.log(`Status: ${report.status}`);
  if (!jsonOnly) console.log(`Report: ${mdPath}`);
  console.log(`JSON: ${jsonPath}`);
  console.log('No aggregate was persisted; the event log remains the source of truth.');

  for (const failure of report.failures) console.error(`RECONCILIATION FAILURE: ${failure}`);
  if (report.status !== 'RECONCILED') {
    console.error('MISMATCH: at least one scope did not replay identically. See the report.');
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error('Feedback replay failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
