/**
 * **Avoidance may lower or hold pressure. It may never raise it. No pressure
 * may exceed the user's own ceiling.** (UC-3.13 (#199), resolves #107.)
 *
 * The product exists for people whose difficulty *is* avoidance. The shipped
 * rule read: when someone shows the exact difficulty this product is for,
 * escalate. `classifyUserType` turned three ignored commitments into
 * `avoidant`, `behaviorFor` turned `avoidant` into `pressureLevel: 'high'` and
 * `suggestionStyle: 'direct'`, `toneFor` turned it into `tone: 'firm'`, a
 * behaviour-derived counter pushed the conversation's `pressureCount` to 2, and
 * `ignoredCount >= 2` walked the conversational ladder to `blocker_probe` —
 * "Call Maya has come back twice. What's blocking it?" — at the default
 * ceiling, on the second ignored reminder.
 *
 * ── Why this file is shaped the way it is ────────────────────────
 *
 * A first pass at #199 satisfied every assertion here and guaranteed nothing.
 * It flattened `behaviorFor` to one constant and then clamped the constant, so
 * the clamp's false branch was unreachable, deleting the clamp left the suite
 * green, and an 847-point grid evaluated one code path 847 times. Three things
 * follow, and they are the rules this file is written to:
 *
 *   1. **Every property is asserted where it can be violated.** The grid runs
 *      at all three ceilings and both priorities, not only at the default
 *      ceiling where everything collapses to `'low'` whatever the code does.
 *   2. **The grid is proven discriminating** (`the properties above are not
 *      vacuous`, below). If a future edit folds the classifier flat again, that
 *      test fails — a property over a constant is not evidence.
 *   3. **The clamp is exercised through a real seam** with a base above the
 *      cap, which no production input can produce while the terms agree.
 *
 * The grid moves both counters, which the first pass did not: it varies
 * `adaptiveSignals` *and* builds real ignored reminders into the domain state,
 * because `candidate.ignoredCount` — the one the escalation actually read — is
 * computed from reminder state and the first pass pinned it at zero.
 *
 * ── What breaking each guard costs ───────────────────────────────
 *
 * Every guarantee here was mutation-tested: the guard was deliberately broken
 * and the **full** suite re-run. This is the matrix, recorded because the first
 * pass's guarantees were all green under exactly this procedure.
 *
 *   M1  `intensityFor` → `return base` (the clamp deleted)
 *       → the clamp holds a base that is above the cap
 *       → no input produces an intensity above the supplied ceiling
 *       → an unrecognised ceiling is the gentlest one
 *       → with default settings every input is soft and low
 *       → the properties above are not vacuous          (+5 outside this file)
 *   M2  `DEFAULT_PRESSURE_CEILING` `'soft'` → `'hard'`
 *       → an absent ceiling is the gentlest one, not an absent limit
 *       → an unrecognised ceiling is the gentlest one
 *       → with default settings every input is soft and low  (+4 outside)
 *   M3  `normalizePressureCeiling` whitelist dropped
 *       → an unrecognised ceiling is the gentlest one   (the only test of any
 *         file that fails; it is the only one that hands it a bad string)
 *   M4  `behaviorFor` `avoidant` cap `'low'` → `'high'`
 *       → increasing avoidance never raises the intensity rank
 *       → the properties above are not vacuous               (+5 outside)
 *   M5  `toneFor` hardens on `candidate.ignoredCount >= 2`
 *       → a firm tone is reachable only at the hard ceiling on a high-priority
 *         commitment
 *       → avoidance never changes what a reminder carries, at any ceiling
 *       → ignored reminders never move the strategy ladder, at any ceiling
 *       → an absent ceiling is the gentlest one, not an absent limit
 *       → with default settings every input is soft and low  (+1 outside)
 *   M6  `situationAnalysis` reads `ignoredCount >= 2` again
 *       → ignored reminders never move the strategy ladder, at any ceiling
 *   M7  the `pressure_due` event carries the count again, and
 *       `responsePlanning` and `intentSelection` read it
 *       → ignored reminders never move the strategy ladder, at any ceiling
 *       → the removed escalators stay removed
 *   M8  `behaviorFor` flattened to one cap on all three branches — the first
 *       pass's own defect, replayed
 *       → the properties above are not vacuous
 *       → an unrecognised ceiling is the gentlest one        (+5 outside)
 *
 * No guard in this file survives its own mutation, and M3 and M6 are each
 * caught by exactly one test, which is why neither may be deleted as redundant.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { AdaptiveBehavior } from '../../lib/services/adaptiveService.ts';
import type { AgendaItem } from '../../lib/services/agendaService.ts';
import { MemoryBehaviorFeedbackStore } from '../../lib/services/behaviorFeedbackService.ts';
import {
  clearPressureHistory,
  getPressureCandidateForAgenda,
  intensityFor,
  MemoryPressureDeliveryStore,
  normalizePressureCeiling,
  recordPressureDelivery,
  type PressureCandidateMessage,
  type PressureCeiling,
  type PressureIntensity,
} from '../../lib/services/pressureService.ts';
import { getConversationStateStore } from '../../lib/services/responseEngine/conversationStateStore.ts';
import { applyCommand, createEmptyDomainState, type DomainState } from '../../src/domain/stateMachine.ts';

const now = new Date('2026-04-08T08:00:00.000Z');

const INTENSITY_RANK: Record<PressureIntensity, number> = { low: 0, medium: 1, high: 2 };
const CEILINGS: readonly PressureCeiling[] = ['soft', 'followUp', 'hard'];
const PRIORITIES = ['normal', 'high'] as const;
/** Spelled out here rather than imported, so an inverted table is a failure. */
const CEILING_INTENSITY: Record<PressureCeiling, PressureIntensity> = {
  soft: 'low',
  followUp: 'medium',
  hard: 'high',
};

