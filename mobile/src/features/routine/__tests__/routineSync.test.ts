/**
 * Which copy of the survey wins (UC-2.7a, #167 step 5).
 *
 * The property that has to hold: an answer given on a plane is never
 * overwritten by the older copy the account still has. Everything else here is
 * in service of that one case.
 */
import { describe, expect, it } from '@jest/globals';
import { answersDiffer, decideRoutineSync } from '../routineSync';
import { EMPTY_CACHE, type RoutineCache } from '../../../lib/deviceSettings/routineCache';
import { EMPTY_ANSWERS, type RoutineAnswers } from '../routineProfile';
import type { RoutineProfile } from '../../../api/schemas/profile';

const ANSWERS: RoutineAnswers = {
  sleep: 'standard', focus: 'workday', fixed: 'none', reminder: 'soft', quiet: 'standard',
};

function cache(overrides: Partial<RoutineCache> = {}): RoutineCache {
  return {
    ...EMPTY_CACHE,
    answers: ANSWERS,
    timezone: 'Asia/Jerusalem',
    updatedAt: '2026-09-13T09:00:00.000Z',
    ...overrides,
  };
}

function server(overrides: Partial<RoutineProfile> = {}): RoutineProfile {
  return {
    schemaVersion: 1,
    updatedAt: '2026-09-13T09:00:00.000Z',
    timezone: 'Asia/Jerusalem',
    sleepWindow: { start: '23:30', end: '07:30' },
    focusWindows: [{ start: '09:00', end: '17:00', label: 'work_study' }],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'softAwareness',
    quietHours: { start: '22:30', end: '07:30' },
    surveySkipped: false,
    ...overrides,
  };
}

describe('offline', () => {
  it('does nothing at all', () => {
    // There is no server copy worth trusting offline — the query hands back
    // whatever it last cached — and adopting that over a pending local answer
    // is exactly how an answer given on a plane disappears.
    expect(decideRoutineSync({ local: cache({ pendingSync: true }), server: server(), online: false }))
      .toEqual({ kind: 'idle' });
    expect(decideRoutineSync({ local: null, server: server(), online: false }))
      .toEqual({ kind: 'idle' });
  });
});

describe('when the device holds something the account has not seen', () => {
  it('pushes it, whatever the server says', () => {
    const local = cache({ pendingSync: true, updatedAt: '2026-09-13T09:00:00.000Z' });
    // The server's copy is *newer by timestamp* and still loses: `pendingSync`
    // means this device's answer never arrived, so the server is showing an
    // older answer with a later write time.
    const action = decideRoutineSync({
      local, server: server({ updatedAt: '2026-09-14T09:00:00.000Z' }), online: true,
    });
    expect(action).toEqual({ kind: 'push', cache: local });
  });

  it('pushes even when the account has no profile at all', () => {
    const local = cache({ pendingSync: true });
    expect(decideRoutineSync({ local, server: null, online: true }))
      .toEqual({ kind: 'push', cache: local });
  });
});

describe('when the account is ahead', () => {
  it('adopts the server copy', () => {
    const action = decideRoutineSync({
      local: cache({ updatedAt: '2026-09-12T09:00:00.000Z' }),
      server: server({ updatedAt: '2026-09-14T09:00:00.000Z', sleepWindow: { start: '00:30', end: '08:30' } }),
      online: true,
    });
    expect(action.kind).toBe('adopt');
    if (action.kind !== 'adopt') throw new Error('unreachable');
    expect(action.answers.sleep).toBe('late');
    expect(action.updatedAt).toBe('2026-09-14T09:00:00.000Z');
  });

  it('adopts on a second device that has never answered', () => {
    const action = decideRoutineSync({ local: null, server: server(), online: true });
    expect(action.kind).toBe('adopt');
    if (action.kind !== 'adopt') throw new Error('unreachable');
    expect(action.answers).toEqual({ ...ANSWERS, fixed: null });
  });

  it('leaves "no regular time" unselected rather than pre-selecting it', () => {
    // "No regular fixed commitments" and "did not answer this one" are the
    // same empty list on the wire, and the second device cannot tell them
    // apart. It reads as unanswered on purpose: the Flutter survey resolved
    // the ambiguity the other way and pre-selected the chip, which shows
    // somebody an answer about themselves that they never gave. Not selecting
    // it costs one tap; the alternative is a small lie on a screen whose whole
    // subject is what the user told us.
    const action = decideRoutineSync({
      local: null, server: server({ fixedCommitmentWindows: [] }), online: true,
    });
    if (action.kind !== 'adopt') throw new Error('unreachable');
    expect(action.answers.fixed).toBeNull();
  });

  it('adopts on an exact tie, because a tie is the same save seen twice', () => {
    expect(decideRoutineSync({ local: cache(), server: server(), online: true }).kind).toBe('adopt');
  });
});

describe('when there is nothing to do', () => {
  it('stays idle with no server copy and nothing pending', () => {
    expect(decideRoutineSync({ local: cache(), server: null, online: true })).toEqual({ kind: 'idle' });
  });

  it('stays idle when the local copy is simply newer', () => {
    expect(decideRoutineSync({
      local: cache({ updatedAt: '2026-09-15T09:00:00.000Z' }),
      server: server({ updatedAt: '2026-09-14T09:00:00.000Z' }),
      online: true,
    })).toEqual({ kind: 'idle' });
  });

  it('stays idle when neither side has anything', () => {
    expect(decideRoutineSync({ local: null, server: null, online: true })).toEqual({ kind: 'idle' });
  });
});

describe('answersDiffer', () => {
  it('is false for the same answers, so an echo does not rewrite the cache', () => {
    // The server echoes the profile back after every save. Without this every
    // sync would rewrite identical answers and re-render for nothing.
    expect(answersDiffer(ANSWERS, { ...ANSWERS })).toBe(false);
  });

  it('is true when any one answer moved', () => {
    expect(answersDiffer(ANSWERS, { ...ANSWERS, quiet: 'late' })).toBe(true);
    expect(answersDiffer(ANSWERS, EMPTY_ANSWERS)).toBe(true);
  });
});
