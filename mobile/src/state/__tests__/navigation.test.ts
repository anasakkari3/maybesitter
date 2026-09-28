/**
 * The navigation history (Round 2, Phase B).
 *
 * Round 1 remembered one `prev`. The path that broke it, and that this file
 * drives end to end, is Today → Plan → Details → back → back: the second
 * back has to arrive on Today, not on Details.
 */
import { describe, expect, it } from '@jest/globals';
import { arrive, back, canGoBack, closeTask, derive, go, initialNav, openTask, push, switchTab, type Nav } from '../navigation';

const screenOf = (n: Nav) => derive(n).screen;
const trail = (n: Nav, steps: ((n: Nav) => Nav)[]) => steps.reduce((acc, step) => step(acc), n);

describe('the path that a single prev could not walk', () => {
  it('Today → Plan → Details → back → Plan → back → Today', () => {
    let n = initialNav;
    n = push(n, { name: 'plan', planDate: '2026-09-22' });
    n = push(n, { name: 'details', detailId: 'c1' });
    expect(derive(n)).toMatchObject({ screen: 'details', detailId: 'c1', showTabs: false });
    n = back(n);
    expect(derive(n)).toMatchObject({ screen: 'plan', planDate: '2026-09-22', detailId: null });
    n = back(n);
    expect(derive(n)).toMatchObject({ screen: 'today', showTabs: true });
    expect(canGoBack(n)).toBe(false);
  });

  it('a details screen keeps its own id even under another details screen', () => {
    const n = trail(initialNav, [
      (x) => push(x, { name: 'details', detailId: 'a' }),
      (x) => push(x, { name: 'details', detailId: 'b' }),
    ]);
    expect(derive(n).detailId).toBe('b');
    expect(derive(back(n)).detailId).toBe('a');
  });

  it('a double tap on the same row is one push, not two', () => {
    const n = trail(initialNav, [
      (x) => push(x, { name: 'details', detailId: 'a' }),
      (x) => push(x, { name: 'details', detailId: 'a' }),
    ]);
    expect(n.stacks.today).toHaveLength(1);
  });
});

describe('no dead ends', () => {
  it('back at a tab root is a no-op that reports it has nowhere to go', () => {
    expect(back(initialNav)).toBe(initialNav);
    expect(canGoBack(initialNav)).toBe(false);
  });

  it('every settings leaf goes back to the settings root, not to a hard-coded name', () => {
    for (const leaf of ['trust', 'activity', 'about', 'calendarSettings', 'widgetSettings'] as const) {
      const n = go(go(initialNav, 'settings'), leaf);
      expect(screenOf(n)).toBe(leaf);
      expect(screenOf(back(n))).toBe('settings');
    }
  });

  it('Settings → Trust → Knows → Memory → back → back → back → Settings, with no duplicate Trust', () => {
    let n = trail(initialNav, [(x) => go(x, 'settings'), (x) => go(x, 'trust'), (x) => go(x, 'knows'), (x) => go(x, 'memory')]);
    expect(n.stacks.settings.map((e) => e.name)).toEqual(['trust', 'knows', 'memory']);
    n = back(n); expect(screenOf(n)).toBe('knows');
    n = back(n); expect(screenOf(n)).toBe('trust');
    n = back(n); expect(screenOf(n)).toBe('settings');
    expect(derive(n).showTabs).toBe(true);
  });
});

describe('tabs', () => {
  it('switching tabs keeps each tab where it was left', () => {
    let n = push(initialNav, { name: 'details', detailId: 'a' });
    n = switchTab(n, 'settings');
    n = go(n, 'trust');
    n = switchTab(n, 'today');
    expect(derive(n)).toMatchObject({ screen: 'details', detailId: 'a' });
    n = switchTab(n, 'settings');
    expect(screenOf(n)).toBe('trust');
  });

  it('tapping the current tab returns to its root', () => {
    const n = switchTab(push(initialNav, { name: 'plan', planDate: '2026-09-22' }), 'today');
    expect(derive(n)).toMatchObject({ screen: 'today', showTabs: true });
  });

  it('a settings leaf asked for from another tab opens on that tab, and back is where the user was (L6)', () => {
    // It used to jump to Settings on a fresh stack, so back landed on a
    // Settings root the user never saw. See navigationLoops.test.ts (c).
    const n = go(initialNav, 'trust');
    expect(n.tab).toBe('today');
    expect(screenOf(n)).toBe('trust');
    expect(derive(back(n))).toMatchObject({ screen: 'today', showTabs: true });
  });
});

describe('tasks', () => {
  it('a task covers the tab and back closes it, leaving the tab as it was', () => {
    let n = push(initialNav, { name: 'plan', planDate: '2026-09-22' });
    n = go(n, 'capture');
    expect(derive(n)).toMatchObject({ screen: 'capture', showTabs: false });
    n = back(n);
    expect(derive(n)).toMatchObject({ screen: 'plan', planDate: '2026-09-22' });
  });

  it('opening the open task again keeps it', () => {
    const n = openTask(initialNav, { name: 'capture' });
    expect(openTask(n, { name: 'capture' })).toBe(n);
  });

  it('closing a task that is not open changes nothing', () => {
    expect(closeTask(initialNav)).toBe(initialNav);
  });

  it('a tab tap leaves the task', () => {
    const n = switchTab(openTask(initialNav, { name: 'share' }), 'calendar');
    expect(n.task).toBeNull();
    expect(screenOf(n)).toBe('calendar');
  });
});

describe('arriving from a notification or a link', () => {
  it('the morning plan opens with Today underneath, whatever was open before', () => {
    const before = trail(initialNav, [(x) => go(x, 'settings'), (x) => go(x, 'trust'), (x) => go(x, 'capture')]);
    const n = arrive(before, { name: 'plan', planDate: '2026-09-22' });
    expect(derive(n)).toMatchObject({ screen: 'plan', planDate: '2026-09-22', showTabs: false });
    expect(n.task).toBeNull();
    expect(derive(back(n))).toMatchObject({ screen: 'today', showTabs: true });
  });

  it('an arrival replaces what Today already had open — back is Today, not the earlier Details', () => {
    // The case a weak test lets through: Today's own stack is non-empty when
    // the notification lands. Back from the plan must still be Today.
    const before = push(push(initialNav, { name: 'details', detailId: 'old' }), { name: 'plan', planDate: '2026-09-21' });
    const n = arrive(before, { name: 'plan', planDate: '2026-09-22' });
    expect(n.stacks.today).toHaveLength(1);
    expect(derive(back(n))).toMatchObject({ screen: 'today', showTabs: true });
  });

  it('a commitment link opens Details with Today underneath', () => {
    const n = arrive(initialNav, { name: 'details', detailId: 'c9' });
    expect(derive(n)).toMatchObject({ screen: 'details', detailId: 'c9' });
    expect(screenOf(back(n))).toBe('today');
  });

  it('a capture link opens the flow over Today', () => {
    const n = arrive(initialNav, { name: 'capture' });
    expect(screenOf(n)).toBe('capture');
    expect(derive(back(n))).toMatchObject({ screen: 'today', showTabs: true });
  });

  it('a tab link is just that tab', () => {
    expect(derive(arrive(initialNav, { name: 'calendar' }))).toMatchObject({ screen: 'calendar', showTabs: true });
  });
});