/** A count of misses, said back to the person, in any of its spellings. */
const COUNTS_THE_MISSES_BACK = /come back|twice|three times|\d+ times|ignored|missed \d/i;

function behavior(maxPressureLevel: PressureIntensity): AdaptiveBehavior {
  return { userType: 'disciplined', maxPressureLevel, suggestionStyle: 'minimal' };
}

function commitmentState(
  id: string,
  title: string,
  level: 'normal' | 'high' = 'normal',
  ignoredReminders = 0
): DomainState {
  const created = applyCommand(createEmptyDomainState(), {
    type: 'CreateDraft',
    now: '2026-04-08T06:00:00.000Z',
    commitment: {
      id,
      kind: 'task',
      title,
      priority: { level },
      timeSpec: { kind: 'due_by', dueAt: '2026-04-08T06:00:00.000Z', remindAt: null, timezone: 'UTC' },
    },
    draftStatus: 'pending_confirmation',
  }).newState;

  const state = applyCommand(created, {
    type: 'ConfirmCommitment',
    commitmentId: id,
    now: '2026-04-08T06:01:00.000Z',
    reminders: [],
  }).newState;

  // Every reminder carries the same instant, so `oldestOverdueMs` — and the
  // "has been waiting about two hours" the message is built from — does not
  // move with the count. Anything that does move moved because of the ignores.
  for (let index = 0; index < ignoredReminders; index += 1) {
    state.reminders[`ignored-${index}`] = {
      id: `ignored-${index}`,
      commitmentId: id,
      reminderType: 'check_in',
      scheduledFor: '2026-04-08T06:30:00.000Z',
      status: 'ignored',
      requiresAction: true,
      deliveredAt: '2026-04-08T06:30:00.000Z',
      acknowledgedAt: null,
      snoozedUntil: null,
      createdAt: '2026-04-08T06:00:00.000Z',
      updatedAt: '2026-04-08T06:45:00.000Z',
    };
  }
  if (ignoredReminders > 0) {
    state.commitments[id] = {
      ...state.commitments[id],
      currentAckState: 'ignored',
      updatedAt: '2026-04-08T07:15:00.000Z',
    };
  }

  return state;
}

