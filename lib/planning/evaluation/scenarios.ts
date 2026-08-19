/**
 * The planning scenario corpus and its generator (Sprint 07, issue #31).
 *
 * ── Status: synthetic, and the corpus says so ───────────────────────
 *
 * Every row here is constructed. Nothing has been reviewed by a person, and
 * `PlanningScenarioCorpus.provenance` records that in the data rather than in
 * this comment. Sprint 04 shipped an empty judgment corpus and Sprint 06 an
 * unreviewed seed set for the same reason: a dataset that claims review it
 * never had corrupts every number computed from it afterwards, invisibly,
 * because a score over fabricated labels looks exactly like a score over real
 * ones. The upgrade point is the same one Sprint 06 named — when a reviewer
 * exists, provenance moves from the corpus to the row and a review log has to
 * name the reviewer.
 *
 * ── A corpus is assembled, not exported ─────────────────────────────
 *
 * `CURATED_PLANNING_SCENARIOS` is an array. `assemblePlanningCorpus` is the
 * only way to get a `PlanningScenarioCorpus`, and it *refuses* rather than
 * reports: a missing kind, a duplicate id, an expectation that does not account
 * for every item, or an expectation that disagrees with the oracle in the next
 * file all stop assembly. The contract asks for this in as many words — a suite
 * with no DST scenario "should fail to assemble, not quietly pass".
 *
 * ── The gate consults the oracle, and that is not circular ──────────
 *
 * `scenarioCorpusIssues` runs `assessFeasibility` over every scenario and
 * requires the static half of each expectation to match it exactly, in both
 * directions. Oracle and corpus are one track, so this is self-consistency
 * rather than a cross-check — it is what stops a curated case from *asserting*
 * something no implementation produces. The actual check is the merge-owned
 * cross-track test, which runs #29's validator over these same scenarios and
 * compares its codes to the oracle's.
 *
 * A consequence worth stating: a curated case may trip **one** static defect
 * per item. Two at once cannot be used to compare two implementations, because
 * the comparison would pass while each side was reading a different one.
 *
 * ── Lock state is data, and the generator cannot mint it ────────────
 *
 * `ScenarioLockState` rides on the row. Selection re-derives the partition from
 * the rows and refuses a corpus whose tunable list has been tampered with,
 * instead of filtering it clean — a filter would make the leak invisible at
 * exactly the moment it mattered. The generator only ever emits `tunable`: a
 * hold-out a seed can regenerate is not held out, it is a value that moves the
 * next time someone edits the generator.
 *
 * ── The generator asserts only what it can compute ──────────────────
 *
 * It builds two families and no others: ample-capacity cases where every item
 * fits, and cases where exactly one item carries one seeded static defect.
 * Those are precisely the outcomes derivable without running a scheduler.
 * Generating a *contended* case would mean guessing which item loses the last
 * free hour, which is #30's judgement — and a generated expectation that
 * guessed it would either be trivially true or be a second, unreviewed
 * scheduler hiding in a data file. Every contested outcome is therefore a
 * curated row, written down with the reasoning in its `note`.
 *
 * ── No clock, no unseeded randomness ────────────────────────────────
 *
 * Rows are addressed by `sha256(seed:index)` rather than drawn from a running
 * stream, so a row's content depends on its own index and not on how many rows
 * were asked for — growing the corpus cannot re-point the rows already in it.
 * That is the property `lib/decomposition/evaluation/splits.ts` makes for split
 * assignment, for the same reason.
 */
import {
  ATTEMPT_INFEASIBILITY_CODES,
  STATIC_INFEASIBILITY_CODES,
  type PlanningConfig,
  type PlanningConstraints,
  type PlanningItem,
  type PlanningReasonCode,
  type PlanningScenario,
  type PlanningScenarioKind,
  type ScenarioLockState,
  type Weekday,
  type WorkingWindow,
} from '../../../src/contracts/v1/planningContracts';
import { canonicalJson, sha256Hex } from '../../evaluation/registry/fingerprint';
import { toEpochMs, zoneOffsetMs } from '../shared/time';
import { assessFeasibility } from './oracle';

export const PLANNING_SCENARIO_CORPUS_VERSION = '1.0.0' as const;

/**
 * The kinds a corpus must cover, declared as the keys of a total record.
 *
 * `Record<PlanningScenarioKind, true>` is exhaustive by construction: a kind
 * added to the contract is a compile error here rather than a kind the corpus
 * quietly stops covering. Writing the list out as an array would have compiled
 * fine and left the new kind untested.
 */
const REQUIRED_KINDS: Readonly<Record<PlanningScenarioKind, true>> = Object.freeze({
  feasible: true,
  overload: true,
  conflict: true,
  dependency: true,
  dst: true,
  boundary: true,
  multilingual: true,
  change: true,
});

export const PLANNING_SCENARIO_KINDS: readonly PlanningScenarioKind[] = Object.freeze(
  Object.keys(REQUIRED_KINDS) as PlanningScenarioKind[],
);

const LOCK_STATES: readonly ScenarioLockState[] = Object.freeze(['locked', 'tunable']);

/**
 * The rules this module enforces, as a value.
 *
 * Exported for the same reason `PLANNING_PERSISTENCE_POLICY` is: a promise a
 * test can assert against is a promise, and a promise written only in prose is
 * a preference.
 */
export const LOCKED_SCENARIO_POLICY = Object.freeze({
  /** Issue #31's acceptance criterion, in one field. */
  lockedScenariosEnterTuning: false,
  /** Read off the row, never inferred from an id, a file or a position. */
  lockStateCarriedInRow: true,
  /** A hold-out a seed can regenerate is not held out. */
  generatorMayMintLocked: false,
  /** Selection refuses a tampered corpus rather than filtering it clean. */
  tamperedCorpusIsRefused: true,
});

/* ── Corpus types ────────────────────────────────────────────────── */

/**
 * A scenario the type system knows is not locked.
 *
 * The narrowing is the first of the two guards on "locked cases never enter
 * tuning": a locked row is not assignable here, so the only way one reaches a
 * tuning list is across a boundary where the type was lost — a JSON file, a
 * cast, a merge. `selectTunableScenarios` re-derives the partition at runtime,
 * which is what covers that path.
 */
