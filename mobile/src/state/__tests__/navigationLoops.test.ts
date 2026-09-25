/**
 * The loops the owner hit on the first iPhone run ("many pages loop
 * illogically between each other"). Each block is the literal tap sequence,
 * driven through the pure reducer. The rule they pin: a push stays on the tab
 * the user is on, so back is always the screen they saw before; a screen that
 * is already in the stack is returned to, never pushed a second time.
 */
import { describe, expect, it } from '@jest/globals';
import { back, derive, go, initialNav, openTask, push, replace, switchTab, type Nav } from '../navigation';

const names = (n: Nav, tab = n.tab) => n.stacks[tab].map((e) => e.name);
const screenOf = (n: Nav) => derive(n).screen;

describe('a. Settings → background activity → watch builder → Create', () => {
  const opened = () => go(go(go(initialNav, 'settings'), 'backgroundActivity'), 'watchBuilder');

  it('finishing the builder returns to background activity instead of stacking a second copy', () => {
    const n = replace(opened(), { name: 'backgroundActivity' });
    expect(names(n)).toEqual(['backgroundActivity']);
    expect(screenOf(n)).toBe('backgroundActivity');
    expect(derive(back(n))).toMatchObject({ screen: 'settings', showTabs: true });
  });

  it('a plain go() to a screen lower in the stack pops back to it', () => {
    const n = go(opened(), 'backgroundActivity');
    expect(names(n)).toEqual(['backgroundActivity']);
    expect(screenOf(back(n))).toBe('settings');
  });
});

describe('b. Today → assistant → watch builder → Create', () => {
  it('stays on Today, the builder is gone, and back walks to the assistant then Today', () => {
    let n = go(switchTab(go(go(initialNav, 'settings'), 'about'), 'today'), 'contextualAssistant');
    n = go(n, 'watchBuilder');
    n = replace(n, { name: 'backgroundActivity' });
    expect(n.tab).toBe('today');
    expect(names(n)).toEqual(['contextualAssistant', 'backgroundActivity']);
    // The Settings tab's own stack was not thrown away.
    expect(names(n, 'settings')).toEqual(['about']);
    n = back(n);
    expect(screenOf(n)).toBe('contextualAssistant');
    n = back(n);
    expect(derive(n)).toMatchObject({ screen: 'today', showTabs: true });
  });

  it('no stale builder is left under Today afterwards', () => {
    const n = replace(go(go(initialNav, 'contextualAssistant'), 'watchBuilder'), { name: 'backgroundActivity' });
    expect(names(n)).not.toContain('watchBuilder');
  });
});

describe('c. a settings leaf opened from Today or Calendar stays on that tab', () => {
  const cases: { from: 'today' | 'calendar'; path: Parameters<typeof go>[1][]; leaf: Parameters<typeof go>[1] }[] = [
    { from: 'today', path: ['goalExecution'], leaf: 'knows' },
    { from: 'today', path: ['addToMaybeSitter'], leaf: 'notificationsSettings' },
    { from: 'today', path: ['addToMaybeSitter'], leaf: 'knows' },
    { from: 'today', path: ['contextualAssistant', 'actionModes'], leaf: 'personalization' },
    { from: 'calendar', path: ['commitments', 'addToMaybeSitter'], leaf: 'knows' },
  ];
  for (const { from, path, leaf } of cases) {
    it(`${from} → ${path.join(' → ')} → ${leaf}: back returns to ${path[path.length - 1]}`, () => {
      let n = switchTab(go(go(initialNav, 'settings'), 'about'), from);
      for (const step of path) n = go(n, step);
      n = go(n, leaf);
      expect(n.tab).toBe(from);
      expect(screenOf(n)).toBe(leaf);
      expect(names(n, 'settings')).toEqual(['about']);
      expect(screenOf(back(n))).toBe(path[path.length - 1]);
    });
  }

  it('Plan → notification settings → back is the same plan', () => {
    const n = go(push(initialNav, { name: 'plan', planDate: '2026-09-25' }), 'notificationsSettings');
    expect(n.tab).toBe('today');
    expect(derive(back(n))).toMatchObject({ screen: 'plan', planDate: '2026-09-25' });
  });

  it('Assistant → Personalization → Memory → back → back → Assistant', () => {
    let n = go(go(go(initialNav, 'contextualAssistant'), 'personalization'), 'memory');
    expect(names(n)).toEqual(['contextualAssistant', 'personalization', 'memory']);
    n = back(n); expect(screenOf(n)).toBe('personalization');
    n = back(n); expect(screenOf(n)).toBe('contextualAssistant');
  });

  it('capture\'s "why are you asking" opens Trust over the tab capture was opened on', () => {
    const n = go(openTask(push(initialNav, { name: 'plan', planDate: '2026-09-25' }), { name: 'capture' }), 'trust');
    expect(n.task).toBeNull();
    expect(n.tab).toBe('today');
    expect(derive(back(n))).toMatchObject({ screen: 'plan', planDate: '2026-09-25' });
  });
});

describe('d. a go() to a tab root from inside a stack', () => {
  it('Assistant → «شوف يومي» shows the calendar root and leaves Today at its root', () => {
    let n = go(initialNav, 'contextualAssistant');
    n = go(n, 'calendar');
    expect(derive(n)).toMatchObject({ screen: 'calendar', showTabs: true });
    expect(names(n, 'today')).toEqual([]);
    n = switchTab(n, 'today');
    expect(derive(n)).toMatchObject({ screen: 'today', showTabs: true });
  });

  it('lands on the named root even when that tab was left mid-stack', () => {
    let n = go(go(initialNav, 'calendar'), 'commitments');
    n = switchTab(n, 'today');
    n = go(go(n, 'contextualAssistant'), 'calendar');
    expect(derive(n)).toMatchObject({ screen: 'calendar', showTabs: true });
  });

  it('the tab bar still keeps each tab where it was left', () => {
    let n = go(initialNav, 'contextualAssistant');
    n = switchTab(n, 'calendar');
    n = switchTab(n, 'today');
    expect(screenOf(n)).toBe('contextualAssistant');
  });
});

describe('e. a goal is its own step in the history', () => {
  it('Goals → a goal → back closes the goal, not the Goals screen', () => {
    let n = go(go(initialNav, 'contextualAssistant'), 'goalExecution');
    n = push(n, { name: 'goalExecution', goalId: 'g1' });
    expect(derive(n)).toMatchObject({ screen: 'goalExecution', goalId: 'g1' });
    n = back(n);
    expect(derive(n)).toMatchObject({ screen: 'goalExecution', goalId: null });
    n = back(n);
    expect(screenOf(n)).toBe('contextualAssistant');
  });

  it('opening the same goal twice is one step', () => {
    const n = push(push(go(initialNav, 'goalExecution'), { name: 'goalExecution', goalId: 'g1' }), { name: 'goalExecution', goalId: 'g1' });
    expect(n.stacks.today).toHaveLength(2);
  });
});
