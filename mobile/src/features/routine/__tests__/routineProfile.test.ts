/**
 * The chip ⇄ window mapping (UC-2.R1 #171).
 *
 * The round trip is the property that matters: a profile saved from a chip has
 * to re-open on that same chip, or the settings screen shows somebody a
 * different answer from the one they gave. Both directions are exhaustive over
 * the enums, so this iterates every option rather than sampling.
 */
import { describe, expect, it } from '@jest/globals';
import {
  EMPTY_ANSWERS,
  ROUTINE_OPTIONS,
  ROUTINE_QUESTIONS,
  answeredCount,
  fromRoutinePayload,
  isComplete,
  toRoutinePayload,
  type RoutineAnswers,
} from '../routineProfile';

const TZ = 'Asia/Jerusalem';

const FULL: RoutineAnswers = {
  sleep: 'standard', focus: 'workday', fixed: 'morning', reminder: 'followUp', quiet: 'standard',
};

describe('the chip and the window mean the same thing', () => {
  it('round-trips every sleep option', () => {
    for (const sleep of ROUTINE_OPTIONS.sleep) {
      const payload = toRoutinePayload({ ...FULL, sleep }, TZ);
      expect(fromRoutinePayload(payload).sleep).toBe(sleep);
    }
  });

  it('round-trips every focus option, including "no regular time"', () => {
    for (const focus of ROUTINE_OPTIONS.focus) {
      const payload = toRoutinePayload({ ...FULL, focus }, TZ);
      // 'none' has no window, so it comes back as null — the screen renders
      // that as the "no regular time" chip, which is what was chosen.
      expect(fromRoutinePayload(payload).focus).toBe(focus === 'none' ? null : focus);
    }
  });

  it('round-trips every fixed-commitment option', () => {
    for (const fixed of ROUTINE_OPTIONS.fixed) {
      const payload = toRoutinePayload({ ...FULL, fixed }, TZ);
      expect(fromRoutinePayload(payload).fixed).toBe(fixed === 'none' ? null : fixed);
    }
  });

  it('round-trips every reminder option', () => {
    for (const reminder of ROUTINE_OPTIONS.reminder) {
      const payload = toRoutinePayload({ ...FULL, reminder }, TZ);
      expect(fromRoutinePayload(payload).reminder).toBe(reminder);
    }
  });

  it('round-trips every quiet-hours option', () => {
    for (const quiet of ROUTINE_OPTIONS.quiet) {
      const payload = toRoutinePayload({ ...FULL, quiet }, TZ);
      expect(fromRoutinePayload(payload).quiet).toBe(quiet === 'none' ? null : quiet);
    }
  });
});

describe('the windows are the ones already in people’s stored profiles', () => {
  it('uses the Flutter survey’s values unchanged', () => {
    // These are somebody's already-answered questions. Changing a number here
    // silently re-interprets every profile saved before the change.
    const payload = toRoutinePayload(FULL, TZ);
    expect(payload.sleepWindow).toEqual({ start: '23:30', end: '07:30' });
    expect(payload.quietHours).toEqual({ start: '22:30', end: '07:30' });
    expect(payload.focusWindows).toEqual([{ start: '09:00', end: '17:00', label: 'work_study' }]);
    expect(payload.fixedCommitmentWindows).toEqual([
      { start: '07:00', end: '09:00', label: 'fixed_commitments' },
    ]);
    expect(payload.preferredReminderIntensity).toBe('followUp');
  });
});

describe('an unanswered question', () => {
  it('sends nothing rather than a default', () => {
    // A default would be filed by the server as a fact the user stated, and
    // would then outrank a real answer given later — both are `user_stated`.
    const payload = toRoutinePayload(EMPTY_ANSWERS, TZ);
    expect(payload.sleepWindow).toBeNull();
    expect(payload.quietHours).toBeNull();
    expect(payload.focusWindows).toEqual([]);
    expect(payload.fixedCommitmentWindows).toEqual([]);
  });

  it('still sends the gentlest reminder setting, which the contract requires', () => {
    expect(toRoutinePayload(EMPTY_ANSWERS, TZ).preferredReminderIntensity).toBe('softAwareness');
  });
});

describe('skipping', () => {
  it('is carried on the payload, not inferred from empty answers', () => {
    expect(toRoutinePayload(EMPTY_ANSWERS, TZ).surveySkipped).toBe(false);
    expect(toRoutinePayload(EMPTY_ANSWERS, TZ, { skipped: true }).surveySkipped).toBe(true);
    // Someone may answer everything and still press Skip; that is still a skip.
    expect(toRoutinePayload(FULL, TZ, { skipped: true }).surveySkipped).toBe(true);
  });
});

describe('progress', () => {
  it('counts answered questions and reports completeness', () => {
    expect(answeredCount(EMPTY_ANSWERS)).toBe(0);
    expect(isComplete(EMPTY_ANSWERS)).toBe(false);
    expect(answeredCount(FULL)).toBe(ROUTINE_QUESTIONS.length);
    expect(isComplete(FULL)).toBe(true);
    expect(isComplete({ ...FULL, quiet: null })).toBe(false);
  });
});

describe('a profile from somewhere else', () => {
  it('reads as unanswered rather than throwing', () => {
    expect(fromRoutinePayload(null)).toEqual(EMPTY_ANSWERS);
    expect(fromRoutinePayload({})).toEqual(EMPTY_ANSWERS);
  });

  it('ignores a window that matches no option', () => {
    expect(fromRoutinePayload({ sleepWindow: { start: '03:15', end: '04:15' } }).sleep).toBeNull();
  });

  it('carries the timezone it was given', () => {
    expect(toRoutinePayload(FULL, 'Europe/Berlin').timezone).toBe('Europe/Berlin');
  });
});
