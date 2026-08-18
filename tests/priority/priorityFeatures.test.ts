/**
 * Behavioural tests for deterministic priority feature extraction (Sprint 04, #17).
 *
 * Three properties carry the weight, and each has its own group below:
 *
 *  1. **Mapping fidelity.** The four knowable features are the inputs to the
 *     four band components of the live `calculateAgendaUrgencyScore`. The
 *     `bandFromFeatures` reproduction below re-derives that scorer's number
 *     from the feature vector alone and asserts equality across a matrix of
 *     cases. If extraction ever loses information the live scorer uses, this
 *     goes red here rather than silently changing what users see once the
 *     parent session makes `agendaScoring` delegate.
 *
 *  2. **Unknown is not zero.** A feature with no usable input is unknown and
 *     carries no `value` key at all, so a consumer cannot read absence as a
 *     measured low value even by accident.
 *
 *  3. **Traceability.** Every known feature names the state it was read from.
 *     The assertion is over every feature the extractor emits, not a sampled
 *     one, because "each feature traces to source state" is the acceptance
 *     criterion and a per-case spot check would not establish it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPriorityFeatures,
  deriveRelevantTimes,
  DEFAULT_DUE_SOON_WINDOW_MS,
} from '../../lib/priority/priorityFeatures.ts';
import { calculateAgendaUrgencyScore, type AgendaScoringReason } from '../../lib/utils/agendaScoring.ts';
import {
  PRIORITY_SCHEMA_VERSION,
  type FeatureValue,
  type PriorityFeature,
  type PriorityFeatures,
} from '../../src/contracts/v1/priorityContracts.ts';
import type { Commitment, Reminder } from '../../src/domain/stateMachine.ts';
import { commitmentOf, reminderOf } from './priorityFeaturesFixtures.ts';

const NOW = '2026-08-18T12:00:00.000Z';
const WINDOW_MS = DEFAULT_DUE_SOON_WINDOW_MS;

const KNOWABLE_FEATURES = ['urgency', 'importance', 'lateness', 'userPressure'] as const;
const ALWAYS_UNKNOWN_FEATURES = ['dependency', 'effort'] as const;

function knownValue<T>(field: PriorityFeature<T>): FeatureValue<T> {
  if (!field.known) {
    throw new assert.AssertionError({ message: `expected a known feature, got ${field.reason}` });
  }
  return field.value;
}

/* ── Reproduction of the live scorer's band, from features alone ──── */

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

const REASON_BASE: Record<AgendaScoringReason, number> = {
  overdue: 7_000,
  due_soon: 5_000,
  active: 3_000,
  pending: 1_000,
};

/**
 * Mirrors `agendaScoring`'s band arithmetic but reads only the feature vector.
 * Deliberately duplicated rather than imported: importing the private helpers
 * would make this test agree with the scorer by construction instead of
 * checking that the features carry enough to reproduce it.
 */
function bandFromFeatures(features: PriorityFeatures, reason: AgendaScoringReason): number {
  let urgency = 0;
  if (features.urgency.known) {
    const value = features.urgency.value.value;
    if (reason === 'overdue') urgency = clamp(Math.round(value.hoursOverdue * 6), 0, 420);
    else if (reason === 'due_soon') urgency = clamp(Math.round(value.dueSoonCloseness * 420), 0, 420);
  }

  let importance = 0;
  if (features.importance.known) {
    const level = features.importance.value.value.level;
    importance = level === 'high' ? 180 : level === 'normal' ? 80 : 0;
  }

  let lateness = 0;
  if (features.lateness.known) {
    const value = features.lateness.value.value;
    lateness =
      clamp(value.snoozedCount * 90, 0, 270) +
      (value.postponed ? 160 : 0) +
      (value.deferred ? 80 : 0);
  }

  let pressure = 0;
  if (features.userPressure.known) {
    const value = features.userPressure.value.value;
    if (value.ignoredCount > 0) pressure = value.ignoredRecently ? 240 : 120;
  }

  return clamp(urgency + importance + lateness + pressure, 0, 999);
}

