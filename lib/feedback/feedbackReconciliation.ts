/**
 * Backfill/replay reconciliation over the behavioural feedback log
 * (Sprint 03, issue #14).
 *
 * This report is the evidence behind "raw history remains authoritative". It
 * recomputes every scope's aggregate from the events, then checks the result
 * three ways:
 *
 *  1. **Replay.** The same log, deterministically reordered, must produce a
 *     byte-identical aggregate and the same `inputDigest`. Order is the most
 *     common source of accidental nondeterminism, and a real export is where it
 *     shows up that a fixture would not.
 *  2. **Recount.** The totals are compared against a count taken straight off
 *     the raw events by this module, not by the aggregator. The window rule and
 *     the baseline mapping are deliberately restated here rather than imported:
 *     a reconciliation is only evidence if it is derived independently of the
 *     thing it checks.
 *  3. **Containment.** A corrupt export fails the scope it belongs to and is
 *     reported, instead of throwing and taking the whole run — and the corrupt
 *     scope is left out of the cross-user totals rather than quietly changing
 *     them.
 *
 * Nothing here is a source of truth. No aggregate is persisted, cached, or fed
 * back into the log; the CLI writes this report and nothing else, so a stale
 * total cannot outlive the events that produced it.
 *
 * The report is an operator artifact that lands on disk, so it holds counts per
 * scope and never event rows: `subjectId`, event ids, and timestamps of
 * individual outcomes stay in the log where the user can see and revoke them.
 */
import { compareStrings, parseIsoMs } from '../lifeState/fields';
import {
  aggregateFeedback,
  aggregateGlobalFeedback,
  resolveFeedbackWindowDays,
} from './feedbackAggregation';
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type FeedbackBaseline,
  type FeedbackEvent,
  type GlobalFeedbackAggregates,
  type LegacyCounterName,
  type OutcomeCounts,
} from '../../src/contracts/v1/feedbackContracts';

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * Deliberately restated rather than imported from feedbackAggregation: this
 * list is half of the recount, and a recount that imports its expectation from
 * the code under test cannot disagree with it. If the baseline mapping changes,
 * this report goes red and someone has to look — which is the point.
 */
const BASELINE_COUNTERS_WITH_OUTCOMES: readonly LegacyCounterName[] = Object.freeze([
  'ignoredSuggestions',
  'completedActions',
  'delayedActions',
]);

/** One scope's raw history, as exported from the event store. */
export interface FeedbackReplayScope {
  readonly scopeId: string;
  readonly events: readonly FeedbackEvent[];
  readonly baseline: FeedbackBaseline | null;
}

/** Where the run's `now` came from, so a reader knows if it is reproducible. */
export type ReplayNowSource = 'flag' | 'input-file' | 'system-clock';

export interface FeedbackReplayInput {
  readonly scopes: readonly FeedbackReplayScope[];
  /** ISO. Explicit, exactly as in the aggregation: the report never reads the clock. */
  readonly now: string;
  readonly nowSource: ReplayNowSource;
  readonly windowDays?: number;
}

export interface ScopeReconciliation {
  readonly scopeId: string;
  readonly eventCount: number;
  /** Events that still count — the log minus the user's revocations. */
  readonly countedEventCount: number;
  readonly revokedCount: number;
  readonly lateEventCount: number;
  readonly includesMigrationBaseline: boolean;
  readonly windowed: OutcomeCounts;
  readonly lifetime: OutcomeCounts;
  readonly windowedTotal: number;
  readonly lifetimeTotal: number;
  readonly inputDigest: string;
  /** The reordered replay produced an identical aggregate. */
  readonly replayMatches: boolean;
  /** The aggregate's totals agree with a count taken off the raw events. */
  readonly recountMatches: boolean;
  readonly error: string | null;
}

