import { randomUUID } from 'node:crypto';
import type { CalendarSource, BusySourceReplacementFence } from '../calendar/busyBlocks';
import {
  applyResumableBusyReplacementChunk, finalizeResumableBusyReplacement,
  REPLACEMENT_LEASE_MS, startResumableBusyReplacement,
} from '../calendar/busyBlocks';
import {
  fetchGoogleBusyTarget, GOOGLE_BUSY_SOURCE_ID, googleBusyTargetBlocks,
  guardGoogleBusyTargetAuthority,
} from '../integrations/google/googleCalendarBusy';
import type { GoogleRuntime } from '../integrations/google/googleRuntime';
import {
  BUSY_SOURCE_FENCES, CALENDAR_CHOICE, CALENDAR_SOURCES, DEVICE_STALE_STATE, INTELLIGENCE_GMAIL_SCANS,
  INTELLIGENCE_SOURCE_MARKERS, PROVIDER_CONNECTIONS, REGISTERED_DEVICE_SOURCES,
  docIdForKey, userCol, userDoc, userSubDoc,
} from '../storage';
import type { StorageTransaction } from '../storage/storageAdapter';
import { M5A_CONTROLS_PATH, parseM5aControls } from '../release/m5aControls';
import type { M5aMarker, M5aScanDocument } from './m5aGmailScan';
import type { GmailMonitor } from './gmailMonitor';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts';
import { connectionIdFor } from '../integrations/providers/production/storedConnectionStore';
import { featuresGranted } from '../integrations/google/googleConfig';

const FRESH_MS = 6 * 60 * 60_000;

export type CalendarCoverage = 'fresh' | 'stale_google' | 'stale_device' | 'force_off';

function googleFencePath(uid: string): string {
  return userSubDoc(uid, BUSY_SOURCE_FENCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID));
}

function googleSourcePath(uid: string): string {
  return userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID));
}

async function guardStoredTarget(
  tx: StorageTransaction,
  uid: string,
  target: NonNullable<BusySourceReplacementFence['jitTarget']>,
): Promise<void> {
  await guardGoogleBusyTargetAuthority(tx, uid, target);
  const current = await tx.get<BusySourceReplacementFence>(googleFencePath(uid));
  if (current?.jitTarget?.targetId !== target.targetId) throw new Error('jit_target_replaced');
  if (target.apply && (current.jitTarget.apply?.owner !== target.apply.owner
    || current.jitTarget.apply.version !== target.apply.version
    || current.jitTarget.apply.generation !== target.apply.generation)) throw new Error('jit_target_replaced');
}

export async function calendarCoverageForEmail(uid: string, runtime: GoogleRuntime): Promise<CalendarCoverage> {
  const [sources, choice, user, connection, controlsValue, registrations, staleRows, googleFence] = await Promise.all([
    runtime.storage.list<CalendarSource>(userCol(uid, CALENDAR_SOURCES), { limit: 61 }),
    runtime.storage.get<{ v?: number; state?: string; generation?: number }>(userSubDoc(uid, CALENDAR_CHOICE, 'state')),
    runtime.storage.get<Record<string, any>>(userDoc(uid)),
    runtime.storage.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
    runtime.storage.get(M5A_CONTROLS_PATH),
    runtime.storage.list<{ sourceId: string; state: string }>(userCol(uid, REGISTERED_DEVICE_SOURCES), { limit: 21 }),
    runtime.storage.list<{ sourceId: string; choiceGeneration: number; fenceGeneration: number;
      failureStartedAt: string | null; version: number }>(userCol(uid, DEVICE_STALE_STATE), { limit: 21 }),
    runtime.storage.get<BusySourceReplacementFence>(googleFencePath(uid)),
  ]);
  const controls = parseM5aControls(controlsValue);
  if (user?.trust?.calendarConsent !== true || !controls?.calendar.enabled) return 'force_off';
  const now = runtime.now().getTime();
  const googleApplicable = Boolean(connection && connection.state === 'connected'
    && connection.capabilities.includes('calendar_busy') && featuresGranted(connection.grantedScopes).calendar);
  if (googleApplicable) {
    if (googleFence?.jitSuppression?.providerAccountId === connection!.identity.providerAccountId
      && googleFence.jitSuppression.fenceGeneration === (googleFence.generation ?? 0)
      && googleFence.jitSuppression.until && Date.parse(googleFence.jitSuppression.until) > now) return 'force_off';
    const google = sources.find(row => row.data.sourceId === GOOGLE_BUSY_SOURCE_ID)?.data;
    const certificate = google?.m5Certificate;
    if (!certificate || google?.coverageStatus !== 'settled' || now - Date.parse(certificate.refreshedAt) > FRESH_MS) return 'stale_google';
  }
  const devices = sources.map(row => row.data).filter(source => source.kind === 'device' && source.status === 'active');
  if (devices.length > 0 && (choice?.v !== 1 || choice.state !== 'active')) return 'force_off';
  const registered = new Set(registrations.filter(row => row.data.state === 'active').map(row => row.data.sourceId));
  const staleDevices = devices.filter(source => registered.has(source.sourceId)
    && now - Date.parse(source.lastSyncedAt) > FRESH_MS);
  if (staleDevices.length > 0) {
    const existing = new Map(staleRows.map(row => [row.data.sourceId, row.data] as const));
    await runtime.storage.runTransaction(async tx => {
      for (const source of staleDevices) {
        const path = userSubDoc(uid, DEVICE_STALE_STATE, docIdForKey(source.sourceId));
        const current = await tx.get<{ choiceGeneration: number; sourceId: string; fenceGeneration: number; failureStartedAt: string; version: number }>(path);
        if (!current || current.choiceGeneration !== (choice!.generation ?? 0) || current.failureStartedAt === null) {
          tx.set(path, { choiceGeneration: choice!.generation ?? 0, sourceId: source.sourceId,
            fenceGeneration: current?.fenceGeneration ?? 0, failureStartedAt: runtime.now().toISOString(),
            version: (current?.version ?? 0) + 1 });
        }
      }
    });
    if (staleDevices.some(source => {
      const started = existing.get(source.sourceId)?.failureStartedAt;
      return Boolean(started && now - Date.parse(started) >= 60 * 60_000);
    })) return 'force_off';
    return 'stale_device';
  }
  if (staleRows.length > 0) await runtime.storage.runTransaction(async tx => {
    for (const row of staleRows) tx.delete(`${userCol(uid, DEVICE_STALE_STATE)}/${row.id}`);
  });
  return 'fresh';
}

