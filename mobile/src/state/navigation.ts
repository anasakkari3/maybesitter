import type { Screen } from './types';

/**
 * Navigation as a history, not a `prev` (Round 2, Phase B).
 *
 * Round 1 kept one `prev: Screen`. That is a single step of memory, so
 * Today → Plan → Details → back arrived on Plan, and back again arrived on
 * *Details* — `prev` had been overwritten by the second push. Every settings
 * leaf worked around it by being handed `onBack={() => go('settings')}`, which
 * is a hard-coded destination pretending to be history, and which pushed a
 * second copy of Trust when Knows went back to it.
 *
 * Round 2's shell is three tabs, each with its own stack, and *tasks* —
 * full-screen flows such as capture — layered over whichever tab is current.
 * That is what this models, with the app's own flat `Screen` names kept as
 * the entries, so no screen has to be renamed to be reachable.
 *
 *   tab      today · calendar · settings — the roots; the bar is visible only
 *            when the current tab's stack is empty and no task is open.
 *   stack    what has been pushed on top of that tab's root, in order.
 *   task     a flow that owns the whole screen until it is closed. Back
 *            closes it and returns to exactly where the tab was.
 *
 * Every entry carries its own parameters (`detailId`, `planDate`), so two
 * details screens in one stack each know which commitment they are.
 *
 * All of this is pure: the reducer functions below take a `Nav` and return a
 * new one, and the derived `screen / detailId / planDate` the screens already
 * read are computed from it by `derive`. `AppContext` owns the state; this
 * file owns the rules, and a test can drive Today → Plan → Details → back →
 * back → Today without rendering anything.
 */
export type Tab = 'today' | 'calendar' | 'settings';
export const TABS: readonly Tab[] = ['today', 'calendar', 'settings'];

export type Entry = { name: Screen; detailId?: string; planDate?: string };

export type Nav = {
  tab: Tab;
  stacks: Record<Tab, Entry[]>;
  task: Entry | null;
};

/**
 * Screens that own the whole display while they are open. Back closes them;
 * the tab underneath is untouched. `capture` is the flow, `share` is what
 * another app handed over, `deleteAccount` is a one-way door with its own
 * receipt, and the two development screens are outside the product.
 */
const TASKS: ReadonlySet<Screen> = new Set<Screen>(['capture', 'share', 'deleteAccount', 'gallery', 'calendarDemo']);

/**
 * Where a pushed screen lives. Settings leaves belong to the settings tab
 * wherever they are asked for — capture's "why are you asking" link opens
 * Trust *in Settings*, and back from there is Settings, not capture. Details
 * and the plan belong to whichever tab asked for them.
 */
const SETTINGS_LEAVES: ReadonlySet<Screen> = new Set<Screen>([
  'trust', 'knows', 'memory', 'feedbackHistory', 'activity', 'routineSettings', 'readinessSettings',
  'notificationsSettings', 'calendarSettings', 'calendarFeeds', 'footballSettings', 'categorySettings',
  'widgetSettings', 'about', 'langAppearance', 'account', 'sources',
]);

export const initialNav: Nav = { tab: 'today', stacks: { today: [], calendar: [], settings: [] }, task: null };

export function isTab(name: Screen): name is Tab {
  return (TABS as readonly string[]).includes(name);
}

export function isTask(name: Screen): boolean {
  return TASKS.has(name);
}

/** What is on screen, and the parameters it was opened with. */
export function derive(nav: Nav): { screen: Screen; detailId: string | null; planDate: string | null; showTabs: boolean } {
  const top = nav.task ?? nav.stacks[nav.tab][nav.stacks[nav.tab].length - 1] ?? null;
  return {
    screen: top?.name ?? nav.tab,
    detailId: top?.detailId ?? null,
    planDate: top?.planDate ?? null,
    showTabs: nav.task === null && nav.stacks[nav.tab].length === 0,
  };
}

/** Whether back has anywhere to go. False at a tab root, where the platform decides. */
export function canGoBack(nav: Nav): boolean {
  return nav.task !== null || nav.stacks[nav.tab].length > 0;
}

/** Back: close the task, else pop the current tab's stack, else nothing. */
export function back(nav: Nav): Nav {
  if (nav.task) return { ...nav, task: null };
  const stack = nav.stacks[nav.tab];
  if (stack.length === 0) return nav;
  return { ...nav, stacks: { ...nav.stacks, [nav.tab]: stack.slice(0, -1) } };
}

/**
 * Switch to a tab. Tapping the tab you are already on returns to its root,
 * the way every platform tab bar does; tapping another keeps that tab's stack
 * exactly as it was left. Any open task is closed — a tab tap is an
 * unambiguous "leave this".
 */
export function switchTab(nav: Nav, tab: Tab): Nav {
  const stacks = nav.tab === tab ? { ...nav.stacks, [tab]: [] } : nav.stacks;
  return { tab, stacks, task: null };
}

/** Push onto the current tab. A task, if one is open, is closed first: the pushed screen is where the user is going. */
export function push(nav: Nav, entry: Entry): Nav {
  const tab = SETTINGS_LEAVES.has(entry.name) ? 'settings' : nav.tab;
  const base = tab === nav.tab ? nav.stacks[tab] : [];
  // Pushing the screen already on top is a no-op, not a duplicate: a double
  // tap on a row must not need two backs to undo.
  const top = base[base.length - 1];
  if (top && top.name === entry.name && top.detailId === entry.detailId && top.planDate === entry.planDate) {
    return { ...nav, tab, task: null };
  }
  return { tab, stacks: { ...nav.stacks, [tab]: [...base, entry] }, task: null };
}

/** Open a task over the current tab. Opening the same task again keeps the one that is open. */
export function openTask(nav: Nav, entry: Entry): Nav {
  if (nav.task?.name === entry.name) return nav;
  return { ...nav, task: entry };
}

/** Close whatever task is open; the tab underneath is exactly as it was. */
export function closeTask(nav: Nav): Nav {
  return nav.task ? { ...nav, task: null } : nav;
}

/**
 * Go somewhere by name, the way Round 1's `go(screen)` was called from
 * everywhere. A tab switches; a task opens; anything else is pushed.
 */
export function go(nav: Nav, name: Screen): Nav {
  if (isTab(name)) return switchTab(nav, name);
  if (isTask(name)) return openTask(nav, { name });
  return push(nav, { name });
}

/**
 * Arrive from outside — a notification tap or a deep link.
 *
 * The person tapped a thing and expects that thing, with *its* natural way
 * back underneath: a plan's back is Today, a commitment's back is Today.
 * Whatever they were doing before the tap is not kept under it, because
 * "back" from a notification that took over the screen should not land on a
 * half-finished settings edit from an hour ago.
 */
export function arrive(nav: Nav, entry: Entry): Nav {
  if (isTab(entry.name)) return switchTab(initialNav, entry.name);
  if (isTask(entry.name)) return { ...switchTab(initialNav, 'today'), task: entry };
  const tab: Tab = SETTINGS_LEAVES.has(entry.name) ? 'settings' : 'today';
  return { tab, stacks: { ...initialNav.stacks, [tab]: [entry] }, task: null };
}