export interface FeedbackReconciliationReport {
  readonly version: typeof FEEDBACK_EVENT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly nowSource: ReplayNowSource;
  readonly windowDays: number;
  readonly windowStart: string;
  readonly scopeCount: number;
  readonly totalEvents: number;
  readonly totalRevoked: number;
  readonly totalLate: number;
  readonly scopesWithBaseline: number;
  /** Counts only; carries no scope identity, by contract. */
  readonly global: GlobalFeedbackAggregates;
  readonly scopes: readonly ScopeReconciliation[];
  readonly status: 'RECONCILED' | 'MISMATCH';
  readonly failures: readonly string[];
}

/* ── Independent recount ────────────────────────────────────────── */

function isRevoked(event: FeedbackEvent): boolean {
  return typeof event.revokedAt === 'string' && event.revokedAt.length > 0;
}

function sumCounts(counts: OutcomeCounts): number {
  return Object.values(counts).reduce((total, count) => total + (count ?? 0), 0);
}

/**
 * The window rule, restated: closed at both ends, keyed off `occurredAt`, and
 * compared as instants. If the aggregator ever keys off `recordedAt` or opens
 * an edge, these two numbers stop agreeing.
 */
function recountWindowed(events: readonly FeedbackEvent[], windowStartMs: number, nowMs: number): number {
  let counted = 0;
  for (const event of events) {
    if (isRevoked(event)) continue;
    const occurredMs = parseIsoMs(event.occurredAt);
    if (occurredMs === null) continue;
    if (occurredMs >= windowStartMs && occurredMs <= nowMs) counted += 1;
  }
  return counted;
}

function recountBaseline(baseline: FeedbackBaseline | null): number {
  if (!baseline) return 0;
  let total = 0;
  for (const counter of BASELINE_COUNTERS_WITH_OUTCOMES) {
    const raw = baseline.counters?.[counter];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) continue;
    total += Math.floor(raw);
  }
  return total;
}

/**
 * A deterministic reordering — never `Math.random`, which would make the report
 * itself unreproducible. Odd positions first, reversed, then the even ones: for
 * any log of two or more events this is a different order from the input, which
 * is all the replay needs.
 */
export function reorderedForReplay<T>(items: readonly T[]): T[] {
  const odd = items.filter((_, index) => index % 2 === 1).reverse();
  const even = items.filter((_, index) => index % 2 === 0);
  return [...odd, ...even];
}

/* ── Report ─────────────────────────────────────────────────────── */

