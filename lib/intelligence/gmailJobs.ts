import { randomUUID } from 'node:crypto';
import { LLMUnavailableError } from '../../src/extraction/llm';
import { requireReadableFeature } from '../integrations/google/googleConnectService';
import { googleRuntime, type GoogleRuntime } from '../integrations/google/googleRuntime';
import {
  BUSY_SOURCE_FENCES, INTELLIGENCE_GMAIL_SCANS, INTELLIGENCE_MONITORS,
  INTELLIGENCE_SOURCE_MARKERS, userCol, type StorageAdapter,
} from '../storage';
import type { BusySourceReplacementFence } from '../calendar/busyBlocks';
import { parseM5aControls, M5A_CONTROLS_PATH } from '../release/m5aControls';
import {
  finalizeQuotaPermit, quotaScopeFor, reserveQuotaPermit, retryAfterSecondsFor,
  settleQuotaPermitSlot, startQuotaPermitSlot,
} from '../llm/usageGuard';
import { shareLlmProvider, type ShareStructuredGenerator } from '../llm/shareProvider';
import { isMonitoringPaused } from '../watchers/monitoringSettings';
import { connectedGmailAccount } from './gmailArbitration';
import { runCalendarMaintenanceStep } from './gmailCalendarJit';
import { runGmailMonitorTick, type GmailMonitor } from './gmailMonitor';
import {
  advanceCompletedDaily, createDueDailyScan, runM5aScanStep,
  type M5aMarker, type M5aScanDocument,
} from './m5aGmailScan';
import { proposeFromObservations } from './proposalEngine';

export const GMAIL_JOB_CLASSES = Object.freeze({
  live: Object.freeze(['live', 'proposals'] as const),
  sweep: Object.freeze(['calendar_maintenance', 'continuation', 'sweep'] as const),
});

export const GMAIL_JOB_LIMITS = Object.freeze({
  tickMs: 40_000, cleanupMs: 3_000, cleanupMarkers: 20, leaseMs: 120_000,
  lanes: Object.freeze({ live: 8, proposals: 2, continuation: 4, sweep: 3, calendar_maintenance: 1 }),
  reservesMs: Object.freeze({ listing: 13_000, ordinary: 22_000, qualifyingReply: 34_000, calendarApply: 3_000 }),
});

type JobRoute = keyof typeof GMAIL_JOB_CLASSES;
type GmailClass = 'live' | 'proposals' | 'continuation' | 'sweep';
interface WorkLease { owner: string; job: JobRoute; class: GmailClass; leaseUntil: string }

function uidFrom(path: string, collection: string, id: string): string | null {
  const match = new RegExp(`^users/([A-Za-z0-9_-]{1,128})/${collection}/${id}$`).exec(path);
  return match?.[1] ?? null;
}

function workPath(uid: string): string { return `${userCol(uid, INTELLIGENCE_MONITORS)}/gmailWork`; }

export function distinctAccountUids(candidates: readonly string[], lanes: number): string[] {
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const uid of candidates) {
    if (seen.has(uid)) continue;
    seen.add(uid); selected.push(uid);
    if (selected.length >= lanes) break;
  }
  return selected;
}

async function withAccountLease(
  uid: string, job: JobRoute, jobClass: GmailClass, runtime: GoogleRuntime, work: () => Promise<boolean>,
): Promise<boolean> {
  const owner = randomUUID();
  const now = runtime.now();
  const acquired = await runtime.storage.runTransaction(async tx => {
    const current = await tx.get<WorkLease>(workPath(uid));
    if (current?.leaseUntil && current.leaseUntil > now.toISOString()) return false;
    tx.set<WorkLease>(workPath(uid), { owner, job, class: jobClass,
      leaseUntil: new Date(now.getTime() + GMAIL_JOB_LIMITS.leaseMs).toISOString() });
    return true;
  });
  if (!acquired) return false;
  try { return await work(); }
  finally {
    await runtime.storage.runTransaction(async tx => {
      const current = await tx.get<WorkLease>(workPath(uid));
      if (current?.owner === owner) tx.delete(workPath(uid));
    });
  }
}

function markerAuthorized(marker: M5aMarker, scan: M5aScanDocument | null, controls: unknown): boolean {
  const origin = marker.origin;
  const parsed = parseM5aControls(controls);
  return Boolean(origin && parsed?.email.enabled && marker.emailEpoch === parsed.email.epoch
    && scan && (scan.status === 'running' || scan.status === 'failed')
    && scan.scanId === origin.scanId && scan.kind === origin.scanKind);
}

