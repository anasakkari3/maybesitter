/**
 * Tests for the feedback backfill/replay reconciliation report and its CLI
 * (Sprint 03, issue #14).
 *
 * The report exists to prove one thing: the aggregates a reader sees can be
 * rebuilt from the raw event log at any time and come out identical. So the
 * tests check that it recomputes rather than caches, that it survives the log
 * arriving in a different order, and that a corrupted export is reported as a
 * failure instead of taking the whole run down.
 *
 * It is also an operator artifact written to disk, so one test pins that it
 * carries no per-event history — a reconciliation report must not become a
 * second copy of what the user did.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildFeedbackReconciliation,
  generateFeedbackReconciliationMarkdown,
  type FeedbackReplayInput,
} from '../../lib/feedback/feedbackReconciliation.ts';
import { aggregateFeedback } from '../../lib/feedback/feedbackAggregation.ts';
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type FeedbackBaseline,
  type FeedbackEvent,
} from '../../src/contracts/v1/feedbackContracts.ts';

const NOW = '2026-08-18T12:00:00.000Z';
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const repoRoot = process.cwd();

function shift(fromIso: string, ms: number): string {
  return new Date(Date.parse(fromIso) + ms).toISOString();
}

function daysBefore(days: number): string {
  return shift(NOW, -days * MS_PER_DAY);
}

function event(overrides: Partial<FeedbackEvent> & { id: string; scopeId: string }): FeedbackEvent {
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    outcome: 'accept',
    subjectId: `subject-${overrides.id}`,
    actor: 'user',
    source: 'mobile_action',
    occurredAt: daysBefore(1),
    recordedAt: daysBefore(1),
    idempotencyKey: `key-${overrides.id}`,
    ...overrides,
  };
}

function baseline(scopeId: string, completedActions: number): FeedbackBaseline {
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    scopeId,
    counters: {
      ignoredSuggestions: 0,
      completedActions,
      delayedActions: 0,
      clarificationSuccesses: 0,
      clarificationFailures: 0,
    },
    lastUpdatedAt: '2026-07-01T00:00:00.000Z',
    timestampsUnavailable: true,
    migratedAt: '2026-08-01T00:00:00.000Z',
  };
}

function replayInput(overrides: Partial<FeedbackReplayInput> = {}): FeedbackReplayInput {
  return {
    now: NOW,
    nowSource: 'flag',
    scopes: [
      {
        scopeId: 'scope-b',
        events: [
          event({ id: 'b1', scopeId: 'scope-b', outcome: 'complete', occurredAt: daysBefore(2), recordedAt: daysBefore(2) }),
          // Occurred two windows ago, recorded now: late, and outside the window.
          event({ id: 'b2', scopeId: 'scope-b', outcome: 'ignore', occurredAt: daysBefore(30), recordedAt: NOW }),
          event({ id: 'b3', scopeId: 'scope-b', outcome: 'reject', occurredAt: daysBefore(3), revokedAt: NOW }),
        ],
        baseline: baseline('scope-b', 6),
      },
      {
        scopeId: 'scope-a',
        events: [event({ id: 'a1', scopeId: 'scope-a', outcome: 'accept', occurredAt: daysBefore(1) })],
        baseline: null,
      },
    ],
    ...overrides,
  };
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--loader', './scripts/ts-resolver.mjs', 'scripts/feedback-replay.ts', ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeInputFile(input: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'maybesitter-feedback-replay-'));
  const file = path.join(dir, 'log-export.json');
  writeFileSync(file, JSON.stringify(input, null, 2));
  return file;
}

/* ── The report ─────────────────────────────────────────────────── */

test('the report recomputes each scope and matches a direct aggregation', () => {
  const input = replayInput();
  const report = buildFeedbackReconciliation(input);
  const scopeB = report.scopes.find((scope) => scope.scopeId === 'scope-b');
  const direct = aggregateFeedback({
    events: input.scopes[0].events,
    baseline: input.scopes[0].baseline,
    scopeId: 'scope-b',
    now: NOW,
  });

  assert.ok(scopeB);
  assert.equal(scopeB.inputDigest, direct.inputDigest);
  assert.deepEqual(scopeB.windowed, direct.windowed);
  assert.deepEqual(scopeB.lifetime, direct.lifetime);
  assert.equal(scopeB.revokedCount, 1);
  assert.equal(scopeB.lateEventCount, 1);
  assert.equal(scopeB.includesMigrationBaseline, true);
  assert.equal(report.status, 'RECONCILED');
});

