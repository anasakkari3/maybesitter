import { randomUUID } from 'node:crypto';
import type { GmailMessagePayload } from '../integrations/gmail/adapter';
import type { GoogleRuntime } from '../integrations/google/googleRuntime';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts';
import { connectionIdFor } from '../integrations/providers/production/storedConnectionStore';
import { resolveM5aCapabilities } from '../release/m5aControls';
import {
  INTELLIGENCE_OBSERVATIONS,
  INTELLIGENCE_SOURCE_MARKERS,
  PROVIDER_CONNECTIONS,
  userCol,
  userSubDoc,
} from '../storage';
import { analyzeSourceStaged } from './analyzeSource';
import {
  legacyMarkerIdFor,
  markerDecision,
  providerMarkerIdFor,
  type M5aMarker,
} from './m5aGmailScan';
import { observationId, type StoredObservation } from './observationStore';
import { isMonitoringPaused } from '../watchers/monitoringSettings';
import type { StorageAdapter, StorageTransaction } from '../storage/storageAdapter';

const CLAIM_MS = 120_000;

function markerPath(uid: string, markerId: string): string {
  return `${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${markerId}`;
}

function observationPath(uid: string, id: string): string {
  return `${userCol(uid, INTELLIGENCE_OBSERVATIONS)}/${id}`;
}

export async function legacyGmailArbitrationEnabled(runtime: GoogleRuntime): Promise<boolean> {
  const capabilities = await resolveM5aCapabilities({ storage: runtime.storage, env: runtime.env as Record<string, string | undefined> });
  return capabilities.emailSources;
}

export async function connectedGmailAccount(uid: string, runtime: GoogleRuntime): Promise<string | null> {
  const connection = await runtime.storage.get<IntegrationConnectionRecord>(
    userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')),
  );
  return connection?.identity.providerAccountId ?? null;
}

export interface ArbitratedMessageResult {
  readonly kind: 'processed' | 'skipped' | 'blocked';
  readonly observations: readonly StoredObservation[];
}

export interface GmailArbitrationMonitorGuard {
  readonly path: string;
  readonly generation: string;
  readonly leaseOwner?: string;
  readonly pauseEpoch?: number;
  readonly receivedAt?: string;
}

interface GuardedMonitor {
  enabled: boolean;
  generation: string;
  lease?: { owner: string; leaseUntil: string } | null;
  m5?: {
    pauseEpoch: number;
    pausedSince: string | null;
    enabledAt: string;
    excluded: Array<{ from: string; to: string }>;
  };
}

async function assertMonitorGuard(
  uid: string,
  guard: GmailArbitrationMonitorGuard,
  storage: StorageAdapter,
  tx?: StorageTransaction,
): Promise<void> {
  const reader = tx ?? storage;
  const [monitor, paused] = await Promise.all([
    reader.get<GuardedMonitor>(guard.path),
    isMonitoringPaused(uid, storage, tx),
  ]);
  if (!monitor?.enabled || monitor.generation !== guard.generation || paused) throw new Error('monitor_disabled');
  if (guard.pauseEpoch === undefined) return;
  const received = Date.parse(guard.receivedAt ?? '');
  if (!monitor.m5 || monitor.m5.pauseEpoch !== guard.pauseEpoch || monitor.m5.pausedSince
    || monitor.lease?.owner !== guard.leaseOwner
    || !Number.isFinite(received) || received < Date.parse(monitor.m5.enabledAt)
    || monitor.m5.excluded.some(interval => received >= Date.parse(interval.from) && received < Date.parse(interval.to))) {
    throw new Error('monitor_disabled');
  }
}

/**
 * The rollback/base readers claim the legacy key before analysis. This is the
 * only path they use while M5a email processing is live, so an M5a unit and a
 * legacy unit can never both spend model work for the same message.
 */
export async function analyzeArbitratedGmailMessage(
  uid: string,
  providerAccountId: string,
  message: GmailMessagePayload,
  runtime: GoogleRuntime,
  monitorGuard?: GmailArbitrationMonitorGuard,
): Promise<ArbitratedMessageResult> {
  const storage = runtime.storage;
  const legacyId = legacyMarkerIdFor(message.id);
  const path = markerPath(uid, legacyId);
  const owner = randomUUID();
  const claimed = await storage.runTransaction(async tx => {
    const [marker] = await Promise.all([
      tx.get<M5aMarker | Record<string, unknown>>(path),
      monitorGuard ? assertMonitorGuard(uid, monitorGuard, storage, tx) : Promise.resolve(),
    ]);
    const decision = markerDecision(marker, 'base', runtime.now().toISOString(), providerAccountId);
    if (decision === 'skip') return { kind: 'skipped' as const };
    if (decision === 'block') return { kind: 'blocked' as const };
    const providerMarkerId = (marker as M5aMarker | null)?.providerMarkerId
      ?? providerMarkerIdFor(uid, providerAccountId, message.id);
    const claim: M5aMarker = {
      ...((marker as M5aMarker | null) ?? {}),
      v: 2,
      state: 'claimed',
      owner,
      leaseUntil: new Date(runtime.now().getTime() + CLAIM_MS).toISOString(),
      providerAccountId,
      providerMarkerId,
    };
    tx.set(path, claim);
    return { kind: 'claimed' as const, providerMarkerId };
  });
  if (claimed.kind !== 'claimed') return { kind: claimed.kind, observations: [] };

  try {
    const content = [message.subject ?? '', message.text].filter(Boolean).join('\n');
    if (monitorGuard) await assertMonitorGuard(uid, monitorGuard, storage);
    const semantic = content.trim() && content.length <= 12_000
      ? await analyzeSourceStaged(uid, 'gmail', content, runtime.shareModel ? { generate: runtime.shareModel } : {})
      : [];
    const committed = await storage.runTransaction(async tx => {
      const [marker, _guard, ...existing] = await Promise.all([
        tx.get<M5aMarker>(path),
        monitorGuard ? assertMonitorGuard(uid, monitorGuard, storage, tx) : Promise.resolve(),
        ...semantic.map(item => tx.get<StoredObservation>(observationPath(uid, observationId('gmail', message.id, item)))),
      ]);
      if (marker?.state !== 'claimed' || marker.owner !== owner) return null;
      const observations: StoredObservation[] = [];
      semantic.forEach((item, index) => {
        const id = observationId('gmail', message.id, item);
        const record: StoredObservation = existing[index] ?? {
          ...item,
          id,
          source: 'gmail',
          sourceRef: message.id,
          observedAt: message.receivedAt,
          review: 'pending',
          reviewedAt: null,
          linkedMemoryId: null,
        };
        observations.push(record);
        if (!existing[index]) tx.create(observationPath(uid, id), record);
      });
      const done: M5aMarker = {
        ...marker,
        state: 'done',
        owner: undefined,
        leaseUntil: undefined,
        processedAt: runtime.now().toISOString(),
        outcome: content.length > 12_000 ? 'trimmed' : content.trim() ? 'analyzed' : 'empty',
        observationIds: observations.map(row => row.id),
        autoAddId: null,
      };
      tx.set(path, done);
      tx.set(markerPath(uid, claimed.providerMarkerId), done);
      return observations;
    });
    return committed ? { kind: 'processed', observations: committed } : { kind: 'blocked', observations: [] };
  } catch (error) {
    await storage.runTransaction(async tx => {
      const marker = await tx.get<M5aMarker>(path);
      if (marker?.state === 'claimed' && marker.owner === owner) tx.set(path, {
        ...marker, state: 'released', owner: undefined, leaseUntil: undefined,
      });
    });
    throw error;
  }
}