function item(id: string, title: string): AgendaItem {
  return { id, title, reason: 'overdue', urgencyScore: 7_000, suggestedAction: 'do' };
}

type GridPoint = {
  ignoredCommitmentsCount: number;
  completionRate: number;
  delayFrequency: number;
};

/** Rounded because 0.1 steps accumulate float error and the label is read in failures. */
function steps(count: number): number[] {
  return Array.from({ length: count + 1 }, (_, index) => Math.round((index / count) * 100) / 100);
}

const IGNORED_STEPS = [0, 1, 2, 3, 4, 5, 6];
const RATE_STEPS = steps(10);

function grid(): GridPoint[] {
  const points: GridPoint[] = [];
  for (const ignoredCommitmentsCount of IGNORED_STEPS) {
    for (const completionRate of RATE_STEPS) {
      for (const delayFrequency of RATE_STEPS) {
        points.push({ ignoredCommitmentsCount, completionRate, delayFrequency });
      }
    }
  }
  return points;
}

const GRID = grid();

function label(point: GridPoint): string {
  return `ignored=${point.ignoredCommitmentsCount} completion=${point.completionRate} delay=${point.delayFrequency}`;
}

/**
 * How much avoidance a grid point describes. Higher is more avoidant: more
 * ignores, more delay, less completion — the three inputs `classifyUserType`
 * reads. Monotonicity is asserted against this order.
 */
function avoidanceOrder(point: GridPoint): { ignored: number; delay: number; incompletion: number } {
  return {
    ignored: point.ignoredCommitmentsCount,
    delay: point.delayFrequency,
    incompletion: 1 - point.completionRate,
  };
}

function isMoreAvoidant(a: GridPoint, b: GridPoint): boolean {
  const left = avoidanceOrder(a);
  const right = avoidanceOrder(b);
  return (
    left.ignored >= right.ignored &&
    left.delay >= right.delay &&
    left.incompletion >= right.incompletion &&
    (left.ignored > right.ignored || left.delay > right.delay || left.incompletion > right.incompletion)
  );
}

type Run = { ceiling?: unknown; level?: 'normal' | 'high'; ignoredReminders?: number; scopeId?: string };

async function pressureAt(point: GridPoint, options: Run = {}): Promise<PressureCandidateMessage> {
  const deliveryStore = new MemoryPressureDeliveryStore();
  await clearPressureHistory(deliveryStore);
  const state = commitmentState(
    'grid',
    'Call Maya',
    options.level || 'normal',
    // The grid drives the *real* counter as well as the reported signals: the
    // escalation read `candidate.ignoredCount`, which comes from reminder
    // state, and a grid that pins it at zero cannot see the defect at all.
    options.ignoredReminders ?? Math.min(point.ignoredCommitmentsCount, 4)
  );

  const result = await getPressureCandidateForAgenda([item('grid', 'Call Maya')], {
    now,
    deliveryStore,
    pressureScopeId: options.scopeId,
    ceiling: options.ceiling as PressureCeiling | undefined,
    adaptiveSignals: {
      ignoredCommitmentsCount: point.ignoredCommitmentsCount,
      completionRate: point.completionRate,
      delayFrequency: point.delayFrequency,
      clarificationFrequency: 0,
    },
  }, state);

  assert.ok(result, `the grid point produced no pressure candidate at all: ${label(point)}`);
  return result;
}

const STEADY: GridPoint = { ignoredCommitmentsCount: 0, completionRate: 1, delayFrequency: 0 };
const MOST_AVOIDANT: GridPoint = { ignoredCommitmentsCount: 6, completionRate: 0, delayFrequency: 1 };

/* ── 1. The clamp, through a seam that can put a base above the cap ─
 *
 * M1 in the matrix above. Deleting the clamp fails these two first, and eight
 * more across the suite.
 */

