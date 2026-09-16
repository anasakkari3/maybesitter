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
      // Trailing whitespace: `Date.parse` accepts it, so only the anchored
      // regex refuses it — and a planDate with a space in it becomes a URL
      // segment downstream.
      '2026-09-15 ',
      '2026-09-15/../admin',
      // A day that does not exist. The regex is happy and `Date.parse` rolls
      // it over to 2 March rather than refusing, so this is the case only the
      // round trip catches.
      '2026-02-30',
      '2026-04-31',
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

  /*
   * A payload written in the user's own digits.
   *
   * Two guards in this repo have shipped a bug by assuming ASCII — which is
   * why this asserts what the app *does* rather than which check does it.
   * `\d` is ASCII-only in JavaScript and `Date.parse` refuses Arabic-Indic
   * digits as well, so both hold today; if one is ever relaxed the other still
   * has to keep this green.
   */
  it.each([
    ['Arabic-Indic digits', '٢٠٢٦-٠٩-١٦'],
    ['Extended Arabic-Indic digits', '۲۰۲۶-۰۹-۱۶'],
    ['an Arabic word', 'خطة'],
    ['a Hebrew word', 'תוכנית'],
    ['an Arabic date with ASCII digits and an Arabic separator', '2026ـ09ـ16'],
  ])('opens Today for a planDate written as %s', (_name, planDate) => {
    expect(routeFromNotification({ kind: 'plan_ready', planDate })).toEqual({ kind: 'today' });
  });

  it.each([
    ['an Arabic commitment id', 'موعد-الطبيب'],
    ['a Hebrew commitment id', 'פגישה-1'],
  ])('opens Today for %s rather than routing on it', (_name, commitmentId) => {
    // Ids are minted by the backend and are ASCII. A payload carrying anything
    // else did not come from here, and a tap is not the place to find out.
    expect(routeFromNotification({ commitmentId })).toEqual({ kind: 'today' });
    expect(commitmentIdOf({ commitmentId })).toBeNull();
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