test('the report replays each scope against a reordered copy of its own log', () => {
  // This is the reconciliation: the same events in a different order must
  // produce the same digest and the same counts, on real data rather than only
  // in a unit test fixture.
  const report = buildFeedbackReconciliation(replayInput());
  for (const scope of report.scopes) {
    assert.equal(scope.replayMatches, true, `${scope.scopeId} did not replay identically`);
  }
  assert.deepEqual(report.failures, []);
});

test('the report is byte-identical for the same input, scopes sorted by id', () => {
  const first = buildFeedbackReconciliation(replayInput());
  const second = buildFeedbackReconciliation(replayInput());

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  // Input order was scope-b then scope-a; the report is ordered, not incidental.
  assert.deepEqual(first.scopes.map((scope) => scope.scopeId), ['scope-a', 'scope-b']);
});

test('reordering the scopes or their events does not change the report', () => {
  const base = buildFeedbackReconciliation(replayInput());
  const input = replayInput();
  const reordered = buildFeedbackReconciliation({
    ...input,
    scopes: [...input.scopes].reverse().map((scope) => ({ ...scope, events: [...scope.events].reverse() })),
  });

  assert.equal(JSON.stringify(reordered), JSON.stringify(base));
});

test('the global section of the report is the counts-only cross-user view', () => {
  const report = buildFeedbackReconciliation(replayInput());

  assert.deepEqual(Object.keys(report.global), [
    'version',
    'computedAt',
    'windowDays',
    'windowStart',
    'windowed',
    'scopeCount',
  ]);
  assert.deepEqual(report.global.windowed, { accept: 1, complete: 1 });
  assert.equal(report.global.scopeCount, 2);
});

test('the report carries no per-event history', () => {
  // An operator artifact on disk must not become a second copy of what the user
  // did; it reports counts per scope, never rows.
  const serialized = JSON.stringify(buildFeedbackReconciliation(replayInput()));

  for (const identity of ['subject-a1', 'subject-b1', 'subject-b2', 'idempotencyKey', 'key-a1', '"b1"', '"a1"']) {
    assert.equal(serialized.includes(identity), false, `report leaked ${identity}`);
  }
});

test('an independent recount of the raw log is compared against the aggregate', () => {
  // The point of a reconciliation: totals are checked against a count taken
  // straight off the events, so an event lost between the log and the aggregate
  // shows up as a failure instead of as a smaller number nobody questions.
  const report = buildFeedbackReconciliation(replayInput());
  const scopeB = report.scopes.find((scope) => scope.scopeId === 'scope-b');

  assert.ok(scopeB);
  assert.equal(scopeB.eventCount, 3);
  assert.equal(scopeB.windowedTotal, 1);
  // One in-window complete, one out-of-window ignore, plus six baseline completes.
  assert.equal(scopeB.lifetimeTotal, 8);
  assert.equal(scopeB.recountMatches, true);
});

test('a corrupted export is reported as a failure instead of taking the run down', () => {
  const input = replayInput();
  const corrupted: FeedbackReplayInput = {
    ...input,
    scopes: [
      {
        scopeId: 'scope-a',
        // An event belonging to another scope: the export is wrong, and a
        // report that silently aggregated it would attribute one user's
        // behaviour to another.
        events: [event({ id: 'x1', scopeId: 'scope-z' })],
        baseline: null,
      },
    ],
  };

  const report = buildFeedbackReconciliation(corrupted);

  assert.equal(report.status, 'MISMATCH');
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0], /scope-a/);
  assert.equal(report.scopes[0].replayMatches, false);
});

