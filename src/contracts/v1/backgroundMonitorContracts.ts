/**
 * What the user is told about work this app does without being asked (#527).
 *
 * A **read projection** over Watchers (#525) and integration connections, and
 * nothing else: no store, no scheduler, no second execution system. The engine
 * stays the one thing that decides whether a watcher runs; this says what that
 * decision currently is, in words a Trust screen can show.
 *
 * ── Why the status vocabulary is not `WatcherStatus` ──────────────
 *
 * `WatcherStatus` is three values — active, paused, blocked — with the reason
 * carried separately in `blockedReason`. That is the right shape for the
 * engine, which acts on "may this run", and the wrong shape here, because a
 * user reading "blocked" learns nothing they can act on. The two reasons a
 * person can *do* something about are split out (`needs_reauth` sends them to
 * reconnect, `blocked_permission` to grant), and the one they cannot is named
 * `error` rather than dressed up as a permission problem.
 *
 * ── What may never appear here ────────────────────────────────────
 *
 * No provider tokens, no credential references, no provider payloads, no
 * provider API field names, and no free text the provider authored. The issue
 * states it as a rule and `tests/watchers/backgroundMonitors.test.ts` asserts
 * it over the whole serialized response rather than field by field, because a
 * field-by-field check only covers the fields somebody remembered.
 *
 * Every string below is therefore either an identifier this system minted, an
 * instant, or a value from a closed vocabulary declared in this file or in
 * `watcherContracts`. `label` and `purpose` are **codes, not sentences**: the
 * client localizes them. The one exception is `title`: the name the user gave
 * the watcher (`WatcherDefinition.label`, #527), their own words shown back to
 * them. It is never provider-authored, and it is a separate field so that
 * `label` stays a code the client can always localize.
 */
import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const BACKGROUND_MONITOR_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const BACKGROUND_MONITOR_SCHEMA_VERSION = 'background-monitor-v1' as const;

/**
 * What this monitor is doing, as the user needs to understand it.
 *
 * - `active` — it is running and will look again.
 * - `paused` — the user turned it off; nothing is wrong.
 * - `blocked_permission` — the connection it reads through is not connected
 *   (never connected, revoked, disconnected, still connecting). The action is
 *   to connect it.
 * - `needs_reauth` — the connection exists but the grant lapsed or was
 *   narrowed. The action is to re-authorize.
 * - `error` — it cannot run for a reason the user cannot fix, such as no
 *   observer being registered for the signal it names.
 */
export const BACKGROUND_MONITOR_STATUSES = Object.freeze([
  'active',
  'paused',
  'blocked_permission',
  'needs_reauth',
  'error',
] as const);

export type BackgroundMonitorStatus = (typeof BACKGROUND_MONITOR_STATUSES)[number];

/**
 * Why the monitor is watching, as a closed code.
 *
 * One per `WatchCondition` kind. A sentence would either be English-only or
 * carry the threshold's metric name into a string, and the metric is a
 * normalized vocabulary the client already knows how to name.
 */
export const BACKGROUND_MONITOR_PURPOSES = Object.freeze([
  'notice_any_change',
  'notice_threshold_crossed',
] as const);

export type BackgroundMonitorPurpose = (typeof BACKGROUND_MONITOR_PURPOSES)[number];