function scoreFromFeatures(features: PriorityFeatures, reason: AgendaScoringReason): number {
  return clamp(REASON_BASE[reason] + bandFromFeatures(features, reason), 0, 9_999);
}

function assertReproducesLiveScorer(
  commitment: Commitment,
  reminders: readonly Reminder[],
  relevantTimes: readonly string[],
  label: string,
): void {
  const features = extractPriorityFeatures({
    commitment,
    reminders,
    now: NOW,
    relevantTimes,
    dueSoonWindowMs: WINDOW_MS,
  });

  for (const reason of ['overdue', 'due_soon', 'active', 'pending'] as const) {
    const live = calculateAgendaUrgencyScore({
      commitment,
      reminders,
      reason,
      now: new Date(NOW),
      relevantTimes,
      dueSoonWindowMs: WINDOW_MS,
    });
    assert.equal(
      scoreFromFeatures(features, reason),
      live,
      `${label} / ${reason}: features must reproduce the live agenda score exactly`,
    );
  }
}

/* ── Shape and schema ─────────────────────────────────────────────── */

test('priorityFeatures: stamps the schema version, the commitment id and the caller-supplied now', () => {
  const features = extractPriorityFeatures({
    commitment: commitmentOf({ id: 'cmt_42' }),
    reminders: [],
    now: NOW,
  });

  assert.equal(features.version, PRIORITY_SCHEMA_VERSION);
  assert.equal(features.commitmentId, 'cmt_42');
  assert.equal(features.computedAt, NOW);
});

test('priorityFeatures: rejects an unusable now rather than substituting a clock', () => {
  assert.throws(
    () => extractPriorityFeatures({ commitment: commitmentOf(), reminders: [], now: 'sometime tuesday' }),
    TypeError,
  );
  assert.throws(
    () => extractPriorityFeatures({ commitment: commitmentOf(), reminders: [], now: '' }),
    TypeError,
  );
});

test('priorityFeatures: rejects a commitment with no usable id', () => {
  assert.throws(
    () => extractPriorityFeatures({ commitment: commitmentOf({ id: '  ' }), reminders: [], now: NOW }),
    TypeError,
  );
});

/* ── dependency and effort ────────────────────────────────────────── */

test('priorityFeatures: dependency and effort are unknown for every input shape', () => {
  const inputs = [
    { commitment: commitmentOf(), reminders: [] },
    {
      commitment: commitmentOf({
        title: 'a very long title that a proxy heuristic might be tempted to read as effort',
        description: 'blocked by the other thing',
        priority: { level: 'high' as const, source: 'user_explicit' as const, pressureAllowed: true, pressureLevel: 'firm' as const },
        timeSpec: { kind: 'due_by' as const, dueAt: '2026-08-17T12:00:00.000Z', remindAt: null, timezone: 'UTC' },
        status: 'deferred' as const,
      }),
      reminders: [reminderOf({ id: 'rem_1', status: 'snoozed' })],
    },
  ];

  for (const input of inputs) {
    const features = extractPriorityFeatures({ ...input, now: NOW });
    for (const name of ALWAYS_UNKNOWN_FEATURES) {
      const field = features[name];
      assert.equal(field.known, false, `${name} must never be known in v1`);
      if (field.known) continue;
      assert.equal(field.reason, 'NO_DATA');
      assert.equal(field.provenance.source, 'absent');
      assert.equal(field.provenance.derivedFrom, null);
    }
  }
});

/* ── Unknown is not zero ──────────────────────────────────────────── */

test('priorityFeatures: an unknown feature carries no value key at all', () => {
  const features = extractPriorityFeatures({ commitment: commitmentOf(), reminders: [], now: NOW });

  for (const name of [...KNOWABLE_FEATURES, ...ALWAYS_UNKNOWN_FEATURES]) {
    const field = features[name] as PriorityFeature<unknown>;
    if (field.known) continue;
    assert.equal(Object.prototype.hasOwnProperty.call(field, 'value'), false, `${name} must not carry a value key`);
    assert.equal(JSON.stringify(field).includes('"value"'), false, `${name} must not serialize a value key`);
  }
});

