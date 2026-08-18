/**
 * Coverage report for the Priority annotation queue (Sprint 05, issue #21).
 *
 * ── `corpusEmpty` is reported, not implied ──────────────────────────
 *
 * A report over no decisions says so in a field. Rendering `decidedItems: 0`
 * and leaving a reader to infer the rest would present the absence of data as a
 * measurement, which Sprint 04's agreement report already refused to do: that is
 * not a smaller error than fabricating rows, it is the same error wearing a
 * number.
 *
 * ── `bySlice` names every slice, including the empty ones ───────────
 *
 * A slice with no decisions appears at zero rather than being omitted. An absent
 * key and a zero read identically in a JSON diff only if you already know the
 * full slice vocabulary, and the whole point of a coverage report is that the
 * reader does not.
 *
 * ── Three buckets that sum to the total ─────────────────────────────
 *
 * `decidedItems + pendingItems + skippedItems === totalItems`. A skipped item is
 * not pending — nobody is going to judge it — and it is not decided either.
 * Folding skips into either bucket would overstate coverage or overstate the
 * work remaining, and the test asserts the sum so a fourth state cannot be added
 * without someone noticing.
 *
 * ── No clock ────────────────────────────────────────────────────────
 *
 * `generatedAt` is a required parameter. This report is a committed artifact, so
 * a clock read here would make two runs over an unchanged corpus produce two
 * different files, and every review of the diff would be noise. The CLI owns the
 * clock. A repo-wide test enforces this for everything under lib/priority.
 */
import {
  CALIBRATION_SCHEMA_VERSION,
  type AnnotationQueueItem,
  type DecisionConflict,
  type QueueCoverageReport,
  type ReviewedDecision,
} from '../../../src/contracts/v1/calibrationContracts';
import { isIsoTimestamp } from '../../evaluation/registry/validationPrimitives';
import { detectDecisionConflicts } from './decisionStore';

function fail(message: string): never {
  throw new Error(`annotation coverage: ${message}`);
}

/** Code-unit ordering, never localeCompare: this output is committed. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Extends the committed `QueueCoverageReport` rather than replacing it.
 *
 * The contract fixes the fields a consumer may rely on; these add the figures
 * that make the contract's numbers readable — the queue composition a
 * `bySlice` of zeros is measured against, and the abstentions that explain why
 * a decided pair produced no conflict.
 */
export interface PriorityQueueCoverageReport extends QueueCoverageReport {
  /** Items nobody will judge. Neither decided nor pending. */
  readonly skippedItems: number;
  /** Rows, not pairs: two reviewers on one pair are two decisions and one decided item. */
  readonly decisionCount: number;
  readonly reviewerIds: readonly string[];
  /** Queue composition, so a `bySlice` of zeros has a denominator. */
  readonly itemsBySlice: Readonly<Record<string, number>>;
  /** Abstentions. Counted here, never folded into `conflictCount`. */
  readonly unresolvedCount: number;
  /** Pairs held out of the queue entirely, stated rather than left implicit. */
  readonly withheldLockedPairIds: readonly string[];
  readonly status: 'CORPUS EMPTY' | 'REPORTED';
}

export interface BuildQueueCoverageOptions {
  /** Required. This report is committed; the CLI owns the clock. */
  readonly generatedAt: string;
  readonly items: readonly AnnotationQueueItem[];
  readonly decisions: readonly ReviewedDecision[];
  /** Defaults to the conflicts implied by `decisions`. */
  readonly conflicts?: readonly DecisionConflict[];
  readonly withheldLockedPairIds?: readonly string[];
}

export function buildQueueCoverageReport(
  options: BuildQueueCoverageOptions,
): PriorityQueueCoverageReport {
  if (!isIsoTimestamp(options?.generatedAt)) {
    fail('generatedAt must be an ISO-8601 timestamp; this builder reads no clock of its own');
  }
  const { items, decisions } = options;
  const conflicts = options.conflicts ?? detectDecisionConflicts(decisions);

  const decidedPairIds = new Set(decisions.map((decision) => decision.pairId));
  const slices = Array.from(new Set(items.map((item) => item.slice))).sort(byCodeUnit);

  const bySlice: Record<string, number> = {};
  const itemsBySlice: Record<string, number> = {};
  for (const slice of slices) {
    // Every slice gets a key, at zero if nobody judged it. The vocabulary is the
    // information; the counts are only readable against it.
    bySlice[slice] = 0;
    itemsBySlice[slice] = 0;
  }

  let decidedItems = 0;
  let skippedItems = 0;
  let pendingItems = 0;
  for (const item of items) {
    itemsBySlice[item.slice] += 1;
    if (decidedPairIds.has(item.pairId) || item.state === 'decided') {
      decidedItems += 1;
      bySlice[item.slice] += 1;
    } else if (item.state === 'skipped') {
      skippedItems += 1;
    } else {
      pendingItems += 1;
    }
  }

  const reviewerIds = Array.from(new Set(decisions.map((decision) => decision.reviewerId))).sort(byCodeUnit);
  const corpusEmpty = decisions.length === 0;

  return Object.freeze({
    version: CALIBRATION_SCHEMA_VERSION,
    generatedAt: options.generatedAt,
    totalItems: items.length,
    decidedItems,
    pendingItems,
    bySlice: Object.freeze(bySlice),
    reviewerCount: reviewerIds.length,
    conflictCount: conflicts.length,
    corpusEmpty,
    skippedItems,
    decisionCount: decisions.length,
    reviewerIds: Object.freeze(reviewerIds),
    itemsBySlice: Object.freeze(itemsBySlice),
    unresolvedCount: decisions.filter((decision) => decision.verdict === 'unresolved').length,
    withheldLockedPairIds: Object.freeze((options.withheldLockedPairIds ?? []).slice().sort(byCodeUnit)),
    status: corpusEmpty ? 'CORPUS EMPTY' : 'REPORTED',
  });
}

