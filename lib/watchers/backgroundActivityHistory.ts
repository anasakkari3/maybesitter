/**
 * User-visible background monitoring history read model (#527).
 *
 * User-visible history should be bounded and content-light:
 * - watcher condition changed;
 * - notification sent;
 * - plan reconsidered.
 * No raw provider payloads.
 *
 * ── A projection, not a separate execution system ──────────────────
 *
 * Reuses existing architecture:
 * - Watchers and their runtimes (`users/{uid}/watchers`)
 * - Integration connection records (`users/{uid}/providerConnections`)
 * - Watcher firings (`users/{uid}/watcherEvents`)
 * - Plan events (`users/{uid}/planEvents`)
 * - Action Policy & Action attributions
 */
import { createHash } from 'node:crypto';
import {
  BACKGROUND_MONITOR_SCHEMA_VERSION,
  type BackgroundActionAttribution,
  type BackgroundActivityHistoryView,
  type BackgroundMonitorHistoryItem,
  type BackgroundMonitorHistoryKind,
} from '../../src/contracts/v1/backgroundMonitorContracts';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts';
import type { WatcherFireEvent } from '../../src/contracts/v1/watcherContracts';
import { getStorage, type StorageAdapter } from '../storage';
import {
  PLAN_EVENTS,
  PROVIDER_CONNECTIONS,
  WATCHER_EVENTS,
  userCol,
  userSubDoc,
} from '../storage/paths';
import { attributionsForArtifacts } from './backgroundAttribution';
import {
  backgroundMonitorStatusOf,
  monitorIdForWatcher,
} from './backgroundMonitors';
import { readMonitoringSettings } from './monitoringSettings';
import { createWatcherStore, type StoredWatcher } from './watcherStore';

export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 200;

export interface BackgroundHistoryOptions {
  readonly limit?: number;
  readonly watcherId?: string;
  readonly kind?: BackgroundMonitorHistoryKind;
}

export interface BackgroundHistoryDeps {
  readonly storage?: StorageAdapter;
}

function stableHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function boundedLimit(requested: number | undefined): number {
  if (requested === undefined) return HISTORY_DEFAULT_LIMIT;
  if (!Number.isInteger(requested) || requested < 1) return HISTORY_DEFAULT_LIMIT;
  return Math.min(requested, HISTORY_MAX_LIMIT);
}

interface StoredPlanEventRow {
  readonly id: string;
  readonly type: string;
  readonly date: string;
  readonly at: string;
  readonly generation: number;
  readonly causeChangeIds?: readonly string[];
}

