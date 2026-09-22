/**
 * Who decided this, and under whose permission (#527's Rule).
 *
 * `backgroundMonitors.ts` answers "what is watching me". This answers the
 * other half of the issue: *every user-affecting background action must be
 * attributable to* `monitor/watcher → condition → policy → resulting action`,
 * and *no orphan autonomous work*.
 *
 * ── A projection, not a record ────────────────────────────────────
 *
 * Nothing here writes, and nothing new is written on the firing path.
 * `WatcherFireEvent` has carried all four links since #525 — `watcherId`,
 * `reason`, `policyDecision`, `effect` + `effectRef` — so the chain was always
 * recorded and what was missing was a way to ask it. Adding an attribution
 * store would have meant a second record of the same fact, kept in step by
 * hand, able to disagree with the firing it describes. There is no such store
 * and no reason for one.
 *
 * ── How a replan answers which monitor caused it ──────────────────
 *
 * This is the issue's acceptance criterion, and it is a join rather than a new
 * field. A `replan_if_impacted` firing writes a `PlanningStateChange` whose
 * `changeId` *is* the firing's `effectRef`; #524's `IncrementalPlanPatch`
 * carries those same ids in `causeChangeIds`. So a caller holding a patch
 * passes its `causeChangeIds` to `attributionsForArtifacts` and gets back the
 * monitors, conditions and policy decisions behind the replan.
 *
 * The last hop in the other direction is closed too, and closed on the write
 * side where it belongs: an automatic replan records its `causeChangeIds` on
 * the plan document it stores, and `lib/services/dailyPlan/planCause.ts` reads
 * them back and calls `attributionsForArtifacts` below. So "given only a plan,
 * which monitor caused it" is now answerable without the patch. Nothing here
 * changed for it: this file still writes nothing, and the plan-side hop is a
 * caller of this projection rather than a second copy of it.
 *
 * ── Orphans ───────────────────────────────────────────────────────
 *
 * The rule's second half is checkable, so it is checked: every artifact this
 * account holds that came from a watcher is matched against the firings, and
 * anything no firing claims is counted. Zero is the only healthy value. It is
 * *counted and reported*, never thrown — a Trust surface that refused to
 * render when something was wrong would hide exactly the thing it exists to
 * show — and the count is deliberately a number rather than a list, because
 * the ids of unattributable work are not a thing to hand a client.
 *
 * ── Content ───────────────────────────────────────────────────────
 *
 * The same rule as the monitor view: no provider tokens, no payloads, no
 * provider-authored text. `provenanceRef` is on every firing and is
 * deliberately not projected — it points into provider data, and handing a
 * client a pointer to the payload would reopen the hole the rest of #527
 * closes. `subjectRef` is likewise absent: it is opaque, but it is also the
 * one field that identifies *which* flight or thread is being watched, and a
 * history feed does not need it to say what happened.
 */
import {
  BACKGROUND_MONITOR_SCHEMA_VERSION,
  type BackgroundActionArtifact,
  type BackgroundActionArtifactKind,
  type BackgroundActionAttribution,
  type BackgroundAttributionView,
} from '../../src/contracts/v1/backgroundMonitorContracts';
import {
  WATCHER_EFFECT_CAPABILITIES,
  type PlanningStateChange,
  type WatcherEffect,
  type WatcherFireEvent,
} from '../../src/contracts/v1/watcherContracts';
import { getStorage, type StorageAdapter } from '../storage';
import {
  PLANNING_STATE_CHANGES,
  WATCHER_EVENTS,
  WATCHER_NOTIFICATIONS,
  WATCHER_PROPOSALS,
  userCol,
} from '../storage/paths';
import { monitorIdForWatcher } from './backgroundMonitors';

/** History is bounded so one long-lived account cannot make an unbounded read. */
export const ATTRIBUTION_DEFAULT_LIMIT = 50;
export const ATTRIBUTION_MAX_LIMIT = 200;

/**
 * Which artifact each effect produces.
 *
 * Derived from `WatcherEffect` rather than from the artifact that happens to
 * be there, so a firing whose artifact write failed still reports what it was
 * *supposed* to produce — which is the honest answer and the one that makes
 * the missing artifact visible instead of silently reclassifying the action.
 *
 * `update_context` has no artifact by design: the absorbed baseline is the
 * effect. That is a real case, not a missing write, and it gets its own kind
 * rather than being reported as `none` — which is reserved for a firing the
 * policy refused.
 */
const ARTIFACT_KIND_BY_EFFECT: Readonly<Record<WatcherEffect, BackgroundActionArtifactKind>> = Object.freeze({
  notify: 'notification',
  propose_commitment: 'proposal',
  replan_if_impacted: 'state_change',
  update_context: 'context_update',
});

/** `<provider>:<signalKind>`, the code `BackgroundMonitorView.label` carries. */
function labelOf(event: WatcherFireEvent): string {
  return `${event.provider}:${event.signalKind}`;
}

function artifactOf(event: WatcherFireEvent): BackgroundActionArtifact {
  // The policy refused it, so nothing ran and there is nothing to point at.
  // Still projected: "the guard stopped this" is precisely what the rule
  // exists to make visible.
  if (event.outcome === 'policy_blocked') return { kind: 'none', ref: null };
  return { kind: ARTIFACT_KIND_BY_EFFECT[event.effect] ?? 'none', ref: event.effectRef };
}

