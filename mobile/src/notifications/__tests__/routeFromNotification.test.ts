import { describe, expect, it } from '@jest/globals';
import { commitmentIdOf, routeFromNotification } from '../routeFromNotification';

/**
 * Where a tap goes (UC-3.0b #184, UC-3.11 #196).
 *
 * A notification payload has been through Google's servers and the OS
 * notification store, and may be days old. Everything here is about refusing
 * to route on it without checking it first.
 */

describe('routing a tap', () => {
  it('opens the commitment a soft reminder is about', () => {
    expect(routeFromNotification({ commitmentId: 'c1', stage: 'soft', notificationId: 'c1:soft' }))
      .toEqual({ kind: 'commitment', commitmentId: 'c1' });
    expect(commitmentIdOf({ commitmentId: 'c1' })).toBe('c1');
  });

  it('opens the plan a plan_ready push is about', () => {
    expect(routeFromNotification({ kind: 'plan_ready', planDate: '2026-09-15' }))
      .toEqual({ kind: 'plan', planDate: '2026-09-15' });
  });

  it('refuses a planDate that is not a plain local date', () => {
    for (const planDate of [
      '2026-09-15T00:00:00Z',
      '15/09/2026',
      '2026-13-45',
      '../../etc/passwd',
      '',
    ]) {
      expect({ planDate, route: routeFromNotification({ kind: 'plan_ready', planDate }) })
        .toEqual({ planDate, route: { kind: 'today' } });
    }
  });

  it('refuses a commitment id that could not be one', () => {
    for (const commitmentId of ['../c1', 'c1/c2', '', 'x'.repeat(200), 7, null]) {
      expect({ commitmentId, route: routeFromNotification({ commitmentId }) })
        .toEqual({ commitmentId, route: { kind: 'today' } });
    }
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'plan_ready'],
    ['an empty payload', {}],
    ['a kind nobody routes', { kind: 'marketing' }],
  ])('opens Today for %s', (_name, data) => {
    expect(routeFromNotification(data)).toEqual({ kind: 'today' });
    expect(commitmentIdOf(data)).toBeNull();
  });
});