test('safety: the clamp holds a base that is above the cap', () => {
  // The four pairs #199 names, with the classification's own cap left wide
  // open so the ceiling is the only thing doing the work.
  assert.equal(intensityFor('high', behavior('high'), 'soft'), 'low');
  assert.equal(intensityFor('high', behavior('high'), 'followUp'), 'medium');
  assert.equal(intensityFor('medium', behavior('high'), 'soft'), 'low');
  assert.equal(intensityFor('low', behavior('high'), 'hard'), 'low');

  // A base under the cap is passed through rather than raised to it: the
  // ceiling is a limit, not a target.
  assert.equal(intensityFor('medium', behavior('high'), 'hard'), 'medium');
  assert.equal(intensityFor('high', behavior('high'), 'hard'), 'high');

  // And the classification's cap binds on its own, with the ceiling wide open
  // — which is "avoidance may lower pressure" as an executable statement.
  assert.equal(intensityFor('high', behavior('low'), 'hard'), 'low');
  assert.equal(intensityFor('high', behavior('medium'), 'hard'), 'medium');
});

test('safety: no input produces an intensity above the supplied ceiling', async () => {
  for (const ceiling of CEILINGS) {
    const cap = INTENSITY_RANK[CEILING_INTENSITY[ceiling]];
    for (const level of PRIORITIES) {
      for (const point of GRID) {
        const result = await pressureAt(point, { ceiling, level });
        assert.ok(
          INTENSITY_RANK[result.intensity] <= cap,
          `ceiling '${ceiling}' was exceeded with intensity '${result.intensity}' at ${label(point)}, priority ${level}`
        );
      }
    }
  }
});

/* ── 2. The default, tested where the default is visible ───────────
 *
 * M2 in the matrix above.
 *
 * The version of this test that shipped compared an absent ceiling against
 * `'soft'` on a `priority.level: 'normal'` commitment — the one configuration
 * where soft and hard produce identical output — so it could not see an
 * inverted default, and it was the single test of eight that passed on the
 * defective code. The fixture now proves it is discriminating before it uses
 * it.
 */

test('safety: an absent ceiling is the gentlest one, not an absent limit', async () => {
  for (const point of [STEADY, MOST_AVOIDANT]) {
    // First: this configuration can tell the two ceilings apart. Without this,
    // the assertions below pass on any default at all.
    const hard = await pressureAt(point, { ceiling: 'hard', level: 'high' });
    const soft = await pressureAt(point, { ceiling: 'soft', level: 'high' });
    assert.notDeepEqual(
      { tone: hard.tone, intensity: hard.intensity },
      { tone: soft.tone, intensity: soft.intensity },
      `this fixture cannot distinguish soft from hard, so it cannot test the default: ${label(point)}`
    );

    const absent = await pressureAt(point, { level: 'high' });
    assert.equal(absent.intensity, soft.intensity, label(point));
    assert.equal(absent.tone, soft.tone, label(point));
    assert.notEqual(absent.tone, 'firm', label(point));
  }
});

/* ── 3. A ceiling that arrives from storage rather than from a type ─
 *
 * M3 in the matrix above, and the only test in the repository that fails for
 * it.
 *
 * #196/#197 will read this out of `users/{uid}.reminderSettings
 * .escalationCeiling`. A stale string from an older build, a hand edit or a
 * half-finished migration is ordinary there, and `PressureCeiling` is erased
 * at runtime, so the type protects nothing.
 */

test('safety: an unrecognised ceiling is the gentlest one', async () => {
  const soft = await pressureAt(STEADY, { ceiling: 'soft', level: 'high' });
  const hard = await pressureAt(STEADY, { ceiling: 'hard', level: 'high' });
  assert.notEqual(soft.intensity, hard.intensity, 'the fixture cannot tell the ceilings apart');

  const outOfBand: unknown[] = ['HARD', 'Hard', 'unlimited', 'none', '', 'medium', null, undefined, 0, 3, {}, [], true];
  for (const value of outOfBand) {
    assert.equal(normalizePressureCeiling(value), 'soft', `normalized ${JSON.stringify(value) ?? 'undefined'}`);

    const result = await pressureAt(STEADY, { ceiling: value, level: 'high' });
    assert.equal(
      result.intensity,
      soft.intensity,
      `ceiling ${JSON.stringify(value) ?? 'undefined'} was not treated as the gentlest one`
    );
    assert.equal(result.tone, soft.tone, `ceiling ${JSON.stringify(value) ?? 'undefined'} changed the tone`);
  }
});

