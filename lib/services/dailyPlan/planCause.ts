/**
 * Which monitor caused this plan (#527, AC 2).
 *
 * The issue's rule is that every user-affecting background action is
 * attributable to `monitor/watcher → condition → policy → resulting action`.
 * `lib/watchers/backgroundAttribution.ts` answers that question *given the
 * change ids*; `StoredDailyPlan.causeChangeIds` is where an automatic replan
 * leaves them. This module is the hop between the two, and deliberately
 * nothing more: it reads the plan, hands the ids it finds to the existing
 * joiner, and returns what comes back.
 *
 * ── Why there is no second joiner here ────────────────────────────
 *
 * The chain lives on the `WatcherFireEvent` and has since #525. Rebuilding it
 * from the plan side would be a second answer to one question, kept in step by
 * hand, able to disagree with the firing it describes — which on a Trust
 * surface is worse than no answer. So the matching, the ordering and the
 * account scoping are all `attributionsForArtifacts`', and this file owns only
 * the read of the plan document.
 *
 * ── A missing cause is a real answer ──────────────────────────────
 *
 * Three different plans legitimately have no cause: one written before the
 * field existed, a morning build, and a rebuild the person asked for. None of
 * them is an error and none of them may throw — a screen that refused to
 * render when a plan predated a field would hide exactly what it exists to
 * show. `causeChangeIdsOf` therefore answers `[]` for anything that is not
 * wholly a list of non-empty strings, including a document whose stored value
 * is damaged in part. The one case that is *not* an empty cause is a date with no plan at
 * all: `planCause` answers null there, because "there is nothing to attribute"
 * and "this was not caused by a monitor" are different facts.
 */
import type { BackgroundActionAttribution } from '../../../src/contracts/v1/backgroundMonitorContracts';
import { attributionsForArtifacts } from '../../watchers/backgroundAttribution';
import type { StorageAdapter } from '../../storage';
import { readStoredPlan, type StoredDailyPlan } from './planStore';

export interface StoredPlanCause {
  readonly date: string;
  readonly generation: number;
  /**
   * The changes whose own impact required this generation; empty when it had
   * none. Narrower than the batch the replan processed — a change that shared
   * the sweep but was evaluated `NO_EFFECT` is not reported here, because a
   * monitor that did nothing must not be named as a reason the day moved.
   */
  readonly causeChangeIds: readonly string[];
  /**
   * The monitors behind those ids. Shorter than `causeChangeIds` whenever a
   * cause was not a watcher's doing — a calendar refresh is a real cause and
   * no firing claims it — and that asymmetry is deliberate: reporting a null
   * row per unclaimed id would make somebody else's record look like a broken
   * monitor.
   */
  readonly attributions: readonly BackgroundActionAttribution[];
}

export interface PlanCauseDeps {
  readonly storage?: StorageAdapter;
}

/**
 * The causes a stored plan declares, tolerant of every document that has none.
 *
 * All-or-nothing on purpose. A value that is a list but whose members are not
 * all ids is damaged, and the tempting move — keep the readable ones — would
 * hand back a *shorter* cause list with no sign that anything was dropped,
 * which on a Trust surface reads as "these are the monitors" rather than
 * "some of the monitors". Absent provenance is the honest answer to unreadable
 * provenance, so a partially damaged list answers `[]` exactly as a wholly
 * wrong type does.
 */
export function causeChangeIdsOf(plan: StoredDailyPlan): readonly string[] {
  const raw: unknown = (plan as { causeChangeIds?: unknown }).causeChangeIds;
  if (!Array.isArray(raw)) return [];
  if (!raw.every((id): id is string => typeof id === 'string' && id.length > 0)) return [];
  return raw as readonly string[];
}

/**
 * The stored plan's own answer to "which monitor caused me".
 *
 * Null when no plan exists for the date. Otherwise the ids it recorded and the
 * firings that claim them, joined by the projection that owns that join.
 */
export async function planCause(
  uid: string,
  date: string,
  deps: PlanCauseDeps = {},
): Promise<StoredPlanCause | null> {
  const plan = await readStoredPlan(uid, date, deps.storage);
  if (!plan) return null;
  const causeChangeIds = causeChangeIdsOf(plan);
  return {
    date: plan.date,
    generation: plan.generation,
    causeChangeIds,
    // Returns `[]` for an empty list without reading anything.
    attributions: await attributionsForArtifacts(uid, causeChangeIds, { storage: deps.storage }),
  };
}
