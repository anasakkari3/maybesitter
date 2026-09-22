import { describe, expect, it } from '@jest/globals';
import { applyEditLocally, moveKeepingLength } from '../optimisticEdit';
import type { DailyPlan } from '../../../api/schemas/plan';

/**
 * The forward half of the edit rollback (UC-3.10b, #195).
 *
 * `usePlanEdit` keeps the plan it was given and restores it when the server
 * refuses, so this only has to be the *plan as it would look if the move
 * landed* — and has to match `effectiveSchedule` in
 * `lib/services/dailyPlan/planActions.ts`, which removes, moves, then sorts.
 */

function plan(over: Partial<DailyPlan> = {}): DailyPlan {
  return {
    date: '2026-08-09',
    timezone: 'Asia/Jerusalem',
    status: 'proposed',
    generation: 1,
    inputDigest: 'd',
    generatedAt: '2026-08-09T05:00:00.000Z',
    acceptedAt: null,
    explanation: { text: 'x', locale: 'en', source: 'template' },
    scheduled: [
      // `blockId` since #521/#522: every row names the block it is, so the
      // plan screen can protect the row it is looking at.
      { itemId: 'a', title: 'A', startsAt: '2026-08-09T06:00:00.000Z', endsAt: '2026-08-09T06:30:00.000Z', blockId: 'block:commitment:a' },
      { itemId: 'b', title: 'B', startsAt: '2026-08-09T08:00:00.000Z', endsAt: '2026-08-09T09:00:00.000Z', blockId: 'block:commitment:b' },
    ],
    unscheduled: [],
    edited: false,
    // Nothing protected here: this file is about the optimistic edit, and a
    // protection changes no placement (#522).
    protections: [],
    ...over,
  };
}

describe('the plan as it would look', () => {
  it('moves an item and re-sorts the day around it', () => {
    const next = applyEditLocally(plan(), {
      moves: [{ itemId: 'a', startsAt: '2026-08-09T10:00:00.000Z', endsAt: '2026-08-09T10:30:00.000Z' }],
    });
    expect(next.scheduled.map(item => item.itemId)).toEqual(['b', 'a']);
    expect(next.scheduled[1]!.startsAt).toBe('2026-08-09T10:00:00.000Z');
    // The title is the commitment's, joined by the server. A move does not
    // touch it, and inventing one here would be the client holding a second
    // copy of something it does not own.
    expect(next.scheduled[1]!.title).toBe('A');
  });

  it('removes an item without touching the others', () => {
    const next = applyEditLocally(plan(), { removals: ['a'] });
    expect(next.scheduled.map(item => item.itemId)).toEqual(['b']);
    expect(next.scheduled[0]).toEqual(plan().scheduled[1]);
  });

  it('marks the plan edited, the way the server’s answer will', () => {
    // So the optimistic copy and the document that comes back are the same
    // shape and nothing on screen flickers when the real answer lands.
    expect(applyEditLocally(plan(), { removals: ['a'] }).edited).toBe(true);
  });

  it('leaves the plan it was given untouched', () => {
    // The rollback restores that object. If this mutated it there would be
    // nothing left to restore.
    const before = plan();
    const snapshot = JSON.stringify(before);
    applyEditLocally(before, { removals: ['a'], moves: [{ itemId: 'b', startsAt: '2026-08-09T11:00:00.000Z', endsAt: '2026-08-09T12:00:00.000Z' }] });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('ignores an edit that names nothing', () => {
    expect(applyEditLocally(plan(), {}).scheduled).toHaveLength(2);
  });
});

describe('a move keeps the length the planner gave it', () => {
  it('carries the original duration to the new start', () => {
    const item = { itemId: 'b', startsAt: '2026-08-09T08:00:00.000Z', endsAt: '2026-08-09T09:00:00.000Z' };
    const move = moveKeepingLength(item, new Date('2026-08-09T13:15:00.000Z'));
    expect(move).toEqual({
      itemId: 'b',
      startsAt: '2026-08-09T13:15:00.000Z',
      endsAt: '2026-08-09T14:15:00.000Z',
    });
  });

  it('keeps a zero-length placement zero-length', () => {
    // Every item this backend's adapter builds has a zero buffer, and the
    // committed fixtures have `startsAt === endsAt`. Inventing a duration for
    // one would make the client's copy disagree with the stored plan.
    const item = { itemId: 'a', startsAt: '2026-08-09T09:00:00.000Z', endsAt: '2026-08-09T09:00:00.000Z' };
    const move = moveKeepingLength(item, new Date('2026-08-09T11:00:00.000Z'));
    expect(move.endsAt).toBe(move.startsAt);
  });
});