export interface BackgroundMonitorView {
  /**
   * Stable per monitor. Today every monitor is a watcher and this is
   * `mon_<watcherId>`, prefixed rather than equal so a future monitor that is
   * not a watcher cannot collide with one that is, and so a client that
   * sends this back somewhere expecting a watcher id fails loudly.
   */
  readonly monitorId: string;
  /** The watcher this projects, or null for a monitor that is not one. */
  readonly watcherId: string | null;
  /** The connection it reads through, or null when the signal needs no grant. */
  readonly connectionId: string | null;
  /**
   * A code the client localizes: `<provider>:<signalKind>`, both closed
   * vocabularies. Not a title — see the file note.
   */
  readonly label: string;
  /** The name the user gave the watcher, or null when they gave none. Rendered verbatim. */
  readonly title: string | null;
  readonly status: BackgroundMonitorStatus;
  readonly purpose: BackgroundMonitorPurpose;
  /**
   * What it is allowed to do when the condition fires — `WatcherEffect`
   * values. An array because the issue asks for one and a watcher may
   * one day carry more than a single effect; today it always holds exactly
   * one, and an empty array would mean a monitor that can do nothing.
   */
  readonly effects: readonly string[];
  /** When it last looked at the subject. Null before its first observation. */
  readonly lastCheckedAt: string | null;
  /** When it last found a change worth acting on. Null if it never has. */
  readonly lastChangedAt: string | null;
  /**
   * When it will look next, or null when it will not: a paused, blocked or
   * errored monitor is visited by the sweep but returns before observing
   * anything, and telling the user it is about to check would be false.
   */
  readonly nextCheckAt: string | null;
  /** Whether "Pause" applies. False for one already paused — that row resumes. */
  readonly canPause: boolean;
  readonly canDelete: boolean;
}

export interface BackgroundActivityView {
  readonly schemaVersion: typeof BACKGROUND_MONITOR_SCHEMA_VERSION;
  /** Whether background monitoring is globally paused for this account. */
  readonly paused: boolean;
  readonly monitors: readonly BackgroundMonitorView[];
}

export function isBackgroundMonitorStatus(value: unknown): value is BackgroundMonitorStatus {
  return typeof value === 'string'
    && (BACKGROUND_MONITOR_STATUSES as readonly string[]).includes(value);
}

export function isBackgroundMonitorPurpose(value: unknown): value is BackgroundMonitorPurpose {
  return typeof value === 'string'
    && (BACKGROUND_MONITOR_PURPOSES as readonly string[]).includes(value);
}

/* ── Attribution (#527's Rule) ────────────────────────────────────── */

/**
 * The issue's rule, as a type: *every user-affecting background action must be
 * attributable to* `monitor/watcher → condition → policy → resulting action`,
 * and *no orphan autonomous work*.
 *
 * `BackgroundMonitorView` above answers "what is watching me, right now".
 * This answers the other half — "this thing happened; who decided it, on what
 * evidence, and under whose permission" — and it is a different question with
 * a different lifetime: a monitor is current state, an attribution is a fact
 * about the past that stays true after the monitor is paused or deleted.
 *
 * ── Nothing here is a new record ──────────────────────────────────
 *
 * This is a projection of `WatcherFireEvent`, which has carried all four links
 * since #525: `watcherId` is the monitor, `reason` is the condition,
 * `policyDecision` is the policy, and `effect` + `effectRef` are the resulting
 * action and the artifact it produced. The chain was always recorded; what was
 * missing was a way to *ask* it. So there is no attribution store, no new
 * write on the firing path, and nothing for the engine to keep in step — which
 * is also why an attribution cannot drift from the firing it describes.
 *
 * ── A blocked firing is attributable too ──────────────────────────
 *
 * `policy_blocked` produces no artifact, and it is still recorded and still
 * projected. "The policy refused this" is exactly the kind of thing the rule
 * exists to make visible: an audit that listed only the actions that happened
 * would be unable to show that the guard ever did anything.
 *
 * ── The same content rule as above ────────────────────────────────
 *
 * No provider payloads, no tokens, no provider-authored text. `label` is the
 * same `<provider>:<signalKind>` code `BackgroundMonitorView` carries, and the
 * refs are identifiers this system minted. `provenanceRef` is deliberately
 * **not** here: it points into provider data, and a Trust surface that handed
 * the client a pointer to the payload would have re-opened the hole the rest
 * of this file closes.
 */

/** What the effect actually produced. `none` is a firing the policy refused. */
export type BackgroundActionArtifactKind =
  | 'notification'
  | 'proposal'
  | 'state_change'
  | 'context_update'
  | 'none';