/* ── Markdown ───────────────────────────────────────────────────── */

const CONFLICT_RULE =
  'A pair on which two reviewers disagree produces **two stored decisions and one conflict** — never an ' +
  'average and never a last-write-wins row. Disagreement usually means the rubric is ambiguous at that ' +
  'pair, which is a fact about the rubric, and a collapsed row would destroy it exactly where it carries ' +
  'the most information. An `unresolved` verdict is counted separately and is *not* a conflict, following ' +
  "Sprint 04's treatment of abstention: it is neither agreement nor disagreement, and calling it a " +
  'conflict would push a reviewer to guess rather than abstain.';

export function generateQueueCoverageMarkdown(report: PriorityQueueCoverageReport): string {
  const lines: string[] = [
    '# Priority Annotation Queue Coverage',
    '',
    '> The commitment pairs queued here are **SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE**',
    '> (`tests/fixtures/prioritySeedSet.ts`). The *decisions*, when any exist, are human judgments and are',
    '> the only human evidence in this report.',
    '',
    `Generated: ${report.generatedAt}`,
    `Schema: \`${report.version}\``,
    `Status: **${report.status}**`,
    '',
    '## Queue',
    '',
    `Items: ${report.totalItems} | Decided: ${report.decidedItems} | Pending: ${report.pendingItems} | ` +
      `Skipped: ${report.skippedItems}`,
  ];

  if (report.withheldLockedPairIds.length > 0) {
    lines.push(
      '',
      `Withheld from the queue: ${report.withheldLockedPairIds.length} pairs in the **locked evaluation ` +
        'split**. They are never handed to a reviewer, and a decision naming one is rejected at ingest ' +
        '(`LOCKED_SPLIT_LEAKAGE`). A pair that is fitted on and then validated on measures nothing.',
      '',
      ...report.withheldLockedPairIds.map((pairId) => `- \`${pairId}\``),
    );
  }

  if (report.corpusEmpty) {
    lines.push(
      '',
      '## No reviewer decision has been recorded',
      '',
      'The decision store contains **zero decisions**. Sprint 05 ships this ingestion point wired and',
      'empty: the queue, schema, storage, ingest checks and this report are present and tested, and',
      '`data/quality/priority-annotation-decisions.json` carries no rows.',
      '',
      'No coverage rate is reported, because there is nothing to report. Issue #22 fits ranking weights',
      'against this corpus; rows written by engineering would read as reviewer evidence while being',
      'nothing of the kind, and the weights fitted to them would be indistinguishable from weights fitted',
      'to real preferences.',
      '',
      CONFLICT_RULE,
      '',
      'To run a real annotation round, see §5 of `docs/quality/PRIORITY_ANNOTATION_QUEUE.md`.',
      '',
      '## Queue composition',
      '',
      '| slice | items | decided |',
      '|---|---|---|',
      ...Object.keys(report.itemsBySlice)
        .sort(byCodeUnit)
        .map((slice) => `| \`${slice}\` | ${report.itemsBySlice[slice]} | ${report.bySlice[slice]} |`),
      '',
      '---',
      '*End of report.*',
    );
    return lines.join('\n');
  }

  lines.push(
    '',
    '## Decisions',
    '',
    `Decisions: ${report.decisionCount} | Reviewers: ${report.reviewerCount} | ` +
      `Unresolved: ${report.unresolvedCount} | Retained conflicts: ${report.conflictCount}`,
    '',
    '### How disagreement is treated',
    '',
    CONFLICT_RULE,
    '',
    '## Coverage by slice',
    '',
    '| slice | items | decided |',
    '|---|---|---|',
    ...Object.keys(report.itemsBySlice)
      .sort(byCodeUnit)
      .map((slice) => `| \`${slice}\` | ${report.itemsBySlice[slice]} | ${report.bySlice[slice]} |`),
    '',
    '## Reviewers',
    '',
    ...report.reviewerIds.map((reviewerId) => `- \`${reviewerId}\``),
    '',
    '---',
    '*End of report.*',
  );
  return lines.join('\n');
}