export type TunableScenario = PlanningScenario & { readonly lockState: 'tunable' };
export type LockedScenario = PlanningScenario & { readonly lockState: 'locked' };

export interface PlanningScenarioCorpus {
  /**
   * Recorded, never inferred. Sprint 07 ships no reviewed planning scenario,
   * and a consumer must be able to tell which kind of corpus it is holding.
   */
  readonly provenance: 'synthetic';
  readonly version: typeof PLANNING_SCENARIO_CORPUS_VERSION;
  /** Every row, ordered by id, so input order cannot reach the digest. */
  readonly scenarios: readonly PlanningScenario[];
  readonly locked: readonly LockedScenario[];
  readonly tunable: readonly TunableScenario[];
  readonly coverageByKind: Readonly<Record<PlanningScenarioKind, number>>;
  readonly digest: string;
}

/* ── Small builders ──────────────────────────────────────────────── */

const DEFAULT_CONFIG: PlanningConfig = Object.freeze({
  slotMinutes: 15,
  foldPolicy: 'earliest',
  resourceDependenciesOrder: false,
});

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Freeze a scenario and everything inside it.
 *
 * A shallow `Object.freeze` on the array left every row mutable, and the row is
 * where the lock lives: `corpus.locked[0].lockState = 'tunable'` succeeded, and
 * with it the guarantee that "locked cases never enter tuning" — the partition
 * had already been computed, so the corpus then held a row whose own field
 * contradicted the list it was in. The generated rows were frozen individually
 * and the curated ones were not, which is exactly the kind of difference that
 * survives review because both look like `Object.freeze` at a glance.
 *
 * Deep rather than shallow, because `lockState` is not the only field worth
 * protecting: an edited `constraints` would change what a locked row *means*
 * without changing which list it is in, and that is the edit no membership
 * check can see.
 */