test('priorityFeatures: urgency is unknown, never zero, when the commitment carries no usable time', () => {
  const features = extractPriorityFeatures({ commitment: commitmentOf(), reminders: [], now: NOW });

  assert.equal(features.urgency.known, false);
  if (features.urgency.known) return;
  assert.equal(features.urgency.reason, 'NO_DATA');
  assert.equal(features.urgency.provenance.source, 'absent');
  assert.equal(features.urgency.provenance.computedAt, NOW);
});

test('priorityFeatures: an unknown urgency still scores as the live scorer does', () => {
  assertReproducesLiveScorer(commitmentOf(), [], [], 'no times at all');
});

test('priorityFeatures: ignores that cannot be dated are unknown rather than counted as stale', () => {
  const commitment = commitmentOf({ currentAckState: 'seen' });
  const reminders = [
    reminderOf({ id: 'rem_1', status: 'ignored', createdAt: 'whenever', updatedAt: 'whenever', deliveredAt: null }),
  ];
  const features = extractPriorityFeatures({ commitment, reminders, now: NOW });

  assert.equal(features.userPressure.known, false);
  if (features.userPressure.known) return;
  assert.equal(features.userPressure.reason, 'NO_DATA');
  // Records were read; none of them yielded an instant.
  assert.equal(features.userPressure.provenance.source, 'domain_state');
  assert.equal(features.userPressure.provenance.derivedFrom, null);
  assertReproducesLiveScorer(commitment, reminders, [], 'undatable ignore');
});

test('priorityFeatures: no ignore signal at all is a measured zero, not an unknown', () => {
  const features = extractPriorityFeatures({ commitment: commitmentOf(), reminders: [], now: NOW });
  const pressure = knownValue(features.userPressure);

  assert.deepEqual(pressure.value, { ignoredCount: 0, ignoredRecently: false });
  assert.equal(features.userPressure.known && features.userPressure.provenance.source, 'domain_state');
});

/* ── Traceability ─────────────────────────────────────────────────── */

test('priorityFeatures: every known feature carries evidence naming its source state', () => {
  const commitment = commitmentOf({
    status: 'deferred',
    currentAckState: 'postponed',
    postponedUntil: '2026-08-19T00:00:00.000Z',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'firm' },
    timeSpec: { kind: 'due_by', dueAt: '2026-08-18T06:00:00.000Z', remindAt: null, timezone: 'UTC' },
  });
  const reminders = [
    reminderOf({ id: 'rem_snooze', status: 'snoozed', updatedAt: '2026-08-17T10:00:00.000Z' }),
    reminderOf({ id: 'rem_ignore', status: 'ignored', updatedAt: '2026-08-18T09:00:00.000Z' }),
  ];
  const features = extractPriorityFeatures({ commitment, reminders, now: NOW });

  for (const name of KNOWABLE_FEATURES) {
    const field = features[name] as PriorityFeature<unknown>;
    assert.equal(field.known, true, `${name} should be known for this fully populated commitment`);
    if (!field.known) continue;
    assert.ok(field.value.evidence.length > 0, `${name} must name at least one source`);
    for (const evidence of field.value.evidence) {
      assert.equal(typeof evidence.source, 'string');
      assert.ok(evidence.source.length > 0, `${name} evidence source must be non-empty`);
      assert.ok(
        evidence.source.startsWith('commitment.') || evidence.source.startsWith('reminder:') || evidence.source.startsWith('relevantTimes['),
        `${name} evidence must name a commitment field, a reminder record or a supplied time, got ${evidence.source}`,
      );
      assert.ok(
        evidence.observedAt === null || !Number.isNaN(Date.parse(evidence.observedAt)),
        `${name} evidence observedAt must be a parseable instant or null, got ${evidence.observedAt}`,
      );
    }
  }

  assert.deepEqual(
    knownValue(features.urgency).evidence.map((item) => item.source),
    ['commitment.timeSpec.dueAt'],
  );
  assert.deepEqual(
    knownValue(features.importance).evidence.map((item) => item.source),
    ['commitment.priority.level', 'commitment.priority.source'],
  );
  assert.deepEqual(
    knownValue(features.lateness).evidence.map((item) => item.source),
    ['commitment.status', 'commitment.currentAckState', 'commitment.postponedUntil', 'reminder:rem_snooze'],
  );
  assert.deepEqual(
    knownValue(features.userPressure).evidence.map((item) => item.source),
    ['commitment.currentAckState', 'reminder:rem_ignore'],
  );
});