export async function waitForCalendarAndFetch(
  uid: string,
  input: {
    scan: M5aScanDocument;
    scanOwner: string;
    claimOwner: string;
    markerIds: readonly string[];
    messageId: string;
    fetchGoogle: boolean;
  },
  runtime: GoogleRuntime,
): Promise<void> {
  const now = runtime.now().toISOString();
  const scanPath = `${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/${input.scan.kind === 'daily' ? 'dailyV2'
    : input.scan.kind === 'live' ? 'liveV2' : 'manualV2'}`;
  const monitorPath = `${userCol(uid, 'intelligenceMonitors')}/gmail`;
  const waiting = await runtime.storage.runTransaction(async tx => {
    const [scan, controls, monitor, ...markers] = await Promise.all([
      tx.get<M5aScanDocument>(scanPath), tx.get<unknown>(M5A_CONTROLS_PATH),
      input.scan.kind === 'live' ? tx.get<GmailMonitor>(monitorPath) : Promise.resolve(null),
      ...input.markerIds.map(id => tx.get<M5aMarker>(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${id}`)),
    ]);
    const parsed = parseM5aControls(controls);
    if (!scan || scan.scanId !== input.scan.scanId || scan.leaseOwner !== input.scanOwner
      || !parsed?.email.enabled || parsed.email.epoch !== scan.emailEpoch
      || (scan.kind === 'live' && (!monitor?.enabled || monitor.generation !== scan.monitorGeneration
        || monitor.m5?.pauseEpoch !== scan.pauseEpoch || Boolean(monitor.m5?.pausedSince)))
      || markers.some(marker => marker?.state !== 'claimed' || marker.owner !== input.claimOwner)) return false;
    const marker: M5aMarker = {
      ...markers[0]!, state: 'waiting_for_calendar', owner: undefined, leaseUntil: undefined,
      messageId: input.messageId, providerAccountId: scan.providerAccountId, emailEpoch: scan.emailEpoch,
      origin: scan.kind === 'live'
        ? { kind: 'monitor', generation: scan.monitorGeneration!, pauseEpoch: scan.pauseEpoch! }
        : { kind: 'scan', scanId: scan.scanId, scanKind: scan.kind,
          ...(scan.monitorGeneration ? { monitorGeneration: scan.monitorGeneration } : {}),
          ...(scan.pauseEpoch === undefined ? {} : { pauseEpoch: scan.pauseEpoch }) },
      requestedAt: now, nextEligibleAt: new Date(Date.parse(now) + 60_000).toISOString(),
    };
    input.markerIds.forEach((id, index) => tx.set(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${id}`, {
      ...marker, ...(index === 1 ? { providerMarkerId: input.markerIds[0] } : {}),
    }));
    tx.set(scanPath, { ...scan, leaseOwner: null, leaseUntil: null, waitingMessageId: input.messageId,
      nextEligibleAt: marker.nextEligibleAt });
    if (scan.kind === 'live' && monitor) tx.set(monitorPath, {
      ...monitor, lease: null, leaseUntil: null, nextPollAt: marker.nextEligibleAt,
      waitingMessageId: input.messageId,
    });
    return true;
  });
  if (!waiting || !input.fetchGoogle) return;

  let target: Awaited<ReturnType<typeof fetchGoogleBusyTarget>>;
  try {
    target = await fetchGoogleBusyTarget(uid, runtime);
  } catch {
    await runtime.storage.runTransaction(async tx => {
      const [current, scan, controls, monitor, user, connection] = await Promise.all([
        tx.get<BusySourceReplacementFence>(googleFencePath(uid)),
        tx.get<M5aScanDocument & { waitingMessageId?: string }>(scanPath),
        tx.get<unknown>(M5A_CONTROLS_PATH),
        input.scan.kind === 'live' || input.scan.kind === 'daily' ? tx.get<GmailMonitor>(monitorPath) : Promise.resolve(null),
        tx.get<Record<string, any>>(userDoc(uid)),
        tx.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
      ]);
      const parsed = parseM5aControls(controls);
      if (!scan || scan.scanId !== input.scan.scanId || scan.waitingMessageId !== input.messageId
        || !parsed?.email.enabled || parsed.email.epoch !== scan.emailEpoch || !parsed.calendar.enabled
        || user?.personalizationPurge?.state === 'purging'
        || user?.trust?.calendarConsent !== true
        || connection?.identity.providerAccountId !== scan.providerAccountId
        || connection.state !== 'connected' || !connection.capabilities.includes('calendar_busy')
        || !featuresGranted(connection.grantedScopes).calendar
        || ((scan.kind === 'live' || scan.kind === 'daily') && (!monitor?.enabled
          || monitor.generation !== scan.monitorGeneration || monitor.m5?.pauseEpoch !== scan.pauseEpoch
          || Boolean(monitor.m5?.pausedSince)))) return;
      const providerAccountId = scan.providerAccountId;
      const previous = current?.jitSuppression;
      const failureStartedAt = previous?.providerAccountId === providerAccountId
        && previous.fenceGeneration === (current?.generation ?? 0)
        ? previous.failureStartedAt : now;
      const elapsed = Date.parse(now) - Date.parse(failureStartedAt);
      tx.set<BusySourceReplacementFence>(googleFencePath(uid), {
        ...(current ?? { generation: 0 }),
        jitSuppression: { providerAccountId, fenceGeneration: current?.generation ?? 0, failureStartedAt,
          ...(elapsed >= 60 * 60_000 ? { until: new Date(Date.parse(now) + 6 * 60 * 60_000).toISOString() } : {}) },
      });
    });
    return;
  }
  await runtime.storage.runTransaction(async tx => {
    const [scan, controls, fence, source, monitor] = await Promise.all([
      tx.get<M5aScanDocument & { waitingMessageId?: string }>(scanPath), tx.get<unknown>(M5A_CONTROLS_PATH),
      tx.get<BusySourceReplacementFence>(googleFencePath(uid)), tx.get<CalendarSource>(googleSourcePath(uid)),
      input.scan.kind === 'live' ? tx.get<GmailMonitor>(monitorPath) : Promise.resolve(null),
    ]);
    const parsed = parseM5aControls(controls);
    if (!scan || scan.scanId !== input.scan.scanId || scan.waitingMessageId !== input.messageId
      || !parsed?.email.enabled || parsed.email.epoch !== scan.emailEpoch
      || (scan.kind === 'live' && (!monitor?.enabled || monitor.generation !== scan.monitorGeneration
        || monitor.m5?.pauseEpoch !== scan.pauseEpoch || Boolean(monitor.m5?.pausedSince)))
      || parsed.calendar.epoch !== target.calendarControlEpoch || !parsed.calendar.enabled
      || (fence?.generation ?? 0) !== (source?.m5Certificate?.fenceGeneration ?? fence?.generation ?? 0)) return;
    const { jitSuppression: _suppression, ...withoutSuppression } = fence ?? { generation: 0 };
    tx.set<BusySourceReplacementFence>(googleFencePath(uid), {
      ...withoutSuppression, jitTarget: { ...target, targetId: target.targetId || randomUUID() },
    });
    if (source) tx.set<CalendarSource>(googleSourcePath(uid), { ...source, coverageStatus: 'refreshing' });
  });
}

/** One calendar-owned apply step. The target survives email disablement. */
export async function runCalendarMaintenanceStep(uid: string, runtime: GoogleRuntime): Promise<boolean> {
  const fence = await runtime.storage.get<BusySourceReplacementFence>(googleFencePath(uid));
  if (!fence?.jitTarget || fence.jitTarget.nextEligibleAt > runtime.now().toISOString()) return false;
  let target = fence.jitTarget;
  try {
    const replacementIsLive = Boolean(target.apply && fence.replace?.owner === target.apply.owner
      && fence.replace.version === target.apply.version && fence.generation === target.apply.generation
      && Date.parse(fence.replace.leaseUntil) > runtime.now().getTime());
    if (!replacementIsLive) {
      const apply = await startResumableBusyReplacement(uid, GOOGLE_BUSY_SOURCE_ID, {
        storage: runtime.storage, now: runtime.now(),
        transactionGuard: tx => guardStoredTarget(tx, uid, target),
      });
      const stored = await runtime.storage.runTransaction(async tx => {
        const current = await tx.get<BusySourceReplacementFence>(googleFencePath(uid));
        if (current?.jitTarget?.targetId !== target.targetId
          || current.replace?.owner !== apply.owner || current.replace.version !== apply.version
          || current.generation !== apply.generation) return false;
        target = { ...current.jitTarget, apply };
        tx.set(googleFencePath(uid), { ...current, jitTarget: target,
          replace: { ...current.replace!, leaseUntil: new Date(runtime.now().getTime() + REPLACEMENT_LEASE_MS).toISOString() } });
        return true;
      });
      if (!stored) return false;
    }
    const result = await applyResumableBusyReplacementChunk(
      uid, GOOGLE_BUSY_SOURCE_ID, googleBusyTargetBlocks(target), target.apply!, {
        storage: runtime.storage,
        transactionGuard: tx => guardStoredTarget(tx, uid, target),
      },
    );
    if (!result.complete) {
      await runtime.storage.runTransaction(async tx => {
        const current = await tx.get<BusySourceReplacementFence>(googleFencePath(uid));
        if (current?.jitTarget?.targetId !== target.targetId
          || current.jitTarget.apply?.owner !== target.apply?.owner
          || current.jitTarget.apply?.version !== target.apply?.version) return;
        if (current.replace?.owner !== result.state.owner || current.replace.version !== result.state.version) return;
        tx.set(googleFencePath(uid), { ...current,
          replace: { ...current.replace, leaseUntil: new Date(runtime.now().getTime() + REPLACEMENT_LEASE_MS).toISOString() },
          jitTarget: { ...current.jitTarget, apply: result.state, nextEligibleAt: runtime.now().toISOString() },
        });
      });
      return true;
    }
    await finalizeResumableBusyReplacement(uid, GOOGLE_BUSY_SOURCE_ID, result.state,
      async (tx, source, currentFence) => {
        if (currentFence.jitTarget?.targetId !== target.targetId
          || currentFence.jitTarget.apply?.owner !== result.state.owner
          || currentFence.jitTarget.apply.version !== result.state.version) throw new Error('jit_target_replaced');
        const certificateFresh = runtime.now().getTime() - Date.parse(target.fetchedAt) <= FRESH_MS;
        const { m5Certificate: _oldCertificate, ...sourceWithoutCertificate } = source ?? {} as CalendarSource;
        tx.set<CalendarSource>(googleSourcePath(uid), {
          ...sourceWithoutCertificate,
          sourceId: GOOGLE_BUSY_SOURCE_ID, kind: 'google', platform: null,
          lastSyncedAt: target.fetchedAt, windowStart: target.windowStart, windowEnd: target.windowEnd,
          coverageStatus: 'settled',
          ...(certificateFresh ? { m5Certificate: {
            v: 1, choiceGeneration: target.choiceGeneration, providerAccountId: target.providerAccountId,
            fenceGeneration: result.state.generation, refreshedAt: target.fetchedAt,
          } } : {}),
        });
        const { jitTarget: _finished, ...withoutTarget } = currentFence;
        tx.set(googleFencePath(uid), withoutTarget);
      }, {
        storage: runtime.storage,
        transactionGuard: tx => guardStoredTarget(tx, uid, target),
      });
    return true;
  } catch {
    await runtime.storage.runTransaction(async tx => {
      const current = await tx.get<BusySourceReplacementFence>(googleFencePath(uid));
      if (current?.jitTarget?.targetId === target.targetId) tx.set(googleFencePath(uid), {
        ...current, jitTarget: { ...current.jitTarget, nextEligibleAt: new Date(runtime.now().getTime() + 60_000).toISOString() },
      });
    });
    return false;
  }
}