function reconcileScope(
  scope: FeedbackReplayScope,
  now: string,
  windowDays: number,
  windowStartMs: number,
  nowMs: number,
): ScopeReconciliation {
  const empty: OutcomeCounts = {};
  try {
    const aggregate = aggregateFeedback({
      events: scope.events,
      baseline: scope.baseline,
      scopeId: scope.scopeId,
      now,
      windowDays,
    });
    const replayed = aggregateFeedback({
      events: reorderedForReplay(scope.events),
      baseline: scope.baseline,
      scopeId: scope.scopeId,
      now,
      windowDays,
    });

    const windowedTotal = sumCounts(aggregate.windowed);
    const lifetimeTotal = sumCounts(aggregate.lifetime);
    const countedEventCount = scope.events.length - aggregate.revokedCount;
    const recountMatches =
      windowedTotal === recountWindowed(scope.events, windowStartMs, nowMs) &&
      lifetimeTotal === countedEventCount + recountBaseline(scope.baseline);

    return {
      scopeId: scope.scopeId,
      eventCount: scope.events.length,
      countedEventCount,
      revokedCount: aggregate.revokedCount,
      lateEventCount: aggregate.lateEventCount,
      includesMigrationBaseline: aggregate.includesMigrationBaseline,
      windowed: aggregate.windowed,
      lifetime: aggregate.lifetime,
      windowedTotal,
      lifetimeTotal,
      inputDigest: aggregate.inputDigest,
      replayMatches: JSON.stringify(replayed) === JSON.stringify(aggregate),
      recountMatches,
      error: null,
    };
  } catch (error) {
    // Contained per scope: one corrupt export must not cost an operator the
    // reconciliation of every other scope, which is when they need it most.
    return {
      scopeId: scope.scopeId,
      eventCount: scope.events.length,
      countedEventCount: 0,
      revokedCount: 0,
      lateEventCount: 0,
      includesMigrationBaseline: false,
      windowed: empty,
      lifetime: empty,
      windowedTotal: 0,
      lifetimeTotal: 0,
      inputDigest: '',
      replayMatches: false,
      recountMatches: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function requireDistinctScopes(scopes: readonly FeedbackReplayScope[]): void {
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (seen.has(scope.scopeId)) {
      throw new TypeError(
        `feedbackReconciliation: scope ${JSON.stringify(scope.scopeId)} appears twice in the export; its events would be counted twice`,
      );
    }
    seen.add(scope.scopeId);
  }
}

export function buildFeedbackReconciliation(
  input: FeedbackReplayInput,
): FeedbackReconciliationReport {
  requireDistinctScopes(input.scopes);

  const windowDays = resolveFeedbackWindowDays(input.windowDays);
  const nowMs = parseIsoMs(input.now);
  if (nowMs === null) {
    throw new TypeError(
      `feedbackReconciliation: now must be a valid ISO timestamp, received ${JSON.stringify(input.now)}`,
    );
  }
  const windowStartMs = nowMs - windowDays * MS_PER_DAY;

  // Sorted by scope id with a code-unit comparison, never localeCompare: the
  // report is diffed across runs and must not reorder itself on another host.
  const ordered = [...input.scopes].sort((left, right) => compareStrings(left.scopeId, right.scopeId));
  const scopes = ordered.map((scope) => reconcileScope(scope, input.now, windowDays, windowStartMs, nowMs));

  const failures: string[] = [];
  for (const scope of scopes) {
    if (scope.error) failures.push(`${scope.scopeId}: ${scope.error}`);
    else if (!scope.replayMatches) failures.push(`${scope.scopeId}: reordered replay produced a different aggregate`);
    else if (!scope.recountMatches) failures.push(`${scope.scopeId}: aggregate totals disagree with a recount of the raw events`);
  }

  // The cross-user view spans only the scopes that reconciled. Including a
  // scope whose export is corrupt would move the global numbers by an unknown
  // amount while the report claimed a failure elsewhere.
  const reconciledScopeIds = new Set(scopes.filter((scope) => scope.error === null).map((scope) => scope.scopeId));
  const globalEvents = ordered
    .filter((scope) => reconciledScopeIds.has(scope.scopeId))
    .flatMap((scope) => [...scope.events]);

  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    generatedAt: input.now,
    nowSource: input.nowSource,
    windowDays,
    windowStart: new Date(Math.max(-8_640_000_000_000_000, windowStartMs)).toISOString(),
    scopeCount: scopes.length,
    totalEvents: scopes.reduce((total, scope) => total + scope.eventCount, 0),
    totalRevoked: scopes.reduce((total, scope) => total + scope.revokedCount, 0),
    totalLate: scopes.reduce((total, scope) => total + scope.lateEventCount, 0),
    scopesWithBaseline: scopes.filter((scope) => scope.includesMigrationBaseline).length,
    global: aggregateGlobalFeedback({ events: globalEvents, now: input.now, windowDays }),
    scopes,
    status: failures.length === 0 ? 'RECONCILED' : 'MISMATCH',
    failures,
  };
}

/* ── Markdown ───────────────────────────────────────────────────── */

function formatCounts(counts: OutcomeCounts): string {
  const entries = Object.entries(counts).map(([outcome, count]) => `${outcome}=${count}`);
  return entries.length > 0 ? entries.join(' ') : '—';
}

/**
 * Mirrors the shape of generateMarkdownReport in lib/quality/alphaQualityHarness
 * and generateFixtureCoverageMarkdown: totals line, status, then the breakdown.
 */
export function generateFeedbackReconciliationMarkdown(report: FeedbackReconciliationReport): string {
  const lines: string[] = [
    '# Feedback Replay Reconciliation',
    '',
    '> Recomputed from the event log. **No aggregate is persisted as a source of truth** —',
    '> this report is the only output, so the totals below cannot outlive the events that',
    '> produced them.',
    '',
    `Generated: ${report.generatedAt} (now from: ${report.nowSource})`,
    `Scopes: ${report.scopeCount} | Events: ${report.totalEvents} | Revoked: ${report.totalRevoked} | Late: ${report.totalLate} | With baseline: ${report.scopesWithBaseline}`,
    `Window: ${report.windowDays}d from ${report.windowStart}`,
    `Status: **${report.status}**`,
    '',
    '## Per scope',
    '',
    'Counts only; the report holds no event rows. `late` counts events recorded in a later',
    'window than they occurred. `revoked` counts the user\'s corrections, which are excluded',
    'from every total above.',
    '',
    '| scope | events | counted | revoked | late | windowed | lifetime | baseline | digest | replay | recount |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];

  for (const scope of report.scopes) {
    lines.push(
      `| \`${scope.scopeId}\` | ${scope.eventCount} | ${scope.countedEventCount} | ${scope.revokedCount} | ${scope.lateEventCount} `
        + `| ${formatCounts(scope.windowed)} | ${formatCounts(scope.lifetime)} | ${scope.includesMigrationBaseline ? 'yes' : 'no'} `
        + `| \`${scope.inputDigest.slice(0, 12) || '—'}\` | ${scope.replayMatches ? 'ok' : '⚠️'} | ${scope.recountMatches ? 'ok' : '⚠️'} |`,
    );
  }

  lines.push(
    '',
    '## Global window',
    '',
    'Cross-user counts only: no scope, subject, or event identity, so this section cannot be',
    'used to read one user\'s history.',
    '',
    `- Window: ${report.global.windowDays}d from ${report.global.windowStart}`,
    `- Contributing scopes: ${report.global.scopeCount}`,
    `- Outcomes: ${formatCounts(report.global.windowed)}`,
  );

  if (report.failures.length > 0) {
    lines.push('', '## Failures', '');
    for (const failure of report.failures) lines.push(`- ${failure}`);
  }

  lines.push('');
  return lines.join('\n');
}

/* ── Export parsing ─────────────────────────────────────────────── */

export interface ParsedFeedbackLogExport {
  readonly scopes: readonly FeedbackReplayScope[];
  readonly now: string | null;
  readonly windowDays: number | undefined;
}

/**
 * Parses a raw log export: `{ now?, windowDays?, scopes: [{ scopeId, events,
 * baseline }] }`.
 *
 * Shape is validated here rather than trusted, because the CLI reads a file
 * written by another process: a `scopes` entry that is missing its events would
 * otherwise reconcile as an empty, healthy-looking scope.
 */
export function parseFeedbackLogExport(raw: unknown): ParsedFeedbackLogExport {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('feedbackReconciliation: export must be an object with a `scopes` array');
  }
  const source = raw as Record<string, unknown>;
  if (!Array.isArray(source.scopes)) {
    throw new TypeError('feedbackReconciliation: export must carry a `scopes` array');
  }

  const scopes = source.scopes.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`feedbackReconciliation: scopes[${index}] must be an object`);
    }
    const scope = entry as Record<string, unknown>;
    if (typeof scope.scopeId !== 'string' || scope.scopeId.trim().length === 0) {
      throw new TypeError(`feedbackReconciliation: scopes[${index}].scopeId must be a non-empty string`);
    }
    if (!Array.isArray(scope.events)) {
      throw new TypeError(`feedbackReconciliation: scopes[${index}].events must be an array`);
    }
    return {
      scopeId: scope.scopeId,
      events: scope.events as readonly FeedbackEvent[],
      baseline: (scope.baseline ?? null) as FeedbackBaseline | null,
    };
  });

  return {
    scopes,
    now: typeof source.now === 'string' ? source.now : null,
    windowDays: typeof source.windowDays === 'number' ? source.windowDays : undefined,
  };
}
