import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreBaselineCandidate, type BaselineCandidate } from '../../lib/services/nextStepBaseline.ts';
import { selectNextStepForArm, type ArmCandidate, type ArmContext } from '../../lib/experiments/nextStepArms.ts';

/**
 * Two things the arms got wrong about the person (UC-2.9, #170).
 *
 *  1. An importance the extractor read off someone's words was discarded
 *     outright, so a commitment it was confident was urgent scored the same as
 *     one with no importance at all. It now counts at half weight.
 *
 *     Only `inferred` does. `default` is the fallback `normal` every commitment
 *     starts with — nobody said anything — and it still counts for nothing.
 *  2. "Outside your usual hours" was asserted from a constant, 22:00-07:00. For
 *     somebody who works nights it was simply false — and false in the one
 *     place the product claims to be explaining itself.
 */

const NOW = new Date('2026-09-13T09:00:00.000Z');

function candidate(over: Partial<BaselineCandidate> = {}): BaselineCandidate {
  return {
    commitmentId: 'c1',
    title: 'Send the report',
    confirmed: true,
    status: 'active',
    dueAt: '2026-09-13T15:00:00.000Z',
    remindAt: null,
    importance: 'high',
    importanceIsStated: true,
    explicitEffortMinutes: null,
    ...over,
  };
}

function bandOf(over: Partial<BaselineCandidate>): number {
  return scoreBaselineCandidate(candidate(over), NOW).importanceBand;
}

test('a guessed importance counts, where it used to count for nothing', () => {
  assert.ok(bandOf({ importance: 'high', importanceIsStated: false }) > bandOf({ importance: null }));
});

test('what the user said always outranks what was read off their words', () => {
  // The rule the whole half-weight scheme exists for.
  assert.ok(bandOf({ importance: 'high', importanceIsStated: true })
    > bandOf({ importance: 'high', importanceIsStated: false }));
  // And a guessed Must does not beat a stated Should.
  assert.ok(bandOf({ importance: 'normal', importanceIsStated: true })
    > bandOf({ importance: 'high', importanceIsStated: false }));
});

test('a guessed importance still beats a stated one a level lower', () => {
  assert.ok(bandOf({ importance: 'high', importanceIsStated: false })
    > bandOf({ importance: 'low', importanceIsStated: true }));
});

test('the evidence says which it was, rather than claiming the user marked it', () => {
  const stated = scoreBaselineCandidate(candidate({ importanceIsStated: true }), NOW);
  const guessed = scoreBaselineCandidate(candidate({ importanceIsStated: false }), NOW);
  assert.ok(stated.evidenceCodes.some((item) => item.code === 'importance'));
  assert.ok(guessed.evidenceCodes.some((item) => item.code === 'importance_estimated'));
  assert.ok(!guessed.evidenceCodes.some((item) => item.code === 'importance'));
});

// ── The hours the person actually keeps ──────────────────────────

function armCandidate(id: string, dueAt: string): ArmCandidate {
  return { ...candidate({ commitmentId: id, dueAt, importance: 'normal' }), kind: 'task' };
}

function context(over: Partial<ArmContext> = {}): ArmContext {
  return {
    // 23:00 in Jerusalem.
    now: new Date('2026-09-13T20:00:00.000Z'),
    locale: 'en',
    proposalId: 'p1',
    timezone: 'Asia/Jerusalem',
    ...over,
  };
}

function codesFor(ctx: ArmContext): string[] {
  const selection = selectNextStepForArm('contextual', [armCandidate('c1', '2026-09-14T12:00:00.000Z')], ctx);
  return (selection.adjustments[0]?.codes ?? []).map((item) => item.code);
}

test('with no routine on file, the 22:00-07:00 guess still applies', () => {
  // A guess for someone who has told us nothing is fine. Asserting it as a
  // fact about them is what was not.
  assert.ok(codesFor(context()).includes('outside_usual_hours'));
});

test('someone who works nights is not told they are outside their usual hours', () => {
  const nightWorker = context({ routine: { quietHours: { start: '06:00', end: '14:00' } } });
  assert.ok(!codesFor(nightWorker).includes('outside_usual_hours'));
});

test('their own quiet window is honoured to the minute', () => {
  // 22:30-07:30, evaluated at 23:00 local. The hour alone cannot decide a
  // window with a half past in it.
  const withRoutine = context({ routine: { quietHours: { start: '22:30', end: '07:30' } } });
  assert.ok(codesFor(withRoutine).includes('outside_usual_hours'));

  const notYet = context({
    now: new Date('2026-09-13T19:15:00.000Z'), // 22:15 local, before the window
    routine: { quietHours: { start: '22:30', end: '07:30' } },
  });
  assert.ok(!codesFor(notYet).includes('outside_usual_hours'));
});

test('a time set aside to focus is a reason, and only ever a bonus', () => {
  const focusing = context({
    now: new Date('2026-09-13T07:00:00.000Z'), // 10:00 local
    routine: { quietHours: null, focusWindows: [{ start: '09:00', end: '12:00' }] },
  });
  assert.ok(codesFor(focusing).includes('fits_focus_time'));

  // Outside every window is the normal state of most of a day, so it carries
  // no penalty and no evidence of its own.
  const notFocusing = context({
    now: new Date('2026-09-13T10:00:00.000Z'), // 13:00 local
    routine: { quietHours: null, focusWindows: [{ start: '09:00', end: '12:00' }] },
  });
  assert.ok(!codesFor(notFocusing).includes('fits_focus_time'));
  assert.ok(!codesFor(notFocusing).includes('outside_usual_hours'));
});

test('a malformed window is ignored rather than throwing on a request path', () => {
  const broken = context({ routine: { quietHours: { start: '25:00', end: 'nonsense' } } });
  assert.doesNotThrow(() => codesFor(broken));
  assert.ok(!codesFor(broken).includes('outside_usual_hours'));
});

test('the default priority is not an estimate, and still counts for nothing', () => {
  // Every commitment starts `normal` from `source: 'default'`. Treating that as
  // a guess would hand the same band to every item and put "it looks like a
  // Should" on most cards. Only `inferred` is an opinion about this one.
  const scored = scoreBaselineCandidate(candidate({ importance: null }), NOW);
  assert.ok(!scored.evidenceCodes.some((item) => item.code.startsWith('importance')));
  assert.equal(scored.importanceBand, 0);
});