/** One firing, as the chain that authorized it. Pure; no reads. */
export function projectAttribution(event: WatcherFireEvent): BackgroundActionAttribution {
  return {
    actionId: event.eventId,
    monitorId: monitorIdForWatcher(event.watcherId),
    watcherId: event.watcherId,
    label: labelOf(event),
    observedAt: event.observedAt,
    occurredAt: event.firedAt,
    condition: event.reason,
    // Read from the effect's own capability table, not from anything the
    // firing stored: the binding between an effect and the capability it needs
    // is policy, and a historical record of what the table said at the time
    // would let the two drift without anybody noticing.
    capability: WATCHER_EFFECT_CAPABILITIES[event.effect],
    policyDecision: event.policyDecision,
    effect: event.effect,
    artifact: artifactOf(event),
  };
}

export interface AttributionDeps {
  readonly storage?: StorageAdapter;
}

function boundedLimit(requested: number | undefined): number {
  if (requested === undefined) return ATTRIBUTION_DEFAULT_LIMIT;
  if (!Number.isInteger(requested) || requested < 1) return ATTRIBUTION_DEFAULT_LIMIT;
  return Math.min(requested, ATTRIBUTION_MAX_LIMIT);
}

/** Every firing this account has recorded, newest first, bounded. */
async function readFirings(
  uid: string,
  storage: StorageAdapter,
  limit: number,
): Promise<readonly WatcherFireEvent[]> {
  const rows = await storage.list<WatcherFireEvent>(userCol(uid, WATCHER_EVENTS), {
    orderBy: { field: 'firedAt', direction: 'desc' },
    limit,
  });
  return rows.map((row) => row.data);
}

/**
 * Artifacts this account holds that no firing claims.
 *
 * Counted over the three collections a watcher effect writes into. A
 * `PlanningStateChange` whose `source` is not `watcher` is somebody else's
 * record — a commitment edit, a calendar sync — and is not autonomous work
 * this rule governs, so it is not an orphan and is not counted.
 *
 * The firings are read unbounded *for this check only*, because "is there
 * anything unattributable" cannot be answered from a page: a single orphan
 * outside the window would read as zero, which is the one wrong answer this
 * function must never give.
 */
export async function countOrphanBackgroundActions(
  uid: string,
  deps: AttributionDeps = {},
): Promise<number> {
  const storage = deps.storage ?? getStorage();
  const firings = await storage.list<WatcherFireEvent>(userCol(uid, WATCHER_EVENTS));
  const claimed = new Set(
    firings
      .map((row) => row.data.effectRef)
      .filter((ref): ref is string => typeof ref === 'string' && ref.length > 0),
  );

  let orphans = 0;
  for (const collection of [WATCHER_NOTIFICATIONS, WATCHER_PROPOSALS] as const) {
    const rows = await storage.list<{ readonly notificationId?: string; readonly proposalId?: string }>(
      userCol(uid, collection),
    );
    for (const row of rows) {
      const ref = row.data.notificationId ?? row.data.proposalId ?? row.id;
      if (!claimed.has(ref)) orphans += 1;
    }
  }
  const changes = await storage.list<PlanningStateChange>(userCol(uid, PLANNING_STATE_CHANGES));
  for (const row of changes) {
    // Only watcher-sourced changes are autonomous work. A commitment edit is
    // the user's own act and is attributable to them by definition.
    if (row.data.source !== 'watcher') continue;
    if (!claimed.has(row.data.changeId)) orphans += 1;
  }
  return orphans;
}

/**
 * The account's recent background actions, each with its full chain.
 *
 * Ordered newest first by the store, and tie-broken on `actionId` so two reads
 * of an unchanged account are byte identical — several firings can share a
 * `firedAt` when one sweep fires several watchers, and a list whose rows swap
 * between reads makes both client diffing and fixture stability unreliable.
 */
export async function listBackgroundAttribution(
  uid: string,
  options: { readonly limit?: number } = {},
  deps: AttributionDeps = {},
): Promise<BackgroundAttributionView> {
  const storage = deps.storage ?? getStorage();
  const firings = await readFirings(uid, storage, boundedLimit(options.limit));
  const actions = firings
    .map(projectAttribution)
    .sort((left, right) => {
      const byTime = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
      if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
      return left.actionId < right.actionId ? -1 : left.actionId > right.actionId ? 1 : 0;
    });
  return {
    schemaVersion: BACKGROUND_MONITOR_SCHEMA_VERSION,
    actions,
    orphanCount: await countOrphanBackgroundActions(uid, { storage }),
  };
}

/**
 * The chain behind specific artifacts — the replan question, answered.
 *
 * A caller holding an `IncrementalPlanPatch` passes its `causeChangeIds` and
 * gets back the monitors that caused the replan. Refs that match nothing come
 * back absent rather than as a null row: "no firing claims this" is what
 * `countOrphanBackgroundActions` is for, and a caller asking about one artifact
 * should not have to distinguish "not yours" from "not attributable".
 *
 * Scoped before it is matched, like every other read here: the firings are
 * this account's, so a ref belonging to somebody else matches nothing.
 */
export async function attributionsForArtifacts(
  uid: string,
  refs: readonly string[],
  deps: AttributionDeps = {},
): Promise<readonly BackgroundActionAttribution[]> {
  if (refs.length === 0) return [];
  const storage = deps.storage ?? getStorage();
  const wanted = new Set(refs);
  const firings = await storage.list<WatcherFireEvent>(userCol(uid, WATCHER_EVENTS));
  return firings
    .map((row) => row.data)
    .filter((event) => event.effectRef !== null && wanted.has(event.effectRef))
    .map(projectAttribution)
    .sort((left, right) => (left.actionId < right.actionId ? -1 : left.actionId > right.actionId ? 1 : 0));
}