export async function listBackgroundActivityHistory(
  uid: string,
  options: BackgroundHistoryOptions = {},
  deps: BackgroundHistoryDeps = {},
): Promise<BackgroundActivityHistoryView> {
  const storage = deps.storage ?? getStorage();
  const settings = await readMonitoringSettings(uid, { storage });
  const watchers = await createWatcherStore(uid, storage).list();

  // 1. Connection records
  const connectionIds = Array.from(new Set(
    watchers
      .map((w) => w.definition.source.connectionId)
      .filter((id): id is string => id !== null),
  ));
  const connections = new Map<string, IntegrationConnectionRecord | null>();
  for (const connectionId of connectionIds) {
    const record = await storage.get<IntegrationConnectionRecord>(
      userSubDoc(uid, PROVIDER_CONNECTIONS, connectionId),
    );
    connections.set(connectionId, record ?? null);
  }

  const watchersById = new Map<string, StoredWatcher>();
  for (const watcher of watchers) {
    watchersById.set(watcher.definition.watcherId, watcher);
  }

  // 2. Read firings
  const firingsRows = await storage.list<WatcherFireEvent>(userCol(uid, WATCHER_EVENTS), {
    orderBy: { field: 'firedAt', direction: 'desc' },
    limit: HISTORY_MAX_LIMIT,
  });
  const firings = firingsRows.map((r) => r.data);

  // 3. Read plan events for replan attribution
  const planEventRows = await storage.list<StoredPlanEventRow>(userCol(uid, PLAN_EVENTS), {
    orderBy: { field: 'at', direction: 'desc' },
    limit: HISTORY_MAX_LIMIT,
  });
  const planEvents = planEventRows.map((r) => r.data);

  // Collect all causeChangeIds from planEvents and join through attributionsForArtifacts
  const allCauseChangeIds = Array.from(
    new Set(
      planEvents
        .filter((pe) => pe.type === 'plan_regenerated' || pe.type === 'plan_proposed')
        .flatMap((pe) => (Array.isArray(pe.causeChangeIds) ? pe.causeChangeIds : [])),
    ),
  );

  const attributions = await attributionsForArtifacts(uid, allCauseChangeIds, { storage });
  const attributionsByChangeId = new Map<string, BackgroundActionAttribution>();
  for (const attr of attributions) {
    if (attr.artifact.ref) {
      attributionsByChangeId.set(attr.artifact.ref, attr);
    }
  }

  const items: BackgroundMonitorHistoryItem[] = [];
  const seenItemIds = new Set<string>();

  const pushItem = (item: BackgroundMonitorHistoryItem) => {
    if (!seenItemIds.has(item.itemId)) {
      seenItemIds.add(item.itemId);
      items.push(item);
    }
  };

  // Row Type 1 & 2: From firings
  for (const event of firings) {
    const watcher = watchersById.get(event.watcherId);
    const connection = watcher?.definition.source.connectionId
      ? connections.get(watcher.definition.source.connectionId) ?? null
      : null;
    const status = watcher ? backgroundMonitorStatusOf(watcher, connection) : 'paused';
    const label = `${event.provider}:${event.signalKind}`;
    const title = watcher?.definition.label ?? null;
    const monitorId = monitorIdForWatcher(event.watcherId);

    if (event.effect === 'notify' && event.outcome === 'effected') {
      pushItem({
        itemId: `his_notif_${event.eventId}`,
        monitorId,
        watcherId: event.watcherId,
        label,
        title,
        occurredAt: event.firedAt,
        kind: 'notification_sent',
        status,
        description: 'notification_sent',
        effect: 'notify',
        artifactRef: event.effectRef,
      });
    } else {
      pushItem({
        itemId: `his_cond_${event.eventId}`,
        monitorId,
        watcherId: event.watcherId,
        label,
        title,
        occurredAt: event.firedAt,
        kind: 'watcher_condition_changed',
        status,
        description: event.outcome === 'policy_blocked' ? 'policy_blocked' : event.reason,
        effect: event.effect,
        artifactRef: event.effectRef,
      });
    }
  }

  // Row Type 3: plan reconsidered (plan events with causeChangeIds matching firings joined through attributionsForArtifacts)
  for (const pe of planEvents) {
    if (pe.type !== 'plan_regenerated' && pe.type !== 'plan_proposed') continue;
    if (!Array.isArray(pe.causeChangeIds)) continue;

    for (const causeId of pe.causeChangeIds) {
      const matchedAttribution = attributionsByChangeId.get(causeId);
      if (!matchedAttribution) continue;

      const watcher = watchersById.get(matchedAttribution.watcherId);
      const connection = watcher?.definition.source.connectionId
        ? connections.get(watcher.definition.source.connectionId) ?? null
        : null;
      const status = watcher ? backgroundMonitorStatusOf(watcher, connection) : 'active';
      const title = watcher?.definition.label ?? null;

      pushItem({
        itemId: `his_pr_${stableHash(`${pe.id}:${causeId}`)}`,
        monitorId: matchedAttribution.monitorId,
        watcherId: matchedAttribution.watcherId,
        label: matchedAttribution.label,
        title,
        occurredAt: pe.at,
        kind: 'plan_reconsidered',
        status,
        description: pe.type === 'plan_proposed' ? 'replan_proposed' : 'replan_applied',
        effect: 'replan_if_impacted',
        artifactRef: pe.date,
      });
    }
  }

  // Filter if requested
  let filtered = items;
  if (options.watcherId) {
    const id = options.watcherId;
    filtered = filtered.filter((i) => i.watcherId === id || i.monitorId === id);
  }
  if (options.kind) {
    filtered = filtered.filter((i) => i.kind === options.kind);
  }

  // Sort newest first by occurredAt, tie-broken deterministically on itemId.
  // Code-unit order, not `localeCompare`: the list is truncated below, so a
  // host-locale tie-break would decide which rows the user sees (#121).
  filtered.sort((left, right) => {
    const timeDiff = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    if (timeDiff !== 0 && !Number.isNaN(timeDiff)) return timeDiff;
    return left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0;
  });

  const limit = boundedLimit(options.limit);
  return {
    schemaVersion: BACKGROUND_MONITOR_SCHEMA_VERSION,
    paused: settings.paused,
    items: filtered.slice(0, limit),
  };
}
