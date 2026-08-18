/**
 * The Priority annotation queue (Sprint 05, issue #21).
 *
 * ── Status ─────────────────────────────────────────────────────────
 *
 * **No decisions exist.** This sprint ships the queue *wired and empty*, exactly
 * as Sprint 04 shipped the judgment corpus: schema, storage, ingest checks,
 * conflict detection and the coverage report are all here and tested, and
 * `data/quality/priority-annotation-decisions.json` carries zero rows. Rows
 * written by engineering would read as reviewer evidence while being nothing of
 * the kind, and issue #22 fits ranking weights against exactly this data.
 *
 * ── The locked split is never enqueued ──────────────────────────────
 *
 * `buildAnnotationQueue` withholds every pair in the held-out evaluation split
 * and says so, rather than filtering silently. This is the first of two leakage
 * directions; `decisionIngest.ts` is the second. Neither alone is sufficient:
 *
 *  - The queue alone cannot help, because a decision can arrive from a reviewer
 *    file, an older batch, or a hand-written import that never consulted it.
 *  - The ingest check alone cannot help either, because a reviewer would still
 *    be shown locked pairs and spend their time on answers that must then be
 *    discarded — and a rejection at ingest is a poor place to discover that.
 *
 * Leakage matters because a policy fitted on a pair and then "validated" on that
 * same pair produces a number that measures nothing. The split stops being held
 * out at the moment one of its pairs is judged.
 *
 * ── No clock ────────────────────────────────────────────────────────
 *
 * `enqueuedAt` and `exportedAt` are parameters. A queue whose contents shift
 * with the hour cannot be exported, reviewed offline and re-imported as the same
 * batch, and a batch file that differs between two runs over unchanged input is
 * not reviewable. A repo-wide test enforces this for everything under
 * lib/priority.
 */
import {
  CALIBRATION_SCHEMA_VERSION,
  type AnnotationQueueItem,
  type QueueItemState,
  type ReviewedDecision,
} from '../../../src/contracts/v1/calibrationContracts';
import type { ValidationIssue } from '../../evaluation/registry/contracts';
import {
  IssueCollector,
  isIsoTimestamp,
  isNonEmptyString,
  isPlainObject,
} from '../../evaluation/registry/validationPrimitives';
import { PRIORITY_SEED_PAIRS, type PrioritySeedPair } from '../../../tests/fixtures/prioritySeedSet';

export const QUEUE_ITEM_ID_PREFIX = 'aq_';

/**
 * Item ids name batch files and are matched against on import, so they are held
 * to the same standard as decision ids: no separator, no dot, nothing that could
 * name a path outside a directory.
 */
export const QUEUE_ITEM_ID_PATTERN = /^aq_[A-Za-z0-9_-]{1,120}$/;

export const QUEUE_ITEM_STATES: readonly QueueItemState[] = Object.freeze([
  'pending',
  'decided',
  'skipped',
]);

function fail(message: string): never {
  throw new Error(`annotation queue: ${message}`);
}

/** Code-unit ordering, never localeCompare: batch composition must not shift with the host locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Mints a queue item id from a pair id.
 *
 * Throws rather than sanitising. A sanitised id could collide with a different
 * pair's id, which would silently merge two pairs into one queue item.
 */
export function queueItemIdFor(pairId: string): string {
  const candidate = `${QUEUE_ITEM_ID_PREFIX}${pairId}`;
  if (!isNonEmptyString(pairId) || !QUEUE_ITEM_ID_PATTERN.test(candidate)) {
    fail(
      `cannot mint a queue item id from pair id ${JSON.stringify(pairId)}: ` +
        `the result must match ${String(QUEUE_ITEM_ID_PATTERN)}`,
    );
  }
  return candidate;
}

/**
 * Default slice label.
 *
 * Language × load pattern, because those are the two axes the seed set is
 * balanced over. Language is the axis on which a verdict change is a defect by
 * definition — matched cells differ only in ids and text — and load pattern is
 * the axis on which the *cost* of a ranking error changes. A consumer that wants
 * coarser buckets passes its own `sliceOf`; #22's slice metrics group on this
 * label without needing to know how it was derived.
 */
export function defaultSliceOf(pair: PrioritySeedPair): string {
  return `${pair.language}/${pair.loadPattern}`;
}

export interface BuildAnnotationQueueOptions {
  /** Supplied, never read from a clock. */
  readonly enqueuedAt: string;
  readonly pairs?: readonly PrioritySeedPair[];
  readonly sliceOf?: (pair: PrioritySeedPair) => string;
}

export interface AnnotationQueueBuild {
  readonly items: readonly AnnotationQueueItem[];
  /**
   * Pair ids withheld because they belong to the locked evaluation split.
   *
   * Reported rather than dropped: a caller that expected 20 items and received
   * 16 needs to see *why*, and a silent filter is indistinguishable from a bug
   * that lost four pairs.
   */
  readonly withheldLockedPairIds: readonly string[];
}