const DEEP_FROZEN = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const node = value as unknown as object;
  // The recursion guard is a set of things this function has finished, not
  // `Object.isFrozen`. Using frozen-ness was wrong and failed silently: the
  // generated rows are built with `Object.freeze({...})`, which is shallow, so
  // the guard fired on the row and never reached its `constraints` — the rows
  // that looked most protected were the ones left open.
  if (DEEP_FROZEN.has(node)) return value;
  DEEP_FROZEN.add(node);
  Object.freeze(node);
  for (const nested of Object.values(node as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

function workWindow(
  windowId: string,
  weekday: Weekday,
  startMinute: number,
  endMinute: number,
  timezone: string,
): WorkingWindow {
  return Object.freeze({ windowId, weekday, startMinute, endMinute, timezone });
}

function task(overrides: Partial<PlanningItem> & { itemId: string; title: string }): PlanningItem {
  return Object.freeze({
    effort: { kind: 'known', minutes: 60 } as PlanningItem['effort'],
    earliestStartAt: null,
    deadlineAt: null,
    priority: 50,
    dependsOn: [],
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    ...overrides,
  });
}

const HOUR = 60;

/* ── The curated corpus ──────────────────────────────────────────── */

/**
 * Hand-written cases, each with the reasoning for its expected outcome in its
 * `note`. Everything whose outcome depends on a *choice* — which item loses a
 * contended hour, which side of a fold a window starts on — lives here rather
 * than in the generator, because those are the cases a reader has to be able to
 * argue with.
 */
const CURATED_ROWS: readonly PlanningScenario[] = [
  /* feasible */
  {
    scenarioId: 'feasible-en-workweek',
    kind: 'feasible',
    lockState: 'tunable',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-feasible-workweek',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-14T00:00:00.000Z' },
      workingWindows: [
        workWindow('w-mon', 1, 9 * HOUR, 17 * HOUR, 'America/New_York'),
        workWindow('w-tue', 2, 9 * HOUR, 17 * HOUR, 'America/New_York'),
        workWindow('w-wed', 3, 9 * HOUR, 17 * HOUR, 'America/New_York'),
      ],
      fixedEvents: [],
      items: [
        task({ itemId: 'i-brief', title: 'draft the launch brief', effort: { kind: 'known', minutes: 60 }, priority: 70, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }),
        task({ itemId: 'i-review', title: 'review the vendor contract', effort: { kind: 'known', minutes: 45 }, priority: 60 }),
      ],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-brief', 'i-review'],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: [],
    },
    note: '24 working hours against 135 minutes of demand. The baseline: if this one does not place, nothing will.',
  },

  /* overload */
  {
    scenarioId: 'overload-en-single-afternoon',
    kind: 'overload',
    lockState: 'tunable',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-overload-afternoon',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [workWindow('w-mon-pm', 1, 13 * HOUR, 15 * HOUR, 'America/New_York')],
      fixedEvents: [],
      items: [
        task({ itemId: 'i-high', title: 'file the tax return', priority: 90 }),
        task({ itemId: 'i-mid', title: 'confirm the clinic appointment', priority: 80 }),
        task({ itemId: 'i-low', title: 'tidy the shared drive', priority: 70 }),
      ],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-high', 'i-mid'],
      // An attempt code: this is a claim about #30, not about the oracle. Nothing
      // here is statically contradictory — the week is simply too small.
      expectedUnscheduledReasons: { 'i-low': 'NO_FEASIBLE_SLOT' },
      expectedConstraintCodes: [],
    },
    note: '120 minutes of capacity, 180 of demand. PLAN_ORDERING_KEYS sorts by -priority, so the 70 loses.',
  },

  /* conflict */
  {
    scenarioId: 'conflict-double-booked-blocking-events',
    kind: 'conflict',
    lockState: 'locked',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-conflict-double-booked',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [workWindow('w-mon', 1, 9 * HOUR, 17 * HOUR, 'America/New_York')],
      fixedEvents: [
        { eventId: 'e-standup', interval: { startsAt: '2026-11-09T15:00:00.000Z', endsAt: '2026-11-09T16:00:00.000Z' }, sourceCommitmentId: null, blocking: true },
        { eventId: 'e-review', interval: { startsAt: '2026-11-09T15:30:00.000Z', endsAt: '2026-11-09T16:30:00.000Z' }, sourceCommitmentId: 'commitment-42', blocking: true },
      ],
      items: [],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: [],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: ['FIXED_EVENT_CONFLICT'],
    },
    note: 'Carries no items on purpose: the contradiction is in the calendar, and adding items would make the case also assert how a scheduler behaves under one.',
  },
  {
    scenarioId: 'conflict-item-routes-around-meeting',
    kind: 'conflict',
    lockState: 'tunable',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-conflict-route-around',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [workWindow('w-mon-am', 1, 9 * HOUR, 12 * HOUR, 'America/New_York')],
      fixedEvents: [
        { eventId: 'e-clinic', interval: { startsAt: '2026-11-09T14:00:00.000Z', endsAt: '2026-11-09T16:00:00.000Z' }, sourceCommitmentId: null, blocking: true },
      ],
      items: [task({ itemId: 'i-call', title: 'call the insurer back' })],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-call'],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: [],
    },
    note: 'The only free hour abuts the meeting exactly. It fits because end instants are excluded; a scheduler using <= on one side would report no slot.',
  },

  /* dependency */
  {
    scenarioId: 'dependency-cycle-two-items',
    kind: 'dependency',
    lockState: 'locked',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-dependency-cycle',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [workWindow('w-mon', 1, 9 * HOUR, 17 * HOUR, 'America/New_York')],
      fixedEvents: [],
      items: [
        task({ itemId: 'i-a', title: 'agree the budget', effort: { kind: 'known', minutes: 30 }, dependsOn: [{ dependsOnItemId: 'i-b', kind: 'temporal' }] }),
        task({ itemId: 'i-b', title: 'sign off the budget', effort: { kind: 'known', minutes: 30 }, dependsOn: [{ dependsOnItemId: 'i-a', kind: 'temporal' }] }),
      ],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: [],
      expectedUnscheduledReasons: { 'i-a': 'CYCLIC_DEPENDENCY', 'i-b': 'CYCLIC_DEPENDENCY' },
      expectedConstraintCodes: [],
    },
    note: 'Both members are named. Reporting only the item a graph walk entered by would send a maintainer to break whichever edge the input order happened to reach first.',
  },
  {
    scenarioId: 'dependency-self-edge',
    kind: 'dependency',
    lockState: 'locked',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-dependency-self',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [workWindow('w-mon', 1, 9 * HOUR, 17 * HOUR, 'America/New_York')],
      fixedEvents: [],
      items: [
        task({ itemId: 'i-loop', title: 'plan the planning session', dependsOn: [{ dependsOnItemId: 'i-loop', kind: 'temporal' }] }),
      ],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: [],
      expectedUnscheduledReasons: { 'i-loop': 'SELF_DEPENDENCY' },
      expectedConstraintCodes: [],
    },
    note: 'SELF_DEPENDENCY takes precedence over CYCLIC_DEPENDENCY: one defect earns one code, so this row pins the precedence and not just the detection.',
  },
  {
    scenarioId: 'dependency-unknown-edge',
    kind: 'dependency',
    lockState: 'tunable',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-dependency-unknown',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [workWindow('w-mon', 1, 9 * HOUR, 17 * HOUR, 'America/New_York')],
      fixedEvents: [],
      items: [
        task({ itemId: 'i-dangling', title: 'send the signed copy', dependsOn: [{ dependsOnItemId: 'i-not-in-request', kind: 'informational' }] }),
        task({ itemId: 'i-plain', title: 'book the courier' }),
      ],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-plain'],
      expectedUnscheduledReasons: { 'i-dangling': 'UNKNOWN_DEPENDENCY' },
      expectedConstraintCodes: [],
    },
    note: 'The edge is informational, which forces no ordering. It is still a broken reference, and the code is about the reference rather than the ordering.',
  },

  /* dst */
  {
    scenarioId: 'dst-newyork-spring-forward-short-day',
    kind: 'dst',
    lockState: 'locked',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-dst-ny-spring',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-03-08T00:00:00.000Z', endsAt: '2026-03-09T00:00:00.000Z' },
      workingWindows: [workWindow('w-sun-early', 0, 1 * HOUR, 5 * HOUR, 'America/New_York')],
      fixedEvents: [],
      items: [task({ itemId: 'i-early', title: 'pack for the trip', effort: { kind: 'known', minutes: 120 }, priority: 80 })],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-early'],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: [],
    },
    note: 'A four-hour clock face over the 07:00Z transition is three real hours. A planner that materialised the window as wall-clock arithmetic would offer 240 minutes of a day that had 180.',
  },
  {
    scenarioId: 'dst-newyork-spring-forward-gap-start',
    kind: 'dst',
    lockState: 'locked',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-dst-ny-gap',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-03-08T00:00:00.000Z', endsAt: '2026-03-09T00:00:00.000Z' },
      workingWindows: [workWindow('w-sun-gap', 0, 2 * HOUR, 6 * HOUR, 'America/New_York')],
      fixedEvents: [],
      items: [],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: [],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: ['NONEXISTENT_LOCAL_TIME'],
    },
    note: 'Local 02:00 does not exist on 2026-03-08. The window is not discarded — it resumes at the instant the clock jumps to — but the fact is reported, because a caller that budgeted the full window is over by exactly the transition.',
  },
  {
    scenarioId: 'dst-newyork-fall-back-fold-earliest',
    kind: 'dst',
    lockState: 'locked',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-dst-ny-fall',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-02T00:00:00.000Z' },
      workingWindows: [workWindow('w-sun-fold', 0, 1 * HOUR, 4 * HOUR, 'America/New_York')],
      fixedEvents: [],
      items: [task({ itemId: 'i-fold', title: 'clear the inbox backlog', effort: { kind: 'known', minutes: 180 } })],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-fold'],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: [],
    },
    note: 'Local 01:00 happens twice. With foldPolicy `earliest` the window is 240 minutes and the 180-minute item fits; under `latest` it is 180 and only just fits. Kept at `earliest` so the pair with the item size is the assertion.',
  },
  {
    scenarioId: 'dst-jerusalem-spring-forward-gap-start',
    kind: 'dst',
    lockState: 'locked',
    locale: 'he-IL',
    constraints: {
      scopeId: 'scope-dst-jlm-spring',
      timezone: 'Asia/Jerusalem',
      horizon: { startsAt: '2026-03-26T22:00:00.000Z', endsAt: '2026-03-27T12:00:00.000Z' },
      workingWindows: [workWindow('w-fri-gap', 5, 2 * HOUR, 6 * HOUR, 'Asia/Jerusalem')],
      fixedEvents: [],
      items: [],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: [],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: ['NONEXISTENT_LOCAL_TIME'],
    },
    note: 'Jerusalem springs forward on a Friday, not on the Sunday New York uses. A DST suite drawn only from US dates would place work in an hour that did not happen here.',
  },
  {
    scenarioId: 'dst-jerusalem-fall-back-fold',
    kind: 'dst',
    lockState: 'locked',
    locale: 'he-IL',
    constraints: {
      scopeId: 'scope-dst-jlm-fall',
      timezone: 'Asia/Jerusalem',
      horizon: { startsAt: '2026-10-24T20:00:00.000Z', endsAt: '2026-10-25T12:00:00.000Z' },
      workingWindows: [workWindow('w-sun-fold', 0, 1 * HOUR, 4 * HOUR, 'Asia/Jerusalem')],
      fixedEvents: [],
      items: [task({ itemId: 'i-morning', title: 'לסדר את המסמכים לרשויות', effort: { kind: 'known', minutes: 120 } })],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-morning'],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: [],
    },
    note: 'The fold lands at local 01:00 on Sunday 2026-10-25, an hour earlier in the day than the New York one. The window is 240 minutes rather than 180.',
  },

  /* boundary */
  {
    scenarioId: 'boundary-window-ends-at-midnight',
    kind: 'boundary',
    lockState: 'tunable',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-boundary-midnight',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-11T00:00:00.000Z' },
      workingWindows: [workWindow('w-mon-night', 1, 22 * HOUR, 24 * HOUR, 'America/New_York')],
      fixedEvents: [],
      items: [task({ itemId: 'i-late', title: 'read the school forms' })],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-late'],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: [],
    },
    note: 'Minute 1440 is the top of the stated domain: a window ending at midnight ends at minute 1440 of its own day, not minute 0 of the next one.',
  },
  {
    scenarioId: 'boundary-deadline-before-horizon-start',
    kind: 'boundary',
    lockState: 'locked',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-boundary-deadline-overdue',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [workWindow('w-mon', 1, 9 * HOUR, 17 * HOUR, 'America/New_York')],
      fixedEvents: [],
      items: [task({ itemId: 'i-overdue', title: 'renew the passport', deadlineAt: '2026-11-08T00:00:00.000Z' })],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: [],
      expectedUnscheduledReasons: { 'i-overdue': 'DEADLINE_BEYOND_HORIZON' },
      expectedConstraintCodes: [],
    },
    note: 'The surviving half of DEADLINE_BEYOND_HORIZON: the deadline is already past when the plan begins, so no instant inside the horizon is before it. Distinct from having no time — there is a whole free day here — which is what separates this code from NO_FEASIBLE_SLOT. Replaces an earlier row that pointed the other way; see its counterpart below for why that direction is not this code.',
  },
  {
    scenarioId: 'boundary-deadline-after-horizon-end-still-places',
    kind: 'boundary',
    lockState: 'locked',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-boundary-deadline-long-dated',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [workWindow('w-mon', 1, 9 * HOUR, 17 * HOUR, 'America/New_York')],
      fixedEvents: [],
      items: [task({ itemId: 'i-long-dated', title: 'renew the passport', deadlineAt: '2026-11-20T00:00:00.000Z' })],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-long-dated'],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: [],
    },
    note: 'The guard for the behaviour that nearly went missing. An item due eleven days after a one-day horizon is the least constrained thing in the request: the horizon binds first and the item places normally. An earlier reading called this DEADLINE_BEYOND_HORIZON, which would have turned every long-dated commitment into an infeasibility — most of the forward-looking work a planner exists to place.',
  },
  {
    scenarioId: 'boundary-no-working-window',
    kind: 'boundary',
    lockState: 'locked',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-boundary-no-window',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [],
      fixedEvents: [],
      items: [],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: [],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: ['NO_WORKING_WINDOW'],
    },
    note: 'There is nowhere legal to put anything. Carries no items so the row asserts the constraint-level finding alone and not a scheduler behaviour under it.',
  },
  {
    scenarioId: 'boundary-zero-length-fixed-event',
    kind: 'boundary',
    lockState: 'tunable',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-boundary-zero-event',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [workWindow('w-mon', 1, 9 * HOUR, 17 * HOUR, 'America/New_York')],
      fixedEvents: [
        { eventId: 'e-degenerate', interval: { startsAt: '2026-11-09T15:00:00.000Z', endsAt: '2026-11-09T15:00:00.000Z' }, sourceCommitmentId: null, blocking: true },
      ],
      items: [],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: [],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: ['INVALID_INTERVAL'],
    },
    note: 'The event occupies no time while claiming a position: it conflicts with nothing and nothing conflicts with it, so only an explicit well-formedness check can see it.',
  },
  {
    scenarioId: 'boundary-kolkata-half-hour-offset',
    kind: 'boundary',
    lockState: 'tunable',
    locale: 'en-IN',
    constraints: {
      scopeId: 'scope-boundary-kolkata',
      timezone: 'Asia/Kolkata',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [workWindow('w-mon-ist', 1, 9 * HOUR, 17 * HOUR, 'Asia/Kolkata')],
      fixedEvents: [],
      items: [task({ itemId: 'i-vendor', title: 'reconcile the vendor invoices', effort: { kind: 'known', minutes: 90 } })],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-vendor'],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: [],
    },
    note: 'A +05:30 offset and no transition all year. Arithmetic written in whole hours passes every US and European case and fails here.',
  },

  /* multilingual */
  {
    scenarioId: 'multilingual-ar-riyadh',
    kind: 'multilingual',
    lockState: 'tunable',
    locale: 'ar-SA',
    constraints: {
      scopeId: 'scope-multilingual-ar',
      timezone: 'Asia/Riyadh',
      horizon: { startsAt: '2026-11-08T00:00:00.000Z', endsAt: '2026-11-09T00:00:00.000Z' },
      workingWindows: [workWindow('w-sun-riyadh', 0, 9 * HOUR, 17 * HOUR, 'Asia/Riyadh')],
      fixedEvents: [],
      items: [
        task({ itemId: 'i-budget-ar', title: 'تحضير عرض الميزانية للربع Q4 قبل 15 نوفمبر', effort: { kind: 'known', minutes: 90 }, priority: 75 }),
      ],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-budget-ar'],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: [],
    },
    note: 'RTL text with an embedded Latin token and Western digits: the bidi shape a title actually arrives in. Riyadh keeps +03 all year, so nothing here is a DST case in disguise.',
  },
  {
    scenarioId: 'multilingual-he-jerusalem',
    kind: 'multilingual',
    lockState: 'locked',
    locale: 'he-IL',
    constraints: {
      scopeId: 'scope-multilingual-he',
      timezone: 'Asia/Jerusalem',
      horizon: { startsAt: '2026-11-08T00:00:00.000Z', endsAt: '2026-11-09T00:00:00.000Z' },
      workingWindows: [workWindow('w-sun-jlm', 0, 9 * HOUR, 17 * HOUR, 'Asia/Jerusalem')],
      fixedEvents: [],
      items: [
        task({ itemId: 'i-budget-he', title: 'להכין את מצגת התקציב לרבעון', effort: { kind: 'known', minutes: 90 }, priority: 75 }),
      ],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-budget-he'],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: [],
    },
    note: 'Sunday is a working day in Jerusalem. A corpus that only ever placed work Monday to Friday would encode one calendar as the calendar.',
  },
  {
    scenarioId: 'multilingual-en-newyork',
    kind: 'multilingual',
    lockState: 'tunable',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-multilingual-en',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-08T00:00:00.000Z', endsAt: '2026-11-09T00:00:00.000Z' },
      workingWindows: [workWindow('w-sun-nyc', 0, 9 * HOUR, 17 * HOUR, 'America/New_York')],
      fixedEvents: [],
      items: [
        task({ itemId: 'i-budget-en', title: 'prepare the Q4 budget deck', effort: { kind: 'known', minutes: 90 }, priority: 75 }),
      ],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-budget-en'],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: [],
    },
    note: 'The LTR control for the pair above: same shape, same effort, same weekday, so a difference in outcome is a difference in text handling and nothing else.',
  },

  /* change */
  {
    scenarioId: 'change-meeting-appears-before',
    kind: 'change',
    lockState: 'tunable',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-change-meeting-appears',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [workWindow('w-mon-am', 1, 9 * HOUR, 13 * HOUR, 'America/New_York')],
      fixedEvents: [],
      items: [task({ itemId: 'i-deck', title: 'finish the onboarding deck', priority: 60 })],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-deck'],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: [],
    },
    note: 'The first half of a re-plan pair. Four free hours, one item; the plan produced here is the previous plan churn is measured against.',
  },
  {
    scenarioId: 'change-meeting-appears-after',
    kind: 'change',
    lockState: 'tunable',
    locale: 'en-US',
    constraints: {
      scopeId: 'scope-change-meeting-appears',
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [workWindow('w-mon-am', 1, 9 * HOUR, 13 * HOUR, 'America/New_York')],
      fixedEvents: [
        { eventId: 'e-new-meeting', interval: { startsAt: '2026-11-09T14:00:00.000Z', endsAt: '2026-11-09T17:00:00.000Z' }, sourceCommitmentId: 'commitment-77', blocking: true },
      ],
      items: [task({ itemId: 'i-deck', title: 'finish the onboarding deck', priority: 60 })],
    },
    config: DEFAULT_CONFIG,
    expectation: {
      expectedScheduledItemIds: ['i-deck'],
      expectedUnscheduledReasons: {},
      expectedConstraintCodes: [],
    },
    note: 'Same scope, same item, one new blocking meeting. The window is 14:00Z-18:00Z and the meeting takes 14:00Z-17:00Z, so the only free hour is the last one and the item moves three hours. Churn is non-zero while the placement rate is unchanged, which is why the two are reported separately.',
  },
];

