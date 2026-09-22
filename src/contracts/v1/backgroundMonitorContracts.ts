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
 * client localizes them. A human-readable name for a monitor would need a
 * title on the watcher, which `WatcherDefinition` does not have.
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