/* ── 4. Avoidance cannot move anything upward ──────────────────────
 *
 * M4, M5 and M8 in the matrix above. Note which test catches which: raising
 * the avoidant cap is caught by the monotonicity property (the rise happens
 * between `inconsistent` and `avoidant`, so comparing only the extremes would
 * miss it), hardening the tone on ignores is caught by the whole-message
 * comparison, and flattening the classifier is caught by the vacuity check.
 */

test('safety: increasing avoidance never raises the intensity rank', async () => {
  for (const ceiling of CEILINGS) {
    const results = new Map<string, PressureCandidateMessage>();
    for (const point of GRID) results.set(label(point), await pressureAt(point, { ceiling, level: 'high' }));

    // Every comparable pair, not a sampled diagonal: the defect could hide in
    // any one of the three inputs and the classifier ORs them together.
    for (const higher of GRID) {
      for (const lower of GRID) {
        if (!isMoreAvoidant(higher, lower)) continue;
        const more = results.get(label(higher))!;
        const less = results.get(label(lower))!;
        assert.ok(
          INTENSITY_RANK[more.intensity] <= INTENSITY_RANK[less.intensity],
          `at ceiling '${ceiling}', more avoidance raised intensity from '${less.intensity}' to ` +
          `'${more.intensity}': ${label(lower)} → ${label(higher)}`
        );
      }
    }
  }
});

test('safety: the properties above are not vacuous', async () => {
  // A property over a constant proves nothing, and that is exactly how the
  // first pass at #199 passed: the classifier was folded to one value, so all
  // 847 grid points evaluated identical code. This asserts the grid is
  // discriminating — that the classification is a live input to the pressure
  // path — so flattening it again fails here rather than passing everywhere.
  const intensities = new Set<PressureIntensity>();
  for (const point of GRID) intensities.add((await pressureAt(point, { ceiling: 'hard', level: 'high' })).intensity);
  assert.deepEqual(
    Array.from(intensities).sort(),
    ['high', 'low', 'medium'],
    'the grid produces one intensity at the widest ceiling, so every property in this file is vacuous'
  );

  // And the direction is the one the decision requires: the most avoidant
  // reading is the quietest, not the loudest.
  const avoidant = await pressureAt(MOST_AVOIDANT, { ceiling: 'hard', level: 'high' });
  const steady = await pressureAt(STEADY, { ceiling: 'hard', level: 'high' });
  assert.equal(avoidant.intensity, 'low');
  assert.equal(steady.intensity, 'high');
});

test('safety: avoidance never changes what a reminder carries, at any ceiling', async () => {
  for (const ceiling of CEILINGS) {
    for (const level of PRIORITIES) {
      const avoidant = await pressureAt(MOST_AVOIDANT, { ceiling, level });
      const steady = await pressureAt(STEADY, { ceiling, level });
      assert.equal(
        avoidant.tone,
        steady.tone,
        `avoidance changed the tone at ceiling '${ceiling}', priority '${level}'`
      );
      assert.ok(
        INTENSITY_RANK[avoidant.intensity] <= INTENSITY_RANK[steady.intensity],
        `avoidance raised the intensity at ceiling '${ceiling}', priority '${level}': ` +
        `'${steady.intensity}' → '${avoidant.intensity}'`
      );
    }
  }
});

test('safety: with default settings every input is soft and low', async () => {
  for (const point of GRID) {
    const result = await pressureAt(point);
    assert.equal(result.tone, 'soft', `tone hardened at ${label(point)}`);
    assert.equal(result.intensity, 'low', `intensity rose at ${label(point)}`);
  }
});

/* ── 5. Tone comes from the user's ceiling, never from the label ─── */

