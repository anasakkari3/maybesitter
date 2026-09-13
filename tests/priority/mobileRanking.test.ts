/**
 * The order Today puts things in (UC-2.8, #169).
 *
 * ── The property this file exists for ────────────────────────────
 *
 * A guess about importance must never lift an item past something that is
 * actually due. Being wrong about importance should cost a place in a list;
 * it must not cost the thing that had a deadline. The property test at the
 * bottom asserts it over a thousand random pairs rather than over the three
 * cases somebody thought of.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankForMobile, type RankReasonCode } from '../../lib/priority/mobileRanking.ts';
import type { Commitment, Priority } from '../../src/domain/stateMachine.ts';

const NOW = '2026-09-13T09:00:00.000Z';

function priority(
  level: Priority['level'] = 'normal',
  source: Priority['source'] = 'default',
): Priority {
  return { level, source, pressureAllowed: false, pressureLevel: 'none' };
}

function commitment(overrides: {
  id: string;
  dueAt?: string | null;
  priority?: Priority;
  status?: Commitment['status'];
}): Commitment {
  const dueAt = overrides.dueAt === undefined ? null : overrides.dueAt;
  return {
    id: overrides.id,
    kind: 'task',
    title: overrides.id,
    description: null,
    person: null,
    status: overrides.status ?? 'active',
    priority: overrides.priority ?? priority(),
    timeSpec: {
      kind: dueAt === null ? 'unscheduled' : 'due_by',
      dueAt,
      remindAt: dueAt,
      timezone: 'UTC',
    },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    confirmedAt: '2026-09-01T09:00:00.000Z',
    completedAt: null,
    droppedAt: null,
  } as Commitment;
}

function order(items: Commitment[]): string[] {
  return rankForMobile(items, [], NOW).map((entry) => entry.commitmentId);
}

function codesFor(items: Commitment[], id: string): readonly RankReasonCode[] {
  return rankForMobile(items, [], NOW).find((entry) => entry.commitmentId === id)!.reasonCodes;
}

// ── The two cases the issue names ────────────────────────────────

test('an overdue normal item ranks above a Must due in five hours', () => {
  // The acceptance criterion, verbatim: a deadline that has passed outranks an
  // importance the user stated but which is not yet due.
  const rent = commitment({ id: 'rent', dueAt: '2026-09-13T08:00:00.000Z' });
  const mom = commitment({
    id: 'mom', dueAt: '2026-09-13T14:00:00.000Z', priority: priority('high', 'user_explicit'),
  });
  assert.deepEqual(order([mom, rent]), ['rent', 'mom']);
});

test('an item due within the hour ranks above a guessed-important one due tomorrow', () => {
  const soon = commitment({ id: 'soon', dueAt: '2026-09-13T09:45:00.000Z' });
  const guessed = commitment({
    id: 'guessed', dueAt: '2026-09-14T12:00:00.000Z', priority: priority('high', 'inferred'),
  });
  assert.deepEqual(order([guessed, soon]), ['soon', 'guessed']);
});

// ── What the user said beats what was guessed ────────────────────

test('a stated Must outranks a guessed Must in the same band', () => {
  const stated = commitment({
    id: 'stated', dueAt: '2026-09-14T12:00:00.000Z', priority: priority('high', 'user_explicit'),
  });
  const guessed = commitment({
    id: 'guessed', dueAt: '2026-09-14T12:00:00.000Z', priority: priority('high', 'inferred'),
  });
  assert.deepEqual(order([guessed, stated]), ['stated', 'guessed']);
});

test('a stated low is pushed down further than a guessed low', () => {
  const statedLow = commitment({
    id: 'statedLow', dueAt: '2026-09-14T12:00:00.000Z', priority: priority('low', 'user_explicit'),
  });
  const guessedLow = commitment({
    id: 'guessedLow', dueAt: '2026-09-14T12:00:00.000Z', priority: priority('low', 'inferred'),
  });
  assert.deepEqual(order([statedLow, guessedLow]), ['guessedLow', 'statedLow']);
});

// ── Undated items ────────────────────────────────────────────────

test('an item with no time appears at all, and says why it is last', () => {
  // `isVisibleInLists` used to drop these, so "Buy milk" never reached a phone.
  const milk = commitment({ id: 'milk', dueAt: null });
  const dated = commitment({ id: 'dated', dueAt: '2026-09-14T12:00:00.000Z' });
  const ranked = rankForMobile([milk, dated], [], NOW);
  assert.equal(ranked.length, 2);
  assert.deepEqual(codesFor([milk, dated], 'milk'), ['no_deadline']);
});

test('an undated item sorts after a dated one it ties with', () => {
  const milk = commitment({ id: 'aaa-milk', dueAt: null });
  const dated = commitment({ id: 'zzz-dated', dueAt: '2026-09-20T12:00:00.000Z' });
  // The id ordering would put milk first on a tie; the deadline tie-break puts
  // the dated item ahead regardless.
  const ordered = order([milk, dated]);
  assert.equal(ordered.indexOf('zzz-dated') < ordered.indexOf('aaa-milk'), true);
});

// ── Reason codes ─────────────────────────────────────────────────

test('the deadline code comes first and only the sharpest one is used', () => {
  const overdue = commitment({
    id: 'overdue', dueAt: '2026-09-13T08:00:00.000Z', priority: priority('high', 'user_explicit'),
  });
  assert.deepEqual(codesFor([overdue], 'overdue'), ['overdue', 'user_must']);

  const soon = commitment({ id: 'soon', dueAt: '2026-09-13T10:00:00.000Z' });
  assert.deepEqual(codesFor([soon], 'soon'), ['due_within_2h']);

  const today = commitment({ id: 'today', dueAt: '2026-09-13T20:00:00.000Z' });
  assert.deepEqual(codesFor([today], 'today'), ['due_today']);
});

test('never more than two codes', () => {
  const busy = commitment({
    id: 'busy', dueAt: '2026-09-13T08:00:00.000Z', priority: priority('high', 'user_explicit'),
  });
  assert.ok(codesFor([busy], 'busy').length <= 2);
});

test('a guessed importance is labelled as an estimate, not as the user’s word', () => {
  const guessed = commitment({
    id: 'guessed', dueAt: '2026-09-20T12:00:00.000Z', priority: priority('high', 'inferred'),
  });
  assert.deepEqual(codesFor([guessed], 'guessed'), ['estimated_important']);
});

// ── Determinism ──────────────────────────────────────────────────

test('the order is total: no two items ever tie', () => {
  const identical = ['c', 'a', 'b'].map((id) => commitment({ id, dueAt: '2026-09-14T12:00:00.000Z' }));
  // Same score, same deadline: the id breaks it, by code point.
  assert.deepEqual(order(identical), ['a', 'b', 'c']);
  assert.deepEqual(order([...identical].reverse()), ['a', 'b', 'c']);
});

test('the same input gives the same order whatever the host locale is', () => {
  const items = [
    commitment({ id: 'Ä', dueAt: '2026-09-14T12:00:00.000Z' }),
    commitment({ id: 'Z', dueAt: '2026-09-14T12:00:00.000Z' }),
    commitment({ id: 'a', dueAt: '2026-09-14T12:00:00.000Z' }),
  ];
  // `localeCompare` would order these differently under a Swedish locale.
  // `compareByCodePoint` cannot.
  assert.deepEqual(order(items), ['Z', 'a', 'Ä']);
});

test('a nonsense clock is refused rather than producing a confident order', () => {
  assert.throws(() => rankForMobile([commitment({ id: 'a' })], [], 'not a time'), /ISO timestamp/);
});

// ── The property ─────────────────────────────────────────────────

test('a guess never outranks a deadline, over a thousand random pairs', () => {
  // Deterministic PRNG: a failure has to be reproducible, and a seeded run is
  // the difference between a bug report and a rumour.
  let seed = 20260913;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const nowMs = Date.parse(NOW);
  const levels: Priority['level'][] = ['low', 'normal', 'high'];

  for (let run = 0; run < 1000; run += 1) {
    // One item that is genuinely due sooner, with no stated importance...
    const dueInMs = Math.floor(random() * 60 * 60 * 1000); // within the hour
    const urgent = commitment({
      id: `urgent-${run}`,
      dueAt: new Date(nowMs + dueInMs).toISOString(),
      priority: priority('normal', 'default'),
    });
    // ...and one the extractor guessed about, due at least a day later.
    const laterMs = 24 * 60 * 60 * 1000 + Math.floor(random() * 7 * 24 * 60 * 60 * 1000);
    const guessed = commitment({
      id: `guessed-${run}`,
      dueAt: new Date(nowMs + laterMs).toISOString(),
      priority: priority(levels[Math.floor(random() * levels.length)]!, 'inferred'),
    });

    const ordered = order([guessed, urgent]);
    assert.equal(
      ordered[0],
      urgent.id,
      `run ${run}: a guess overtook a deadline — ${JSON.stringify({ dueInMs, laterMs, guessed: guessed.priority })}`,
    );
  }
});

test('a user’s own low never outranks their own high, over a thousand random pairs', () => {
  let seed = 913;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const nowMs = Date.parse(NOW);

  for (let run = 0; run < 1000; run += 1) {
    // Same deadline, so importance is the only thing separating them.
    const dueAt = new Date(nowMs + Math.floor(random() * 7 * 24 * 60 * 60 * 1000)).toISOString();
    const high = commitment({ id: `zz-high-${run}`, dueAt, priority: priority('high', 'user_explicit') });
    const low = commitment({ id: `aa-low-${run}`, dueAt, priority: priority('low', 'user_explicit') });
    assert.equal(order([low, high])[0], high.id, `run ${run}: a stated low outranked a stated high`);
  }
});
