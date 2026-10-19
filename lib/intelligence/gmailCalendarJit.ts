import { randomUUID } from 'node:crypto';
import type { CalendarSource, BusySourceReplacementFence } from '../calendar/busyBlocks';
import { applyGoogleBusyTarget, fetchGoogleBusyTarget, GOOGLE_BUSY_SOURCE_ID } from '../integrations/google/googleCalendarBusy';
import type { GoogleRuntime } from '../integrations/google/googleRuntime';
import {
  BUSY_SOURCE_FENCES, CALENDAR_CHOICE, CALENDAR_SOURCES, INTELLIGENCE_GMAIL_SCANS,
  INTELLIGENCE_SOURCE_MARKERS, PROVIDER_CONNECTIONS, docIdForKey, userCol, userDoc, userSubDoc,
} from '../storage';
import { M5A_CONTROLS_PATH, parseM5aControls } from '../release/m5aControls';
import type { M5aMarker, M5aScanDocument } from './m5aGmailScan';
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

export async function calendarCoverageForEmail(uid: string, runtime: GoogleRuntime): Promise<CalendarCoverage> {
  const [sources, choice, user, connection, controlsValue] = await Promise.all([
    runtime.storage.list<CalendarSource>(userCol(uid, CALENDAR_SOURCES), { limit: 61 }),
    runtime.storage.get<{ v?: number; state?: string }>(userSubDoc(uid, CALENDAR_CHOICE, 'state')),
    runtime.storage.get<Record<string, any>>(userDoc(uid)),
    runtime.storage.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
    runtime.storage.get(M5A_CONTROLS_PATH),
  ]);
  const controls = parseM5aControls(controlsValue);
  if (user?.trust?.calendarConsent !== true || !controls?.calendar.enabled) return 'force_off';
  const now = runtime.now().getTime();
  const googleApplicable = Boolean(connection && connection.state === 'connected'
    && connection.capabilities.includes('calendar_busy') && featuresGranted(connection.grantedScopes).calendar);
  if (googleApplicable) {
    const google = sources.find(row => row.data.sourceId === GOOGLE_BUSY_SOURCE_ID)?.data;
    const certificate = google?.m5Certificate;
    if (!certificate || google?.coverageStatus !== 'settled' || now - Date.parse(certificate.refreshedAt) > FRESH_MS) return 'stale_google';
  }
  const devices = sources.map(row => row.data).filter(source => source.kind === 'device' && source.status === 'active');
  if (devices.length > 0 && (choice?.v !== 1 || choice.state !== 'active')) return 'force_off';
  if (devices.some(source => now - Date.parse(source.lastSyncedAt) > FRESH_MS)) return 'stale_device';
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
  const scanPath = `${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/${input.scan.kind === 'daily' ? 'dailyV2' : 'manualV2'}`;
  const waiting = await runtime.storage.runTransaction(async tx => {
    const [scan, controls, ...markers] = await Promise.all([
      tx.get<M5aScanDocument>(scanPath), tx.get<unknown>(M5A_CONTROLS_PATH),
      ...input.markerIds.map(id => tx.get<M5aMarker>(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${id}`)),
    ]);
    const parsed = parseM5aControls(controls);
    if (!scan || scan.scanId !== input.scan.scanId || scan.leaseOwner !== input.scanOwner
      || !parsed?.email.enabled || parsed.email.epoch !== scan.emailEpoch
      || markers.some(marker => marker?.state !== 'claimed' || marker.owner !== input.claimOwner)) return false;
    const marker: M5aMarker = {
      ...markers[0]!, state: 'waiting_for_calendar', owner: undefined, leaseUntil: undefined,
      messageId: input.messageId, providerAccountId: scan.providerAccountId, emailEpoch: scan.emailEpoch,
      origin: { kind: 'scan', scanId: scan.scanId, scanKind: scan.kind,
        ...(scan.monitorGeneration ? { monitorGeneration: scan.monitorGeneration } : {}),
        ...(scan.pauseEpoch === undefined ? {} : { pauseEpoch: scan.pauseEpoch }) },
      requestedAt: now, nextEligibleAt: new Date(Date.parse(now) + 60_000).toISOString(),
    };
    input.markerIds.forEach((id, index) => tx.set(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${id}`, {
      ...marker, ...(index === 1 ? { providerMarkerId: input.markerIds[0] } : {}),
    }));
    tx.set(scanPath, { ...scan, leaseOwner: null, leaseUntil: null, waitingMessageId: input.messageId,
      nextEligibleAt: marker.nextEligibleAt });
    return true;
  });
  if (!waiting || !input.fetchGoogle) return;

  const target = await fetchGoogleBusyTarget(uid, runtime);
  await runtime.storage.runTransaction(async tx => {
    const [scan, controls, fence, source] = await Promise.all([
      tx.get<M5aScanDocument & { waitingMessageId?: string }>(scanPath), tx.get<unknown>(M5A_CONTROLS_PATH),
      tx.get<BusySourceReplacementFence>(googleFencePath(uid)), tx.get<CalendarSource>(googleSourcePath(uid)),
    ]);
    const parsed = parseM5aControls(controls);
    if (!scan || scan.scanId !== input.scan.scanId || scan.waitingMessageId !== input.messageId
      || !parsed?.email.enabled || parsed.email.epoch !== scan.emailEpoch
      || parsed.calendar.epoch !== target.calendarControlEpoch || !parsed.calendar.enabled
      || (fence?.generation ?? 0) !== (source?.m5Certificate?.fenceGeneration ?? fence?.generation ?? 0)) return;
    tx.set<BusySourceReplacementFence>(googleFencePath(uid), {
      ...(fence ?? { generation: 0 }), jitTarget: { ...target, targetId: target.targetId || randomUUID() },
    });
    if (source) tx.set<CalendarSource>(googleSourcePath(uid), { ...source, coverageStatus: 'refreshing' });
  });
}

/** One calendar-owned apply step. The target survives email disablement. */
export async function runCalendarMaintenanceStep(uid: string, runtime: GoogleRuntime): Promise<boolean> {
  const fence = await runtime.storage.get<BusySourceReplacementFence>(googleFencePath(uid));
  if (!fence?.jitTarget || fence.jitTarget.nextEligibleAt > runtime.now().toISOString()) return false;
  const target = fence.jitTarget;
  try {
    await applyGoogleBusyTarget(uid, target, runtime);
    await runtime.storage.runTransaction(async tx => {
      const current = await tx.get<BusySourceReplacementFence>(googleFencePath(uid));
      if (current?.jitTarget?.targetId !== target.targetId) return;
      const { jitTarget: _target, ...withoutTarget } = current;
      tx.set(googleFencePath(uid), withoutTarget);
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