test('priorityFeatures: evidence names the exact reminder that supplied the time', () => {
  const commitment = commitmentOf();
  const reminders = [
    reminderOf({ id: 'rem_early', scheduledFor: '2026-08-18T04:00:00.000Z' }),
    reminderOf({ id: 'rem_late', scheduledFor: '2026-08-18T20:00:00.000Z' }),
  ];
  const features = extractPriorityFeatures({ commitment, reminders, now: NOW });
  const urgency = knownValue(features.urgency);

  assert.deepEqual(
    urgency.evidence,
    [
      { source: 'reminder:rem_early', observedAt: '2026-08-18T04:00:00.000Z' },
      { source: 'reminder:rem_late', observedAt: '2026-08-18T20:00:00.000Z' },
    ],
  );
});

test('priorityFeatures: a caller-supplied time that matches no record is still traceable', () => {
  const features = extractPriorityFeatures({
    commitment: commitmentOf(),
    reminders: [],
    now: NOW,
    relevantTimes: ['2026-08-18T10:00:00.000Z'],
  });

  assert.deepEqual(
    knownValue(features.urgency).evidence,
    [{ source: 'relevantTimes[0]', observedAt: '2026-08-18T10:00:00.000Z' }],
  );
});

/* ── Purity ───────────────────────────────────────────────────────── */