export const CURATED_PLANNING_SCENARIOS: readonly PlanningScenario[] = Object.freeze(CURATED_ROWS.map(deepFreeze));

/* ── The generator ───────────────────────────────────────────────── */

export const DEFAULT_SCENARIO_SEED = 'sprint-07' as const;
export const DEFAULT_GENERATED_SCENARIO_COUNT = 12;

/**
 * Locale, zone and a title in the matching script.
 *
 * A generated Arabic scenario carrying a Latin title would exercise none of the
 * bidi handling the locale is there to represent, so the script travels with
 * the locale rather than being drawn separately.
 */
const GENERATOR_LOCALES: readonly {
  readonly locale: string;
  readonly timezone: string;
  readonly title: string;
}[] = Object.freeze([
  { locale: 'en-US', timezone: 'America/New_York', title: 'prepare the quarterly summary' },
  { locale: 'ar-SA', timezone: 'Asia/Riyadh', title: 'مراجعة تقرير الميزانية' },
  { locale: 'he-IL', timezone: 'Asia/Jerusalem', title: 'סקירת דוח התקציב' },
  { locale: 'en-IN', timezone: 'Asia/Kolkata', title: 'reconcile the vendor invoices' },
]);

/**
 * The defects a generated boundary case may carry, one per row.
 *
 * Every entry is a *static* code whose presence follows from the item alone, so
 * the expectation is computable here without a scheduler. Attempt codes are
 * deliberately absent: which item loses a contended hour is #30's judgement,
 * and a generator that guessed it would be a second scheduler living in a data
 * file.
 */
