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

export type Entry = { name: Screen; detailId?: string; planDate?: string; goalId?: string };

export type Nav = {
  tab: Tab;
  stacks: Record<Tab, Entry[]>;
  task: Entry | null;
};

/**
 * Screens that own the whole display while they are open. Back closes them;
 * the tab underneath is untouched. `capture` is the flow, `share` is what
 * another app handed over, `deleteAccount` is a one-way door with its own
 * receipt, and the development calendar demo is outside the product.
 */
const TASKS: ReadonlySet<Screen> = new Set<Screen>(['capture', 'share', 'deleteAccount', 'calendarDemo']);

/**
 * Where a settings leaf *arrives* from outside (a link or a notification):
 * the Settings tab, with the Settings root underneath.
 *
 * A leaf *pushed* from inside the app is not moved here. It used to be —
 * Goals → Knows, Plan → notification settings, capture's "why are you asking"
 * → Trust all jumped to the Settings tab on a fresh stack, so back landed on
 * a Settings root the user never saw, and the tab they came from kept a
 * half-walked stack to reopen later. A push now stays on the tab it was made
 * from, so back is always the screen the user was just on.
 */
const SETTINGS_LEAVES: ReadonlySet<Screen> = new Set<Screen>([
  'myMaybeSitter', 'integrations', 'googleIntegration', 'personalization', 'backgroundActivity',
  'trust', 'knows', 'memory', 'aiImport', 'feedbackHistory', 'activity', 'routineSettings', 'readinessSettings',
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
export function derive(nav: Nav): { screen: Screen; detailId: string | null; planDate: string | null; goalId: string | null; showTabs: boolean } {
  const top = nav.task ?? nav.stacks[nav.tab][nav.stacks[nav.tab].length - 1] ?? null;
  return {
    screen: top?.name ?? nav.tab,
    detailId: top?.detailId ?? null,
    planDate: top?.planDate ?? null,
    goalId: top?.goalId ?? null,
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

/** Two entries are the same step when the screen and every parameter match. */
function sameEntry(a: Entry, b: Entry): boolean {
  return a.name === b.name && a.detailId === b.detailId && a.planDate === b.planDate && a.goalId === b.goalId;
}

/**
 * Push onto the current tab — whatever the screen, settings leaves included —
 * so back returns to the screen the user was on. A task, if one is open, is
 * closed first: the pushed screen is where the user is going.
 *
 * A screen that is already in this tab's stack is returned to, not pushed a
 * second time: Background activity → builder → Create → Background activity
 * would otherwise be `[activity, builder, activity]`, and back would walk
 * through a builder that is already finished. The screen on top is the same
 * rule's simplest case — a double tap on a row must not need two backs.
 */
export function push(nav: Nav, entry: Entry): Nav {
  const tab = nav.tab;
  const stack = nav.stacks[tab];
  const at = stack.findIndex((e) => sameEntry(e, entry));
  const next = at === -1 ? [...stack, entry] : stack.slice(0, at + 1);
  return { tab, stacks: { ...nav.stacks, [tab]: next }, task: null };
}

/**
 * Leave the screen on top for another, in its place: a finished flow (the
 * watch builder after Create) hands over to its result, and back from the
 * result skips the flow. Same no-duplicate rule as `push`.
 */
export function replace(nav: Nav, entry: Entry): Nav {
  if (nav.task) return push(nav, entry);
  const stack = nav.stacks[nav.tab];
  return push({ ...nav, stacks: { ...nav.stacks, [nav.tab]: stack.slice(0, -1) } }, entry);
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
 * Open a tab's root from inside the app — «شوف يومي» on the assistant, "see
 * all" on Today. The person asked for that root, so it is what shows, and
 * the stack they left on the tab they were on is closed: otherwise tapping
 * that tab later reopens a screen from the middle of an abandoned walk.
 * (A tap on the tab bar is `switchTab`, which keeps every stack.)
 */
export function goToRoot(nav: Nav, tab: Tab): Nav {
  return { tab, stacks: { ...nav.stacks, [nav.tab]: [], [tab]: [] }, task: null };
}

/**
 * Go somewhere by name, the way Round 1's `go(screen)` was called from
 * everywhere. A tab root opens (see `goToRoot`); a task opens; anything else
 * is pushed onto the current tab.
 */
export function go(nav: Nav, name: Screen): Nav {
  if (isTab(name)) return goToRoot(nav, name);
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
