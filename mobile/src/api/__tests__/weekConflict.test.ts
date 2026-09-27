/**
 * A refused "Save this day" redraws the week it came back with (CL5b, I1).
 *
 * The 409 carries the week as it is now (`plan.weekChanged.json`, recorded
 * from the real route). The screen must show that week, not the stale one it
 * saved from, and must not spend another call to get it.
 */
import { describe, expect, it } from '@jest/globals';
import { QueryClient } from '@tanstack/react-query';
import { ConflictError, WeekConflictError } from '../errors';
import { adoptWeekConflict, queryKeys, weekDecisionsKey } from '../queries';
import { weekConflictSchema } from '../schemas/plan';
import fixture from '../__fixtures__/plan.weekChanged.json';

const FRESH = weekConflictSchema.parse(fixture).week;
const DECISIONS = { moves: [], drops: ['plan_fixture_week_due'] };

describe('a refused save', () => {
  it('puts the week the server answered in place of the one on screen', () => {
    const client = new QueryClient();
    const key = queryKeys.week('alice', weekDecisionsKey(DECISIONS));
    client.setQueryData(key, { ...FRESH, days: [] });
    adoptWeekConflict(client, 'alice', DECISIONS, new WeekConflictError('week_changed', FRESH));
    expect(client.getQueryData(key)).toEqual(FRESH);
    client.clear();
  });

  it('reads the week again when the conflict carries none', () => {
    const client = new QueryClient();
    const key = queryKeys.week('alice', weekDecisionsKey(DECISIONS));
    client.setQueryData(key, FRESH);
    adoptWeekConflict(client, 'alice', DECISIONS, new ConflictError('that day already has a plan'));
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    client.clear();
  });
});