export interface BackgroundActionArtifact {
  readonly kind: BackgroundActionArtifactKind;
  /**
   * The artifact's own id, or null when nothing was produced.
   *
   * For `state_change` this is the `PlanningStateChange.changeId` — which is
   * the id an `IncrementalPlanPatch` carries in `causeChangeIds`. That
   * correspondence is what lets a replan answer which monitor caused it:
   * the patch names the change, and `attributionsForArtifacts` turns the
   * change back into a monitor. See `lib/watchers/backgroundAttribution.ts`.
   */
  readonly ref: string | null;
}

/**
 * One background action, with the whole chain that authorized it.
 *
 * `actionId` is the firing's own event id, derived from `(watcherId,
 * signalId)` — so it is stable, and asking twice about one action gives one
 * answer rather than two rows for one event.
 */
export interface BackgroundActionAttribution {
  readonly actionId: string;
  /** The monitor, as `BackgroundMonitorView.monitorId` spells it. */
  readonly monitorId: string;
  readonly watcherId: string;
  /** `<provider>:<signalKind>`, the same code the monitor view carries. */
  readonly label: string;
  /** When the signal was observed, and when the firing was recorded. */
  readonly observedAt: string;
  readonly occurredAt: string;
  /** The condition that fired, or the policy's reason when it refused. */
  readonly condition: string;
  /** The Action Policy capability this effect needed. */
  readonly capability: string;
  readonly policyDecision: string;
  /** The effect the watcher is configured for. */
  readonly effect: string;
  readonly artifact: BackgroundActionArtifact;
}

export interface BackgroundAttributionView {
  readonly schemaVersion: typeof BACKGROUND_MONITOR_SCHEMA_VERSION;
  /** Newest first, bounded. */
  readonly actions: readonly BackgroundActionAttribution[];
  /**
   * Artifacts this account holds that no firing claims — the rule's "no orphan
   * autonomous work", as a number a test and a screen can both read.
   *
   * Zero is the only healthy value. It is reported rather than thrown because
   * a Trust surface that refused to render when something was wrong would hide
   * exactly the thing it exists to show.
   */
  readonly orphanCount: number;
}

export function isBackgroundActionArtifactKind(value: unknown): value is BackgroundActionArtifactKind {
  return typeof value === 'string'
    && ['notification', 'proposal', 'state_change', 'context_update', 'none'].includes(value);
}

/* ── History (User-visible history feed #527) ────────────────────── */

/**
 * The closed vocabulary of user-visible monitor history event types (#527).
 *
 * - `watcher_condition_changed` — the condition evaluated differently or produced a change.
 * - `notification_sent` — a notification intent was queued/delivered.
 * - `plan_reconsidered` — an automatic or proposed replan was caused by this monitor.
 */
export const BACKGROUND_MONITOR_HISTORY_KINDS = Object.freeze([
  'watcher_condition_changed',
  'notification_sent',
  'plan_reconsidered',
] as const);

export type BackgroundMonitorHistoryKind = (typeof BACKGROUND_MONITOR_HISTORY_KINDS)[number];

export interface BackgroundMonitorHistoryItem {
  readonly itemId: string;
  readonly monitorId: string;
  readonly watcherId: string;
  /** The same `<provider>:<signalKind>` code as `BackgroundMonitorView.label`. */
  readonly label: string;
  /** The user's name for the watcher, as on `BackgroundMonitorView.title`. */
  readonly title: string | null;
  readonly occurredAt: string;
  readonly kind: BackgroundMonitorHistoryKind;
  readonly status: BackgroundMonitorStatus;
  readonly description: string;
  readonly effect: string | null;
  readonly artifactRef: string | null;
}

export interface BackgroundActivityHistoryView {
  readonly schemaVersion: typeof BACKGROUND_MONITOR_SCHEMA_VERSION;
  readonly paused: boolean;
  readonly items: readonly BackgroundMonitorHistoryItem[];
}

export function isBackgroundMonitorHistoryKind(value: unknown): value is BackgroundMonitorHistoryKind {
  return typeof value === 'string'
    && (BACKGROUND_MONITOR_HISTORY_KINDS as readonly string[]).includes(value);
}