test('safety: a firm tone is reachable only at the hard ceiling on a high-priority commitment', async () => {
  const point = { ignoredCommitmentsCount: 2, completionRate: 0.5, delayFrequency: 0.5 };
  const reachable: string[] = [];
  for (const ceiling of CEILINGS) {
    for (const level of PRIORITIES) {
      const result = await pressureAt(point, { ceiling, level });
      if (result.tone === 'firm') reachable.push(`${ceiling}/${level}`);
    }
  }
  assert.deepEqual(reachable, ['hard/high']);
});

/* ── 6. The same holds through the feedback store ────────────────── */

test('safety: behavioural feedback events cannot raise pressure either', async () => {
  const baseline = await pressureAt(STEADY, { ceiling: 'hard', level: 'high', ignoredReminders: 0 });

  const feedbackStore = new MemoryBehaviorFeedbackStore();
  const deliveryStore = new MemoryPressureDeliveryStore();
  await clearPressureHistory(deliveryStore);
  for (let index = 0; index < 8; index += 1) {
    await feedbackStore.record(
      'avoidance-feedback',
      'suggestion_ignored',
      new Date(now.getTime() - (index + 1) * 60_000).toISOString()
    );
    await feedbackStore.record(
      'avoidance-feedback',
      'action_delayed',
      new Date(now.getTime() - (index + 1) * 60_000).toISOString()
    );
  }

  const result = await getPressureCandidateForAgenda([item('grid', 'Call Maya')], {
    now,
    deliveryStore,
    ceiling: 'hard',
    behaviorFeedbackStore: feedbackStore,
    pressureScopeId: 'avoidance-feedback',
  }, commitmentState('grid', 'Call Maya', 'high'));

  assert.ok(result);
  assert.equal(result.tone, baseline.tone);
  assert.ok(
    INTENSITY_RANK[result.intensity] <= INTENSITY_RANK[baseline.intensity],
    `eight ignored feedback events raised the intensity from '${baseline.intensity}' to '${result.intensity}'`
  );
});

/* ── 7. The strategy ladder — the decision, and what is deferred ──
 *
 * The escalation route that survived #199's first pass, and the one the harm
 * is actually made of: `candidate.ignoredCount` → `situationAnalysis`
 * (`>= 2` → `avoiding`) → `intentSelection` → `blocker_probe`, `tone:
 * 'direct'`, `requireQuestion: true`. Traced live at the default ceiling
 * before this change:
 *
 *     ignored=0  easy_choice    "keep it for today or move it?"
 *     ignored=2  blocker_probe  "Call Maya has come back twice. What's blocking it?"
 *
 * This is gated at every ceiling, not only the default. A raised ceiling says
 * the person accepted louder reminders; it is not a statement that missing one
 * should be answered with a harder question, and #378 records that neither
 * ordering rests on evidence. The issue's sentence has no ceiling clause in it.
 *
 * **The decision, recorded rather than left implicit: the ladder is gated, not
 * carved out.** Both routes from a count of ignores to a harder move are
 * closed outright — the `situationAnalysis` condition and the count the event
 * carried — at every ceiling, for every priority. What is *not* settled, and
 * is deferred to #378 rather than decided here, is whether `blocker_probe` is
 * in fact "further up the ladder" than `easy_choice` at all: that ordering is
 * `intentSelection`'s own and nobody has measured how the target cohort
 * receives either. This file defers to that ordering rather than substituting
 * a fresh guess, and gates movement along it. A reader of #378 must not
 * conclude the ordering question closed with #199.
 *
 * M6 and M7 in the matrix above.
 */