const GENERATED_DEFECTS: readonly PlanningReasonCode[] = Object.freeze([
  'EFFORT_UNKNOWN',
  'EFFORT_NOT_POSITIVE',
  'DEADLINE_BEFORE_EARLIEST_START',
  'DEADLINE_BEYOND_HORIZON',
  'SELF_DEPENDENCY',
  'UNKNOWN_DEPENDENCY',
]);

const GENERATED_HORIZON = Object.freeze({
  startsAt: '2026-11-09T00:00:00.000Z',
  endsAt: '2026-11-14T00:00:00.000Z',
});

/**
 * A deterministic draw for `(seed, index, field)`.
 *
 * Addressed rather than streamed: each field of each row hashes its own name,
 * so adding a field or growing the corpus cannot shift the values of the rows
 * already in it. A running PRNG would re-point every subsequent row the first
 * time anyone inserted a draw.
 */
function draw(seed: string, index: number, field: string, modulus: number): number {
  const digest = sha256Hex(`${PLANNING_SCENARIO_CORPUS_VERSION}:${seed}:${index}:${field}`);
  return parseInt(digest.slice(0, 8), 16) % modulus;
}

export interface GenerateScenariosOptions {
  readonly seed: string;
  readonly count: number;
}

export function generatePlanningScenarios(
  options: GenerateScenariosOptions,
): readonly PlanningScenario[] {
  const { seed, count } = options;
  // The seed reaches the scenario id, and an id is quoted in every issue message
  // the gate produces. Constraining it here keeps that safe by construction
  // rather than by escaping at each use.
  if (typeof seed !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(seed)) {
    throw new Error(
      `planning scenarios: seed must match /^[a-z0-9][a-z0-9-]{0,31}$/, received ${JSON.stringify(seed)}`,
    );
  }
  if (!Number.isInteger(count) || count < 0 || count > 1000) {
    throw new Error(`planning scenarios: count must be an integer in 0..1000, received ${JSON.stringify(count)}`);
  }

  const scenarios: PlanningScenario[] = [];
  for (let index = 0; index < count; index += 1) {
    const locale = GENERATOR_LOCALES[draw(seed, index, 'locale', GENERATOR_LOCALES.length)];
    const itemCount = 2 + draw(seed, index, 'items', 3);
    const withDefect = index % 2 === 1;
    const defectIndex = draw(seed, index, 'defect-item', itemCount);
    const defect = GENERATED_DEFECTS[draw(seed, index, 'defect-kind', GENERATED_DEFECTS.length)];

    const items: PlanningItem[] = [];
    const expectedScheduledItemIds: string[] = [];
    const expectedUnscheduledReasons: Record<string, PlanningReasonCode> = {};

    for (let slot = 0; slot < itemCount; slot += 1) {
      const itemId = `gen-${seed}-${index}-${slot}`;
      const minutes = 30 + 15 * draw(seed, index, `effort-${slot}`, 5);
      const buffer = 15 * draw(seed, index, `buffer-${slot}`, 2);
      const priority = 10 + draw(seed, index, `priority-${slot}`, 90);
      const base = {
        itemId,
        title: `${locale.title} (${slot + 1})`,
        effort: { kind: 'known', minutes } as PlanningItem['effort'],
        priority,
        bufferBeforeMinutes: buffer,
        bufferAfterMinutes: buffer,
      };

      if (!withDefect || slot !== defectIndex) {
        items.push(task(base));
        expectedScheduledItemIds.push(itemId);
        continue;
      }

      expectedUnscheduledReasons[itemId] = defect;
      switch (defect) {
        case 'EFFORT_UNKNOWN':
          items.push(task({ ...base, effort: { kind: 'unknown' } }));
          break;
        case 'EFFORT_NOT_POSITIVE':
          items.push(task({ ...base, effort: { kind: 'known', minutes: 0 } }));
          break;
        case 'DEADLINE_BEFORE_EARLIEST_START':
          items.push(task({
            ...base,
            earliestStartAt: '2026-11-10T12:00:00.000Z',
            deadlineAt: '2026-11-10T12:00:00.000Z',
          }));
          break;
        case 'DEADLINE_BEYOND_HORIZON':
          // Before the horizon *starts*, not after it ends. A deadline after the
          // end is not this code and not an infeasibility at all: the horizon
          // binds first and the item schedules normally. The generated rows
          // asserted the opposite, and #30's scheduler placed the very items
          // they claimed were unplaceable.
          items.push(task({ ...base, deadlineAt: '2026-11-01T00:00:00.000Z' }));
          break;
        case 'SELF_DEPENDENCY':
          items.push(task({ ...base, dependsOn: [{ dependsOnItemId: itemId, kind: 'temporal' }] }));
          break;
        default:
          items.push(task({
            ...base,
            dependsOn: [{ dependsOnItemId: `gen-${seed}-${index}-absent`, kind: 'temporal' }],
          }));
          break;
      }
    }

    scenarios.push(Object.freeze({
      scenarioId: `gen-${seed}-${String(index).padStart(3, '0')}`,
      kind: withDefect ? 'boundary' : 'feasible',
      // Never `locked`. A hold-out a seed can regenerate is not held out.
      lockState: 'tunable',
      locale: locale.locale,
      constraints: {
        scopeId: `scope-gen-${seed}-${index}`,
        timezone: locale.timezone,
        horizon: GENERATED_HORIZON,
        workingWindows: [
          workWindow(`w-gen-${index}-mon`, 1, 9 * HOUR, 17 * HOUR, locale.timezone),
          workWindow(`w-gen-${index}-tue`, 2, 9 * HOUR, 17 * HOUR, locale.timezone),
          workWindow(`w-gen-${index}-wed`, 3, 9 * HOUR, 17 * HOUR, locale.timezone),
        ],
        fixedEvents: [],
        items,
      },
      config: DEFAULT_CONFIG,
      expectation: {
        expectedScheduledItemIds,
        expectedUnscheduledReasons,
        expectedConstraintCodes: [],
      },
      note: withDefect
        ? `Generated from seed '${seed}' at index ${index}: one item carries ${defect} and the rest have ample capacity.`
        : `Generated from seed '${seed}' at index ${index}: 24 working hours against a demand that cannot fill them.`,
    }) as PlanningScenario);
  }
  return Object.freeze(scenarios);
}