export async function cleanupCalendarWaits(storage: StorageAdapter, now: Date): Promise<number> {
  const rows = await storage.listGroup<M5aMarker>(INTELLIGENCE_SOURCE_MARKERS, {
    where: [['state', '==', 'waiting_for_calendar'], ['nextEligibleAt', '<=', now.toISOString()]],
    orderBy: { field: 'nextEligibleAt', direction: 'asc' }, limit: GMAIL_JOB_LIMITS.cleanupMarkers,
  });
  let released = 0;
  const started = Date.now();
  for (const row of rows) {
    if (Date.now() - started >= GMAIL_JOB_LIMITS.cleanupMs) break;
    const uid = uidFrom(row.path, INTELLIGENCE_SOURCE_MARKERS, row.id);
    if (!uid) continue;
    const origin = row.data.origin;
    const scanPath = origin?.kind === 'scan'
      ? `${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/${origin.scanKind === 'daily' ? 'dailyV2' : 'manualV2'}` : null;
    const [scan, controls] = await Promise.all([
      scanPath ? storage.get<M5aScanDocument>(scanPath) : Promise.resolve(null), storage.get(M5A_CONTROLS_PATH),
    ]);
    if (markerAuthorized(row.data, scan, controls)) continue;
    await storage.runTransaction(async tx => {
      const current = await tx.get<M5aMarker>(row.path);
      if (current?.state !== 'waiting_for_calendar' || current.requestedAt !== row.data.requestedAt) return;
      tx.set(row.path, { ...current, state: 'released', owner: undefined, leaseUntil: undefined,
        nextEligibleAt: undefined, requestedAt: undefined, origin: undefined });
      released++;
    });
  }
  return released;
}

async function proposalStep(uid: string, runtime: GoogleRuntime): Promise<boolean> {
  const path = `${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`;
  const monitor = await runtime.storage.get<GmailMonitor>(path);
  if (!monitor?.enabled || !monitor.m5 || !monitor.proposalsPending) return false;
  const claimedVersion = monitor.proposalsVersion ?? 0;
  const defer = async (ms: number) => runtime.storage.runTransaction(async tx => {
    const current = await tx.get<GmailMonitor>(path);
    if (current?.generation === monitor.generation) tx.set(path, {
      ...current, proposalNextEligibleAt: new Date(runtime.now().getTime() + ms).toISOString(),
    });
  });
  try {
    if (await isMonitoringPaused(uid, runtime.storage)
      || await connectedGmailAccount(uid, runtime) !== monitor.m5.providerAccountId) { await defer(5 * 60_000); return false; }
    await requireReadableFeature(uid, 'gmail', runtime);
    const reservation = await reserveQuotaPermit(uid, 'semantic_observation', {
      owner: `proposal:${monitor.generation}:${claimedVersion}`, calls: 2, tokenBudget: 10_000,
    }, { storage: runtime.storage, now: runtime.now() });
    if (reservation.outcome !== 'ok' || !reservation.permit) {
      const scope = reservation.outcome === 'minute_boundary' ? null : quotaScopeFor(reservation.outcome);
      const resumesAt = reservation.outcome === 'minute_boundary'
        ? new Date(Math.ceil(runtime.now().getTime() / 60_000) * 60_000).toISOString()
        : scope ? new Date(runtime.now().getTime() + retryAfterSecondsFor(scope, runtime.now()) * 1_000).toISOString() : null;
      if (resumesAt) await runtime.storage.runTransaction(async tx => {
        const current = await tx.get<GmailMonitor>(path);
        if (current?.generation !== monitor.generation) return;
        tx.set(path, { ...current, proposalNextEligibleAt: resumesAt,
          proposalWaiting: scope ? { reason: scope === 'user_minute' ? 'rate_limit' : 'daily_ai_limit', resumesAt,
            generation: monitor.generation, providerAccountId: monitor.m5!.providerAccountId } : null });
      });
      return false;
    }
    const permit = reservation.permit;
    let slot = 0;
    const generate: ShareStructuredGenerator = runtime.shareModel
      ? async request => {
        const use = slot++;
        if (!await startQuotaPermitSlot(permit, use, { storage: runtime.storage, now: runtime.now() })) throw new LLMUnavailableError('usage_guard_unavailable');
        const response = await runtime.shareModel!(request);
        await settleQuotaPermitSlot(permit, use, response, { storage: runtime.storage, now: runtime.now() });
        return response;
      }
      : async request => {
        const use = slot++;
        return shareLlmProvider(uid, { purpose: 'semantic_observation', quotaPermit: { permit, slot: use, storage: runtime.storage }, now: runtime.now })(request);
      };
    try {
      await proposeFromObservations(uid, runtime.now().toISOString(), { storage: runtime.storage, generate });
      await runtime.storage.runTransaction(async tx => {
        const current = await tx.get<GmailMonitor>(path);
        if (!current?.enabled || current.generation !== monitor.generation || current.m5?.providerAccountId !== monitor.m5!.providerAccountId) return;
        const pending = (current.proposalsVersion ?? 0) > claimedVersion;
        tx.set(path, { ...current, proposalsDoneVersion: claimedVersion, proposalsPending: pending,
          proposalNextEligibleAt: pending ? runtime.now().toISOString() : new Date(runtime.now().getTime() + 5 * 60_000).toISOString(),
          proposalWaiting: null });
      });
      return true;
    } finally { await finalizeQuotaPermit(permit, { storage: runtime.storage, now: runtime.now() }); }
  } catch { await defer(5 * 60_000); return false; }
}