/**
 * Builds the queue a reviewer is handed.
 *
 * Deterministic: pairs are ordered by id, every timestamp is the supplied one,
 * and no id is random — so two runs over an unchanged seed set produce byte
 * identical output.
 */
export function buildAnnotationQueue(options: BuildAnnotationQueueOptions): AnnotationQueueBuild {
  if (!isPlainObject(options)) fail('options must be an object');
  if (!isIsoTimestamp(options.enqueuedAt)) {
    fail('enqueuedAt must be an ISO-8601 timestamp; the queue reads no clock of its own');
  }
  const sliceOf = options.sliceOf ?? defaultSliceOf;
  const pairs = (options.pairs ?? PRIORITY_SEED_PAIRS).slice().sort((a, b) => byCodeUnit(a.pairId, b.pairId));

  const items: AnnotationQueueItem[] = [];
  const withheld: string[] = [];

  for (const pair of pairs) {
    if (pair.split === 'locked') {
      withheld.push(pair.pairId);
      continue;
    }
    const slice = sliceOf(pair);
    if (!isNonEmptyString(slice)) fail(`sliceOf produced an empty slice label for '${pair.pairId}'`);
    items.push(
      Object.freeze({
        version: CALIBRATION_SCHEMA_VERSION,
        itemId: queueItemIdFor(pair.pairId),
        pairId: pair.pairId,
        leftCommitmentId: pair.left.commitment.id,
        rightCommitmentId: pair.right.commitment.id,
        state: 'pending' as QueueItemState,
        slice,
        enqueuedAt: options.enqueuedAt,
      }),
    );
  }

  return Object.freeze({ items: Object.freeze(items), withheldLockedPairIds: Object.freeze(withheld) });
}

/* ── State transitions ──────────────────────────────────────────── */

/**
 * Marks every item that carries at least one decision as `decided`.
 *
 * Derived from the decisions rather than mutated as a side effect of ingest, so
 * the queue can always be recomputed from (seed set, decisions) and cannot drift
 * out of step with the store.
 */
export function applyDecisionsToQueue(
  items: readonly AnnotationQueueItem[],
  decisions: readonly ReviewedDecision[],
): readonly AnnotationQueueItem[] {
  const decidedPairIds = new Set(decisions.map((decision) => decision.pairId));
  return Object.freeze(
    items.map((item) =>
      // A decision wins over a skip: the item demonstrably was decided, and
      // leaving it `skipped` would understate coverage.
      decidedPairIds.has(item.pairId) && item.state !== 'decided'
        ? Object.freeze({ ...item, state: 'decided' as QueueItemState })
        : item,
    ),
  );
}

/**
 * Marks one pending item as skipped.
 *
 * Refuses to skip a decided item. Overwriting `decided` with `skipped` would
 * erase the fact that a decision exists while leaving the decision itself in the
 * store, and the two would then disagree about what happened.
 */
export function markQueueItemSkipped(
  items: readonly AnnotationQueueItem[],
  itemId: string,
): readonly AnnotationQueueItem[] {
  const target = items.find((item) => item.itemId === itemId);
  if (!target) fail(`unknown queue item '${String(itemId)}'`);
  if (target.state === 'decided') {
    fail(`'${itemId}' is already decided; skipping it would contradict a decision that exists`);
  }
  return Object.freeze(
    items.map((item) =>
      item.itemId === itemId ? Object.freeze({ ...item, state: 'skipped' as QueueItemState }) : item,
    ),
  );
}

/* ── Batches ────────────────────────────────────────────────────── */

export interface AnnotationBatch {
  readonly version: typeof CALIBRATION_SCHEMA_VERSION;
  readonly batchId: string;
  readonly exportedAt: string;
  readonly items: readonly AnnotationQueueItem[];
}

export interface ExportBatchOptions {
  readonly batchId: string;
  /** Supplied, never read from a clock. */
  readonly exportedAt: string;
  readonly limit?: number;
  readonly offset?: number;
  /** Which states to include. Defaults to `pending` only. */
  readonly states?: readonly QueueItemState[];
}

/**
 * Cuts a batch out of the queue for one reviewing session.
 *
 * Ordered by item id and sliced by offset/limit, so `offset: 0, 7` and
 * `offset: 7, 7` partition the queue rather than overlapping — a reviewer
 * handed two batches must not be shown the same pair twice, since a second
 * decision on it is a duplicate the ingest will reject.
 */
export function exportAnnotationBatch(
  items: readonly AnnotationQueueItem[],
  options: ExportBatchOptions,
): AnnotationBatch {
  if (!isPlainObject(options)) fail('options must be an object');
  if (!isNonEmptyString(options.batchId)) fail('batchId must be a non-empty string');
  if (!isIsoTimestamp(options.exportedAt)) {
    fail('exportedAt must be an ISO-8601 timestamp; the exporter reads no clock of its own');
  }
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) fail('offset must be a non-negative integer');
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    fail('limit must be a positive integer');
  }

  const states = options.states ?? (['pending'] as readonly QueueItemState[]);
  const eligible = items
    .filter((item) => states.includes(item.state))
    .slice()
    .sort((a, b) => byCodeUnit(a.itemId, b.itemId));
  const window = options.limit === undefined ? eligible.slice(offset) : eligible.slice(offset, offset + options.limit);

  return Object.freeze({
    version: CALIBRATION_SCHEMA_VERSION,
    batchId: options.batchId,
    exportedAt: options.exportedAt,
    items: Object.freeze(window),
  });
}