/* ── The gate ────────────────────────────────────────────────────── */

const STATIC_CODES = STATIC_INFEASIBILITY_CODES as readonly string[];
const ATTEMPT_CODES = ATTEMPT_INFEASIBILITY_CODES as readonly string[];

/**
 * Everything wrong with a candidate corpus, as a list.
 *
 * Returned as data rather than thrown so a caller — a report, a CI step — can
 * show all of it at once. `assemblePlanningCorpus` is the enforcing wrapper,
 * because the corpus a consumer holds must never be one that failed a check.
 */
export function scenarioCorpusIssues(scenarios: readonly PlanningScenario[]): readonly string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  const coverage = new Map<string, number>();

  if (scenarios.length === 0) issues.push('the corpus is empty');

  scenarios.forEach((scenario, position) => {
    const ref = typeof scenario.scenarioId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(scenario.scenarioId)
      ? scenario.scenarioId
      : `scenario#${position}`;

    if (ref !== scenario.scenarioId) {
      issues.push(`${ref}: scenarioId must match /^[a-z0-9][a-z0-9-]{0,63}$/`);
    }
    if (seenIds.has(scenario.scenarioId)) {
      issues.push(`${ref}: duplicate scenarioId`);
    }
    seenIds.add(scenario.scenarioId);

    if (!PLANNING_SCENARIO_KINDS.includes(scenario.kind)) {
      issues.push(`${ref}: unknown kind ${JSON.stringify(scenario.kind)}`);
      return;
    }
    coverage.set(scenario.kind, (coverage.get(scenario.kind) ?? 0) + 1);

    // Defaulting an unreadable lock state either way is a decision a loader does
    // not get to make: `tunable` would put an unreadable row in the fitting set
    // and `locked` would quietly shrink it.
    if (!LOCK_STATES.includes(scenario.lockState)) {
      issues.push(`${ref}: unknown lockState ${JSON.stringify(scenario.lockState)}`);
    }
    if (typeof scenario.locale !== 'string' || scenario.locale.length === 0) {
      issues.push(`${ref}: a scenario must name the locale it represents`);
    }
    if (typeof scenario.note !== 'string' || scenario.note.length === 0) {
      issues.push(`${ref}: a scenario must say why it exists, especially when the expected outcome is a failure`);
    }

    const itemIds = scenario.constraints.items.map((item) => item.itemId);
    if (new Set(itemIds).size !== itemIds.length) {
      issues.push(`${ref}: duplicate item ids`);
    }

    const scheduled = scenario.expectation.expectedScheduledItemIds;
    const unscheduledIds = Object.keys(scenario.expectation.expectedUnscheduledReasons);
    const claimed = scheduled.concat(unscheduledIds);
    if (new Set(claimed).size !== claimed.length) {
      issues.push(`${ref}: an item is claimed both scheduled and unscheduled`);
    }
    if (claimed.slice().sort(byCodeUnit).join('|') !== itemIds.slice().sort(byCodeUnit).join('|')) {
      // The same promise `Plan` makes. An expectation that skips an item asserts
      // nothing about it while looking complete.
      issues.push(`${ref}: the expectation does not account for every item exactly once`);
    }
    for (const code of scenario.expectation.expectedConstraintCodes) {
      if (!STATIC_CODES.includes(code)) {
        issues.push(`${ref}: ${code} is not a static code and cannot be a constraint-level expectation`);
      }
    }

    /* Agreement with the oracle, in both directions. */

    const verdict = assessFeasibility(scenario.constraints, scenario.config);
    const emittedConstraint = verdict.reasons
      .filter((reason) => reason.itemId === null)
      .map((reason) => reason.code)
      .slice()
      .sort(byCodeUnit);
    const expectedConstraint = scenario.expectation.expectedConstraintCodes.slice().sort(byCodeUnit);
    if (emittedConstraint.join('|') !== expectedConstraint.join('|')) {
      issues.push(
        `${ref}: constraint-level expectation [${expectedConstraint.join(', ')}] `
          + `disagrees with the oracle [${emittedConstraint.join(', ')}]`,
      );
    }

    // Items are named by position. `scenarioId` is quoted because the gate
    // validates its shape and falls back to a position when it does not match —
    // it is this module's own row identity, and an author needs it to find the
    // row. `itemId` is validated by nothing at all, so it is never quoted.
    scenario.constraints.items.forEach((item, itemIndex) => {
      const itemRef = `${ref}: item at position ${itemIndex}`;
      const emitted = verdict.reasons
        .filter((reason) => reason.itemId === item.itemId)
        .map((reason) => reason.code);
      const expected = scenario.expectation.expectedUnscheduledReasons[item.itemId];

      if (emitted.length > 1) {
        issues.push(
          `${itemRef}: trips ${emitted.length} static codes at once (${emitted.join(', ')}); `
            + 'a case that compares two implementations must isolate one defect',
        );
        return;
      }
      if (emitted.length === 1) {
        if (expected !== emitted[0]) {
          issues.push(`${itemRef}: expected ${String(expected)} but the oracle reports ${emitted[0]}`);
        }
        return;
      }
      if (expected !== undefined && !ATTEMPT_CODES.includes(expected)) {
        issues.push(
          `${itemRef}: expects the static code ${expected} but the oracle finds no defect in the input`,
        );
      }
    });

    /* Kind-specific: the label must be evidence, not decoration. */

    if (scenario.kind === 'feasible' && !verdict.feasible) {
      issues.push(`${ref}: labelled feasible but the oracle reports ${verdict.reasons.length} finding(s)`);
    }
    if (scenario.kind === 'overload' && verdict.demandMinutes <= verdict.availableMinutes) {
      issues.push(
        `${ref}: labelled overload but demand ${verdict.demandMinutes} fits in capacity ${verdict.availableMinutes}`,
      );
    }
    if (scenario.kind === 'dst') {
      // `toEpochMs`, not `Date.parse`: the shared parser throws on an
      // unparseable instant, where `Date.parse` returns NaN — and NaN compares
      // false against everything, so a malformed horizon would have made every
      // DST row look like it straddled nothing and the gate would have blamed
      // the row for a defect in its timestamps.
      const straddles = scenario.constraints.workingWindows.some((window) =>
        zoneOffsetMs(toEpochMs(scenario.constraints.horizon.startsAt), window.timezone)
        !== zoneOffsetMs(toEpochMs(scenario.constraints.horizon.endsAt), window.timezone));
      if (!straddles) {
        // A `dst` row whose horizon sits inside one offset tests nothing, and a
        // tzdata update that moved a transition would turn every DST case into
        // that silently. Read off the runtime rather than from a table.
        issues.push(`${ref}: labelled dst but no window zone changes offset inside the horizon`);
      }
    }
    if (scenario.kind === 'change') {
      const match = /^(.*)-(before|after)$/.exec(scenario.scenarioId);
      if (match === null) {
        issues.push(`${ref}: a change scenario must be named '<stem>-before' or '<stem>-after'`);
      } else {
        const counterpart = scenarios.find(
          (candidate) => candidate.scenarioId === `${match[1]}-${match[2] === 'before' ? 'after' : 'before'}`,
        );
        if (counterpart === undefined) {
          issues.push(`${ref}: has no counterpart, so the churn it exists to measure has nothing to measure against`);
        } else if (counterpart.constraints.scopeId !== scenario.constraints.scopeId) {
          issues.push(`${ref}: its counterpart describes a different scope`);
        }
      }
    }
  });

  /* Corpus-level. */

  for (const kind of PLANNING_SCENARIO_KINDS) {
    if ((coverage.get(kind) ?? 0) === 0) issues.push(`no scenario covers the '${kind}' kind`);
  }

  const multilingual = scenarios.filter((scenario) => scenario.kind === 'multilingual');
  const languages = new Set(multilingual.map((scenario) => scenario.locale.split('-')[0]));
  for (const language of ['ar', 'he', 'en']) {
    if (!languages.has(language)) {
      issues.push(`the multilingual kind covers no '${language}' locale`);
    }
  }

  if (!scenarios.some((scenario) => scenario.lockState === 'locked')) {
    issues.push('no scenario is locked; a corpus with nothing held out has no hold-out');
  }
  if (!scenarios.some((scenario) => scenario.lockState === 'tunable')) {
    issues.push('no scenario is tunable; there would be nothing to fit against');
  }

  return Object.freeze(issues);
}