test('priorityFeatures: extraction is pure — the same input twice is deeply equal', () => {
  const commitment = commitmentOf({
    status: 'deferred',
    currentAckState: 'ignored',
    postponedUntil: '2026-08-19T00:00:00.000Z',
    timeSpec: { kind: 'due_by', dueAt: '2026-08-18T06:00:00.000Z', remindAt: '2026-08-18T13:00:00.000Z', timezone: 'UTC' },
  });
  const reminders = [
    reminderOf({ id: 'rem_b', status: 'snoozed' }),
    reminderOf({ id: 'rem_a', status: 'ignored', updatedAt: '2026-08-18T11:00:00.000Z' }),
  ];
  const input = { commitment, reminders, now: NOW } as const;

  const first = extractPriorityFeatures(input);
  const second = extractPriorityFeatures(input);

  assert.deepEqual(first, second);
  // Key order too: deepEqual ignores it, and that is where nondeterminism hides.
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('priorityFeatures: reordering the reminder list does not change the output', () => {
  const commitment = commitmentOf();
  const reminders = [
    reminderOf({ id: 'rem_a', status: 'snoozed' }),
    reminderOf({ id: 'rem_b', status: 'ignored', updatedAt: '2026-08-18T11:00:00.000Z' }),
    reminderOf({ id: 'rem_c', status: 'ignored', updatedAt: '2026-08-18T11:00:00.000Z' }),
  ];

  const forward = extractPriorityFeatures({ commitment, reminders, now: NOW });
  const reversed = extractPriorityFeatures({ commitment, reminders: [...reminders].reverse(), now: NOW });

  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});

test('priorityFeatures: extraction does not mutate its inputs', () => {
  const commitment = commitmentOf({ timeSpec: { kind: 'due_by', dueAt: '2026-08-18T06:00:00.000Z', remindAt: null, timezone: 'UTC' } });
  const reminders = [reminderOf({ id: 'rem_1', status: 'snoozed' })];
  const commitmentJson = JSON.stringify(commitment);
  const remindersJson = JSON.stringify(reminders);

  extractPriorityFeatures({ commitment, reminders, now: NOW });

  assert.equal(JSON.stringify(commitment), commitmentJson);
  assert.equal(JSON.stringify(reminders), remindersJson);
});

/* ── Feature values ───────────────────────────────────────────────── */

test('priorityFeatures: importance reports the level and whether the user set it', () => {
  const inferred = extractPriorityFeatures({
    commitment: commitmentOf({ priority: { level: 'high', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' } }),
    reminders: [],
    now: NOW,
  });
  const explicit = extractPriorityFeatures({
    commitment: commitmentOf({ priority: { level: 'low', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' } }),
    reminders: [],
    now: NOW,
  });

  assert.deepEqual(knownValue(inferred.importance).value, { level: 'high', userSet: false });
  assert.deepEqual(knownValue(explicit.importance).value, { level: 'low', userSet: true });
});

test('priorityFeatures: lateness exposes the raw snooze count, unclamped', () => {
  const reminders = Array.from({ length: 5 }, (_unused, index) =>
    reminderOf({ id: `rem_${index}`, status: 'snoozed' }));
  const features = extractPriorityFeatures({
    commitment: commitmentOf({ status: 'deferred', postponedUntil: '2026-08-19T00:00:00.000Z' }),
    reminders,
    now: NOW,
  });

  assert.deepEqual(knownValue(features.lateness).value, { snoozedCount: 5, postponed: true, deferred: true });
});

test('priorityFeatures: postponed is true from the ack state alone', () => {
  const features = extractPriorityFeatures({
    commitment: commitmentOf({ currentAckState: 'postponed', postponedUntil: null }),
    reminders: [],
    now: NOW,
  });

  assert.equal(knownValue(features.lateness).value.postponed, true);
});

test('priorityFeatures: userPressure falls back to the ack state when no reminder was ignored', () => {
  const features = extractPriorityFeatures({
    commitment: commitmentOf({ currentAckState: 'ignored', updatedAt: '2026-08-18T11:30:00.000Z' }),
    reminders: [],
    now: NOW,
  });

  assert.deepEqual(knownValue(features.userPressure).value, { ignoredCount: 1, ignoredRecently: true });
  assert.deepEqual(
    knownValue(features.userPressure).evidence.map((item) => item.source),
    ['commitment.currentAckState', 'commitment.updatedAt'],
  );
});

test('priorityFeatures: an ignore older than the recency window is known but not recent', () => {
  const features = extractPriorityFeatures({
    commitment: commitmentOf(),
    reminders: [reminderOf({ id: 'rem_1', status: 'ignored', updatedAt: '2026-08-16T11:00:00.000Z' })],
    now: NOW,
  });

  assert.deepEqual(knownValue(features.userPressure).value, { ignoredCount: 1, ignoredRecently: false });
});

test('priorityFeatures: the recency window boundary is inclusive, matching the live scorer', () => {
  const atBoundary = extractPriorityFeatures({
    commitment: commitmentOf(),
    reminders: [reminderOf({ id: 'rem_1', status: 'ignored', updatedAt: '2026-08-17T12:00:00.000Z' })],
    now: NOW,
  });
  const justOutside = extractPriorityFeatures({
    commitment: commitmentOf(),
    reminders: [reminderOf({ id: 'rem_1', status: 'ignored', updatedAt: '2026-08-17T11:59:59.999Z' })],
    now: NOW,
  });

  assert.equal(knownValue(atBoundary.userPressure).value.ignoredRecently, true);
  assert.equal(knownValue(justOutside.userPressure).value.ignoredRecently, false);
});

test('priorityFeatures: the ignore timestamp precedence follows updatedAt, deliveredAt, createdAt', () => {
  const features = extractPriorityFeatures({
    commitment: commitmentOf(),
    reminders: [
      reminderOf({
        id: 'rem_1',
        status: 'ignored',
        updatedAt: 'not a date',
        deliveredAt: '2026-08-18T11:00:00.000Z',
        createdAt: '2026-08-01T00:00:00.000Z',
      }),
    ],
    now: NOW,
  });

  assert.deepEqual(
    knownValue(features.userPressure).evidence,
    [
      { source: 'commitment.currentAckState', observedAt: '2026-08-10T00:00:00.000Z' },
      { source: 'reminder:rem_1', observedAt: '2026-08-18T11:00:00.000Z' },
    ],
  );
});

test('priorityFeatures: urgency reports hours overdue unrounded so the scorer can round once', () => {
  const features = extractPriorityFeatures({
    commitment: commitmentOf({ timeSpec: { kind: 'due_by', dueAt: '2026-08-18T10:30:00.000Z', remindAt: null, timezone: 'UTC' } }),
    reminders: [],
    now: NOW,
  });

  assert.equal(knownValue(features.urgency).value.hoursOverdue, 1.5);
  assert.equal(knownValue(features.urgency).value.dueSoonCloseness, 0);
});

test('priorityFeatures: urgency measures from the earliest overdue time, not the latest', () => {
  const features = extractPriorityFeatures({
    commitment: commitmentOf({
      timeSpec: { kind: 'due_by', dueAt: '2026-08-18T08:00:00.000Z', remindAt: '2026-08-18T11:00:00.000Z', timezone: 'UTC' },
    }),
    reminders: [],
    now: NOW,
  });

  assert.equal(knownValue(features.urgency).value.hoursOverdue, 4);
});

test('priorityFeatures: dueSoonCloseness is normalised by the caller-supplied window', () => {
  const sixHoursOut = commitmentOf({
    timeSpec: { kind: 'due_by', dueAt: '2026-08-18T18:00:00.000Z', remindAt: null, timezone: 'UTC' },
  });

  const dayWindow = extractPriorityFeatures({
    commitment: sixHoursOut, reminders: [], now: NOW, dueSoonWindowMs: 24 * 60 * 60 * 1_000,
  });
  const halfDayWindow = extractPriorityFeatures({
    commitment: sixHoursOut, reminders: [], now: NOW, dueSoonWindowMs: 12 * 60 * 60 * 1_000,
  });

  assert.equal(knownValue(dayWindow.urgency).value.dueSoonCloseness, 0.75);
  assert.equal(knownValue(halfDayWindow.urgency).value.dueSoonCloseness, 0.5);
});

test('priorityFeatures: a time beyond the due-soon window has zero closeness, not negative', () => {
  const features = extractPriorityFeatures({
    commitment: commitmentOf({
      timeSpec: { kind: 'due_by', dueAt: '2026-08-25T12:00:00.000Z', remindAt: null, timezone: 'UTC' },
    }),
    reminders: [],
    now: NOW,
  });

  assert.equal(knownValue(features.urgency).value.dueSoonCloseness, 0);
});

test('priorityFeatures: a non-positive due-soon window yields zero closeness, matching the scorer', () => {
  for (const dueSoonWindowMs of [0, -1]) {
    const features = extractPriorityFeatures({
      commitment: commitmentOf({
        timeSpec: { kind: 'due_by', dueAt: '2026-08-18T13:00:00.000Z', remindAt: null, timezone: 'UTC' },
      }),
      reminders: [],
      now: NOW,
      dueSoonWindowMs,
    });
    assert.equal(knownValue(features.urgency).value.dueSoonCloseness, 0);
  }
});

/* ── deriveRelevantTimes ──────────────────────────────────────────── */

test('deriveRelevantTimes: mirrors the agenda service — due, remind, then open reminders', () => {
  const commitment = commitmentOf({
    timeSpec: { kind: 'due_by', dueAt: '2026-08-18T06:00:00.000Z', remindAt: '2026-08-18T07:00:00.000Z', timezone: 'UTC' },
  });
  const reminders = [
    reminderOf({ id: 'rem_open', status: 'scheduled', scheduledFor: '2026-08-18T08:00:00.000Z' }),
    reminderOf({ id: 'rem_snoozed', status: 'snoozed', scheduledFor: '2026-08-18T09:00:00.000Z' }),
    reminderOf({ id: 'rem_delivered', status: 'delivered', scheduledFor: '2026-08-18T10:00:00.000Z' }),
    reminderOf({ id: 'rem_cancelled', status: 'cancelled', scheduledFor: '2026-08-18T11:00:00.000Z' }),
    reminderOf({ id: 'rem_other', status: 'scheduled', commitmentId: 'cmt_other', scheduledFor: '2026-08-18T05:00:00.000Z' }),
    reminderOf({ id: 'rem_bad', status: 'scheduled', scheduledFor: 'no' }),
  ];

  assert.deepEqual(deriveRelevantTimes(commitment, reminders), [
    '2026-08-18T06:00:00.000Z',
    '2026-08-18T07:00:00.000Z',
    '2026-08-18T08:00:00.000Z',
    '2026-08-18T09:00:00.000Z',
    '2026-08-18T10:00:00.000Z',
  ]);
});

/* ── Mapping fidelity against the live scorer ─────────────────────── */

test('priorityFeatures: reproduces the live agenda score across a matrix of commitments', () => {
  const cases: Array<{ label: string; commitment: Commitment; reminders: Reminder[]; times: string[] }> = [
    {
      label: 'plain overdue',
      commitment: commitmentOf({ timeSpec: { kind: 'due_by', dueAt: '2026-08-18T07:13:00.000Z', remindAt: null, timezone: 'UTC' } }),
      reminders: [],
      times: ['2026-08-18T07:13:00.000Z'],
    },
    {
      label: 'due soon, high importance',
      commitment: commitmentOf({
        priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'firm' },
        timeSpec: { kind: 'due_by', dueAt: '2026-08-18T17:00:00.000Z', remindAt: null, timezone: 'UTC' },
      }),
      reminders: [],
      times: ['2026-08-18T17:00:00.000Z'],
    },
    {
      label: 'low importance',
      commitment: commitmentOf({ priority: { level: 'low', source: 'default', pressureAllowed: false, pressureLevel: 'none' } }),
      reminders: [],
      times: [],
    },
    {
      label: 'band clamp binds',
      commitment: commitmentOf({
        status: 'deferred',
        currentAckState: 'postponed',
        postponedUntil: '2026-08-19T00:00:00.000Z',
        priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'firm' },
        timeSpec: { kind: 'due_by', dueAt: '2026-07-18T12:00:00.000Z', remindAt: null, timezone: 'UTC' },
      }),
      reminders: [
        reminderOf({ id: 'rem_1', status: 'snoozed' }),
        reminderOf({ id: 'rem_2', status: 'snoozed' }),
        reminderOf({ id: 'rem_3', status: 'snoozed' }),
        reminderOf({ id: 'rem_4', status: 'ignored', updatedAt: '2026-08-18T11:00:00.000Z' }),
      ],
      times: ['2026-07-18T12:00:00.000Z'],
    },
    {
      label: 'stale ignore only',
      commitment: commitmentOf({ currentAckState: 'ignored', updatedAt: '2026-07-01T00:00:00.000Z' }),
      reminders: [],
      times: [],
    },
    {
      label: 'snoozed beyond the snooze cap',
      commitment: commitmentOf(),
      reminders: Array.from({ length: 6 }, (_unused, index) => reminderOf({ id: `rem_${index}`, status: 'snoozed' })),
      times: [],
    },
    {
      label: 'due exactly now',
      commitment: commitmentOf({ timeSpec: { kind: 'due_by', dueAt: NOW, remindAt: null, timezone: 'UTC' } }),
      reminders: [],
      times: [NOW],
    },
    {
      label: 'mixed overdue and upcoming',
      commitment: commitmentOf({
        timeSpec: { kind: 'due_by', dueAt: '2026-08-18T09:20:00.000Z', remindAt: '2026-08-18T22:00:00.000Z', timezone: 'UTC' },
      }),
      reminders: [reminderOf({ id: 'rem_1', status: 'ignored', updatedAt: '2026-08-11T00:00:00.000Z' })],
      times: ['2026-08-18T09:20:00.000Z', '2026-08-18T22:00:00.000Z'],
    },
  ];

  for (const testCase of cases) {
    assertReproducesLiveScorer(testCase.commitment, testCase.reminders, testCase.times, testCase.label);
  }
});