test('the markdown report states that nothing was persisted as a source of truth', () => {
  const markdown = generateFeedbackReconciliationMarkdown(buildFeedbackReconciliation(replayInput()));

  assert.match(markdown, /# Feedback Replay Reconciliation/);
  assert.match(markdown, /source of truth/i);
  assert.match(markdown, /RECONCILED/);
  assert.match(markdown, /scope-a/);
  // Same input, same bytes: a report that changes without its input changing
  // cannot be used to prove anything about a replay.
  assert.equal(markdown, generateFeedbackReconciliationMarkdown(buildFeedbackReconciliation(replayInput())));
});

test('the report records where `now` came from', () => {
  // A run stamped from the system clock is not reproducible, and a reader
  // deciding whether to trust a digest comparison needs to know which it was.
  assert.equal(buildFeedbackReconciliation(replayInput()).nowSource, 'flag');
  assert.equal(
    buildFeedbackReconciliation(replayInput({ nowSource: 'system-clock' })).nowSource,
    'system-clock',
  );
});

/* ── The CLI ────────────────────────────────────────────────────── */

test('the CLI writes a markdown and JSON reconciliation report and exits zero', () => {
  const input = replayInput();
  const inputFile = writeInputFile({ now: NOW, scopes: input.scopes });
  const outDir = mkdtempSync(path.join(tmpdir(), 'maybesitter-feedback-report-'));

  const result = runCli([`--input=${inputFile}`, `--now=${NOW}`, `--out-dir=${outDir}`]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Feedback Replay Reconciliation/);
  assert.match(result.stdout, /RECONCILED/);

  const json = JSON.parse(readFileSync(path.join(outDir, 'feedback-replay-latest.json'), 'utf8'));
  assert.equal(json.status, 'RECONCILED');
  assert.equal(json.scopes.length, 2);
  assert.equal(json.nowSource, 'flag');
  assert.match(readFileSync(path.join(outDir, 'feedback-replay-latest.md'), 'utf8'), /# Feedback Replay Reconciliation/);
});

test('two CLI runs with the same --now produce byte-identical reports', () => {
  const input = replayInput();
  const inputFile = writeInputFile({ now: NOW, scopes: input.scopes });
  const outDirA = mkdtempSync(path.join(tmpdir(), 'maybesitter-feedback-report-a-'));
  const outDirB = mkdtempSync(path.join(tmpdir(), 'maybesitter-feedback-report-b-'));

  assert.equal(runCli([`--input=${inputFile}`, `--now=${NOW}`, `--out-dir=${outDirA}`]).status, 0);
  assert.equal(runCli([`--input=${inputFile}`, `--now=${NOW}`, `--out-dir=${outDirB}`]).status, 0);

  assert.equal(
    readFileSync(path.join(outDirA, 'feedback-replay-latest.json'), 'utf8'),
    readFileSync(path.join(outDirB, 'feedback-replay-latest.json'), 'utf8'),
  );
  assert.equal(
    readFileSync(path.join(outDirA, 'feedback-replay-latest.md'), 'utf8'),
    readFileSync(path.join(outDirB, 'feedback-replay-latest.md'), 'utf8'),
  );
});

test('the CLI takes `now` from the export when no flag is given, and says so', () => {
  const input = replayInput();
  const inputFile = writeInputFile({ now: NOW, windowDays: 7, scopes: input.scopes });
  const outDir = mkdtempSync(path.join(tmpdir(), 'maybesitter-feedback-report-c-'));

  assert.equal(runCli([`--input=${inputFile}`, `--out-dir=${outDir}`]).status, 0);

  const json = JSON.parse(readFileSync(path.join(outDir, 'feedback-replay-latest.json'), 'utf8'));
  assert.equal(json.generatedAt, NOW);
  assert.equal(json.nowSource, 'input-file');
  assert.equal(json.windowDays, 7);
});

test('the CLI fails loudly on a corrupted export and exits non-zero', () => {
  const inputFile = writeInputFile({
    now: NOW,
    scopes: [{ scopeId: 'scope-a', events: [event({ id: 'x1', scopeId: 'scope-z' })], baseline: null }],
  });
  const outDir = mkdtempSync(path.join(tmpdir(), 'maybesitter-feedback-report-d-'));

  const result = runCli([`--input=${inputFile}`, `--now=${NOW}`, `--out-dir=${outDir}`]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /scope-a/);
  // The report is still written: a failed reconciliation is the thing an
  // operator most needs to read.
  const json = JSON.parse(readFileSync(path.join(outDir, 'feedback-replay-latest.json'), 'utf8'));
  assert.equal(json.status, 'MISMATCH');
});

test('the CLI refuses to guess when --input is missing or unreadable', () => {
  const missing = runCli([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--input/);

  const unreadable = runCli(['--input=/nonexistent/feedback-log-export.json']);
  assert.equal(unreadable.status, 1);
});

test('the CLI writes no aggregate anywhere but the report', () => {
  // Raw history stays authoritative: the run must not leave a cached aggregate
  // that a later read could mistake for the truth.
  const input = replayInput();
  const inputFile = writeInputFile({ now: NOW, scopes: input.scopes });
  const outDir = mkdtempSync(path.join(tmpdir(), 'maybesitter-feedback-report-e-'));

  assert.equal(runCli([`--input=${inputFile}`, `--now=${NOW}`, `--out-dir=${outDir}`]).status, 0);

  const written = spawnSync('ls', [outDir], { encoding: 'utf8' }).stdout.trim().split('\n').sort();
  assert.deepEqual(written, ['feedback-replay-latest.json', 'feedback-replay-latest.md']);
  // And the export it read is untouched.
  assert.deepEqual(JSON.parse(readFileSync(inputFile, 'utf8')).scopes.length, 2);
});