/**
 * Build a corpus, or refuse.
 *
 * Refuses rather than reports because a `PlanningScenarioCorpus` in a caller's
 * hands is a claim that its rows check out. A corpus that assembled with issues
 * attached would put the burden of noticing on every consumer, and the one that
 * forgot would be the one measuring something.
 */
export function assemblePlanningCorpus(scenarios: readonly PlanningScenario[]): PlanningScenarioCorpus {
  const issues = scenarioCorpusIssues(scenarios);
  if (issues.length > 0) {
    throw new Error(`planning scenario corpus: ${issues.length} issue(s)\n  - ${issues.join('\n  - ')}`);
  }

  // Frozen before the partition is taken, not after: a row edited between the
  // two would land in a list its own `lockState` disagrees with.
  const ordered = scenarios
    .slice()
    .sort((left, right) => byCodeUnit(left.scenarioId, right.scenarioId))
    .map(deepFreeze);
  const coverageByKind = {} as Record<PlanningScenarioKind, number>;
  for (const kind of PLANNING_SCENARIO_KINDS) coverageByKind[kind] = 0;
  for (const scenario of ordered) coverageByKind[scenario.kind] += 1;

  // Partitioned by reading the field off the row. Nothing consults the id, the
  // declaration order, or which array a row arrived in.
  const locked = ordered.filter((scenario): scenario is LockedScenario => scenario.lockState === 'locked');
  const tunable = ordered.filter((scenario): scenario is TunableScenario => scenario.lockState === 'tunable');

  return Object.freeze({
    provenance: 'synthetic',
    version: PLANNING_SCENARIO_CORPUS_VERSION,
    scenarios: Object.freeze(ordered),
    locked: Object.freeze(locked),
    tunable: Object.freeze(tunable),
    coverageByKind: Object.freeze(coverageByKind),
    digest: sha256Hex(canonicalJson({ provenance: 'synthetic', version: PLANNING_SCENARIO_CORPUS_VERSION, scenarios: ordered })),
  });
}