test('safety: ignored reminders never move the strategy ladder, at any ceiling', async () => {
  for (const ceiling of CEILINGS) {
    for (const level of PRIORITIES) {
      const seen = new Map<number, PressureCandidateMessage>();
      for (const ignoredReminders of [0, 1, 2, 3, 4, 5, 6]) {
        seen.set(ignoredReminders, await pressureAt(STEADY, { ceiling, level, ignoredReminders }));
      }

      const first = seen.get(0)!;
      for (const [ignoredReminders, result] of Array.from(seen.entries())) {
        assert.equal(
          result.strategy,
          first.strategy,
          `${ignoredReminders} ignored reminders moved the strategy to '${result.strategy}' ` +
          `at ceiling '${ceiling}', priority '${level}'`
        );
        assert.notEqual(result.strategy, 'blocker_probe');
        assert.equal(
          result.tone,
          first.tone,
          `${ignoredReminders} ignored reminders changed the tone to '${result.tone}' ` +
          `at ceiling '${ceiling}', priority '${level}'`
        );
        // Not equality: the classification's cap may still *lower* the
        // intensity as the ignores mount, which is the half of the decision
        // that is allowed. Only a rise is a violation.
        assert.ok(
          INTENSITY_RANK[result.intensity] <= INTENSITY_RANK[first.intensity],
          `${ignoredReminders} ignored reminders raised the intensity from '${first.intensity}' ` +
          `to '${result.intensity}' at ceiling '${ceiling}', priority '${level}'`
        );
        assert.doesNotMatch(
          result.message,
          COUNTS_THE_MISSES_BACK,
          `${ignoredReminders} ignored reminders were counted back at the user: "${result.message}"`
        );
      }
    }
  }
});

test('safety: the ladder still advances on pressure the product delivered', async () => {
  // The other half of the same rule, without which the test above could be
  // satisfied by a ladder that never moves at all. `pressureCount` counts what
  // this product did, and that may still move it.
  const scopeId = 'ladder-advances-on-delivery';
  getConversationStateStore().clear(scopeId);
  const deliveryStore = new MemoryPressureDeliveryStore();
  await clearPressureHistory(deliveryStore);
  const state = commitmentState('grid', 'Call Maya');
  const agenda = [item('grid', 'Call Maya')];

  const strategies: string[] = [];
  for (let turn = 0; turn < 3; turn += 1) {
    const result = await getPressureCandidateForAgenda(agenda, {
      now, cooldownMs: 0, deliveryStore, pressureScopeId: scopeId,
    }, state);
    assert.ok(result);
    strategies.push(result.strategy);
    await recordPressureDelivery('grid', {
      now,
      cooldownMs: 0,
      deliveryStore,
      pressureScopeId: scopeId,
      surfacedMessage: result.message,
      surfacedStrategy: result.strategy,
      surfacedPath: result.path,
    }, state);
  }

  assert.ok(
    new Set(strategies).size > 1,
    `the ladder never moved on delivered pressure either, so it is simply dead: ${strategies.join(' → ')}`
  );
  getConversationStateStore().clear(scopeId);
});

/* ── 8. The removed escalators stay removed ──────────────────────── */

test('safety: the removed escalators stay removed', () => {
  // Assembled, and this file excluded from the search, so the prose above can
  // still name the things it removed without the check matching itself.
  const identifiers = [
    // The behaviour-derived pressure counter folded into `pressureCount`.
    ['behavior', 'Pressure', 'Count'].join(''),
    // The count of ignored reminders carried on the pressure event, which the
    // realizer said back to the user and the ladder read as a reason to
    // escalate.
    ['ignored', 'Text'].join(''),
  ];
  const root = fileURLToPath(new URL('../../', import.meta.url));

  for (const identifier of identifiers) {
    let matches: string[] = [];
    try {
      matches = execFileSync(
        'git',
        [
          'grep', '-n', '--fixed-strings', '-e', identifier,
          '--', 'lib', 'src', 'tests', 'mobile', ':!tests/safety/avoidanceNeverEscalates.test.ts',
        ],
        { cwd: root, encoding: 'utf8' }
      ).split('\n').filter(Boolean);
    } catch (error) {
      // `git grep` exits 1 when nothing matched, which is the passing case.
      const status = (error as { status?: number }).status;
      if (status !== 1) throw error;
    }

    assert.deepEqual(matches, [], `${identifier} is back:\n${matches.join('\n')}`);
  }
});