const BATCH_KEYS: readonly string[] = Object.freeze(['version', 'batchId', 'exportedAt', 'items']);
const ITEM_KEYS: readonly string[] = Object.freeze([
  'version',
  'itemId',
  'pairId',
  'leftCommitmentId',
  'rightCommitmentId',
  'state',
  'slice',
  'enqueuedAt',
]);

export interface AnnotationBatchParseResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  /** Null unless every item validated. A partly-repaired batch is not a batch. */
  readonly batch: AnnotationBatch | null;
}

/**
 * Parses a batch that has been outside this process.
 *
 * All-or-nothing. A batch with one malformed item is returned as `null` rather
 * than as the items that happened to parse: a reviewer's file that lost a row in
 * transit should be fixed and re-imported, not silently shortened.
 */
export function parseAnnotationBatch(raw: unknown): AnnotationBatchParseResult {
  const collector = new IssueCollector();

  if (!isPlainObject(raw)) {
    collector.error('PAQ001', 'batch', 'batch must be an object');
    return { ...collector.result(), batch: null };
  }

  for (const key of Object.keys(raw)) {
    if (!BATCH_KEYS.includes(key)) collector.error('PAQ003', `batch.${key}`, `unknown batch field '${key}'`);
  }
  if (raw.version !== CALIBRATION_SCHEMA_VERSION) {
    collector.error(
      'PAQ002',
      'batch.version',
      `expected '${CALIBRATION_SCHEMA_VERSION}', found ${JSON.stringify(raw.version)}`,
    );
  }
  if (!isNonEmptyString(raw.batchId)) collector.error('PAQ004', 'batch.batchId', 'batchId must be a non-empty string');
  if (!isIsoTimestamp(raw.exportedAt)) {
    collector.error('PAQ005', 'batch.exportedAt', 'exportedAt must be an ISO-8601 timestamp');
  }
  if (!Array.isArray(raw.items)) {
    collector.error('PAQ006', 'batch.items', 'items must be an array');
    return { ...collector.result(), batch: null };
  }

  const seenItemIds = new Set<string>();
  raw.items.forEach((row, index) => {
    const path = `batch.items[${index}]`;
    if (!isPlainObject(row)) {
      collector.error('PAQ010', path, 'queue item must be an object');
      return;
    }
    for (const key of Object.keys(row)) {
      if (!ITEM_KEYS.includes(key)) collector.error('PAQ019', `${path}.${key}`, `unknown queue item field '${key}'`);
    }
    if (row.version !== CALIBRATION_SCHEMA_VERSION) {
      collector.error(
        'PAQ018',
        `${path}.version`,
        `expected '${CALIBRATION_SCHEMA_VERSION}', found ${JSON.stringify(row.version)}`,
      );
    }
    if (typeof row.itemId !== 'string' || !QUEUE_ITEM_ID_PATTERN.test(row.itemId)) {
      collector.error('PAQ011', `${path}.itemId`, `itemId must match ${String(QUEUE_ITEM_ID_PATTERN)}`);
    } else if (seenItemIds.has(row.itemId)) {
      collector.error('PAQ020', `${path}.itemId`, `duplicate queue item '${row.itemId}' in one batch`);
    } else {
      seenItemIds.add(row.itemId);
    }
    if (!isNonEmptyString(row.pairId)) collector.error('PAQ012', `${path}.pairId`, 'pairId must be a non-empty string');
    if (!isNonEmptyString(row.leftCommitmentId) || !isNonEmptyString(row.rightCommitmentId)) {
      collector.error(
        'PAQ013',
        path,
        'leftCommitmentId and rightCommitmentId must both be non-empty strings',
      );
    } else if (row.leftCommitmentId === row.rightCommitmentId) {
      collector.error('PAQ014', path, 'a queue item cannot compare a commitment with itself');
    }
    if (!QUEUE_ITEM_STATES.includes(row.state as QueueItemState)) {
      collector.error('PAQ015', `${path}.state`, `state must be one of ${QUEUE_ITEM_STATES.join(' | ')}`);
    }
    if (!isNonEmptyString(row.slice)) collector.error('PAQ016', `${path}.slice`, 'slice must be a non-empty string');
    if (!isIsoTimestamp(row.enqueuedAt)) {
      collector.error('PAQ017', `${path}.enqueuedAt`, 'enqueuedAt must be an ISO-8601 timestamp');
    }
  });

  const result = collector.result();
  return { ...result, batch: result.valid ? (raw as unknown as AnnotationBatch) : null };
}