/** The curated rows plus the default generated ones, assembled. */
export function defaultPlanningScenarioCorpus(): PlanningScenarioCorpus {
  return assemblePlanningCorpus(
    (CURATED_PLANNING_SCENARIOS as readonly PlanningScenario[]).concat(
      generatePlanningScenarios({ seed: DEFAULT_SCENARIO_SEED, count: DEFAULT_GENERATED_SCENARIO_COUNT }),
    ),
  );
}

/* ── Selection ───────────────────────────────────────────────────── */

/**
 * The scenarios tuning may see.
 *
 * Re-reads `lockState` off every row it is about to return and **throws**,
 * naming the row, rather than filtering. A filter would repair the leak and
 * hide it, so a corpus assembled somewhere else would quietly stop holding
 * anything out and every subsequent score would be fitted to its own test set.
 *
 * **What this check is, precisely.** For a corpus built by
 * `assemblePlanningCorpus`, it is a tautology: that function fills `tunable` by
 * filtering on the same field this reads, so it cannot fail. It is not a second
 * independent judgement and must not be described as one. It is a **boundary
 * guard**, and it earns its place at exactly one kind of caller — a
 * `PlanningScenarioCorpus` that did not come from `assemblePlanningCorpus`:
 * parsed from JSON, rebuilt by a merge, or produced by a cast. Those are the
 * paths where `TunableScenario` was never enforced, and they are the paths a
 * hold-out actually leaks through.
 *
 * The guarantee for in-process corpora is carried by two other things instead:
 * the partition is derived from the row rather than from an id or a file, and
 * every row is deep-frozen so the field cannot be edited after the fact.
 */
export function selectTunableScenarios(corpus: PlanningScenarioCorpus): readonly TunableScenario[] {
  const leaked = corpus.tunable.filter((scenario) => scenario.lockState !== 'tunable');
  if (leaked.length > 0) {
    throw new Error(
      'planning scenario corpus: locked scenario(s) present in the tunable partition: '
        + leaked.map((scenario) => scenario.scenarioId).join(', '),
    );
  }
  return corpus.tunable;
}

/**
 * The held-out scenarios. Symmetric refusal — a tunable row here is the same
 * leak seen from the other side — and the same boundary guard, with the same
 * limits as `selectTunableScenarios`.
 */
export function selectLockedScenarios(corpus: PlanningScenarioCorpus): readonly LockedScenario[] {
  const leaked = corpus.locked.filter((scenario) => scenario.lockState !== 'locked');
  if (leaked.length > 0) {
    throw new Error(
      'planning scenario corpus: tunable scenario(s) present in the locked partition: '
        + leaked.map((scenario) => scenario.scenarioId).join(', '),
    );
  }
  return corpus.locked;
}