async function runLive(runtime: GoogleRuntime): Promise<number> {
  const rows = await runtime.storage.listGroup<GmailMonitor>(INTELLIGENCE_MONITORS, {
    where: [['enabled', '==', true], ['nextPollAt', '<=', runtime.now().toISOString()]],
    orderBy: { field: 'nextPollAt', direction: 'asc' }, limit: GMAIL_JOB_LIMITS.lanes.live * 3,
  });
  let processed = 0;
  for (const row of rows) {
    if (processed >= GMAIL_JOB_LIMITS.lanes.live) break;
    const uid = uidFrom(row.path, INTELLIGENCE_MONITORS, 'gmail');
    if (uid && await withAccountLease(uid, 'live', 'live', runtime, async () =>
      (await runGmailMonitorTick(runtime, { uid })).accountsChecked > 0)) processed++;
  }
  return processed;
}

async function runProposals(runtime: GoogleRuntime): Promise<number> {
  const rows = await runtime.storage.listGroup<GmailMonitor>(INTELLIGENCE_MONITORS, {
    where: [['proposalsPending', '==', true], ['proposalNextEligibleAt', '<=', runtime.now().toISOString()]],
    orderBy: { field: 'proposalNextEligibleAt', direction: 'asc' }, limit: GMAIL_JOB_LIMITS.lanes.proposals * 5,
  });
  let processed = 0;
  for (const row of rows) {
    if (processed >= GMAIL_JOB_LIMITS.lanes.proposals) break;
    const uid = uidFrom(row.path, INTELLIGENCE_MONITORS, 'gmail');
    if (uid && await withAccountLease(uid, 'live', 'proposals', runtime, () => proposalStep(uid, runtime))) processed++;
  }
  return processed;
}

async function runScanClass(kind: 'manual' | 'daily', lanes: number, runtime: GoogleRuntime): Promise<number> {
  const rows = await runtime.storage.listGroup<M5aScanDocument>(INTELLIGENCE_GMAIL_SCANS, {
    where: [['kind', '==', kind], ['status', 'in', ['running', 'failed']], ['nextEligibleAt', '<=', runtime.now().toISOString()]],
    orderBy: { field: 'nextEligibleAt', direction: 'asc' }, limit: lanes * 3,
  });
  let processed = 0;
  for (const row of rows) {
    if (processed >= lanes) break;
    const id = kind === 'daily' ? 'dailyV2' : 'manualV2';
    const uid = uidFrom(row.path, INTELLIGENCE_GMAIL_SCANS, id);
    const jobClass: GmailClass = kind === 'daily' ? 'sweep' : 'continuation';
    if (uid && await withAccountLease(uid, 'sweep', jobClass, runtime, async () => {
      await runM5aScanStep(uid, kind, runtime);
      if (kind === 'daily') await advanceCompletedDaily(uid, runtime);
      return true;
    })) processed++;
  }
  return processed;
}

async function bootstrapSweeps(runtime: GoogleRuntime): Promise<void> {
  const rows = await runtime.storage.listGroup<GmailMonitor>(INTELLIGENCE_MONITORS, {
    where: [['enabled', '==', true], ['m5.v', '==', 1], ['m5.nextSweepAt', '<=', runtime.now().toISOString()]],
    orderBy: { field: 'm5.nextSweepAt', direction: 'asc' }, limit: GMAIL_JOB_LIMITS.lanes.sweep * 3,
  });
  for (const row of rows) {
    const uid = uidFrom(row.path, INTELLIGENCE_MONITORS, 'gmail');
    if (uid) await createDueDailyScan(uid, runtime);
  }
}

async function runCalendarMaintenance(runtime: GoogleRuntime): Promise<number> {
  const rows = await runtime.storage.listGroup<BusySourceReplacementFence>(BUSY_SOURCE_FENCES, {
    where: [['jitTarget.nextEligibleAt', '<=', runtime.now().toISOString()]],
    orderBy: { field: 'jitTarget.nextEligibleAt', direction: 'asc' }, limit: 3,
  });
  for (const row of rows) {
    const uid = uidFrom(row.path, BUSY_SOURCE_FENCES, row.id);
    if (uid && await runCalendarMaintenanceStep(uid, runtime)) return 1;
  }
  return 0;
}

export async function runGmailJobTickForTests(
  route: JobRoute,
  options: { now?: Date } = {},
): Promise<{ success: true; route: JobRoute; classes: readonly string[]; processed: number; cleaned: number }> {
  const base = googleRuntime();
  const runtime = options.now ? { ...base, now: () => new Date(options.now!) } : base;
  const cleaned = await cleanupCalendarWaits(runtime.storage, runtime.now());
  let processed = 0;
  if (route === 'live') {
    processed += await runLive(runtime);
    processed += await runProposals(runtime);
  } else {
    await bootstrapSweeps(runtime);
    processed += await runScanClass('manual', GMAIL_JOB_LIMITS.lanes.continuation, runtime);
    processed += await runScanClass('daily', GMAIL_JOB_LIMITS.lanes.sweep, runtime);
    processed += await runCalendarMaintenance(runtime);
  }
  return { success: true, route, classes: GMAIL_JOB_CLASSES[route], processed, cleaned };
}
