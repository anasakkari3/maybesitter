import { randomUUID } from 'node:crypto';
import { LLMUnavailableError } from '../../src/extraction/llm';
import { requireReadableFeature } from '../integrations/google/googleConnectService';
import { googleRuntime, type GoogleRuntime } from '../integrations/google/googleRuntime';
import {
  BUSY_SOURCE_FENCES, INTELLIGENCE_GMAIL_SCANS, INTELLIGENCE_MONITORS,
  INTELLIGENCE_SOURCE_MARKERS, PROVIDER_CONNECTIONS, userCol, userSubDoc, type StorageAdapter,
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
import { connectionIdFor } from '../integrations/providers/production/storedConnectionStore';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts';
import type { StorageTransaction } from '../storage/storageAdapter';
import type { GmailTransport } from '../integrations/gmail/production/gmailTransport';

export const GMAIL_JOB_CLASSES = Object.freeze({
  live: Object.freeze(['live', 'proposals'] as const),
  sweep: Object.freeze(['calendar_maintenance', 'continuation', 'sweep'] as const),
});

export const GMAIL_JOB_LIMITS = Object.freeze({
  tickMs: 40_000, cleanupMs: 3_000, cleanupMarkers: 20, leaseMs: 120_000,
  lanes: Object.freeze({ live: 8, proposals: 2, continuation: 4, sweep: 3, calendar_maintenance: 1 }),
  /** Messages one account's scan may read in one tick, while the tick has room for another. */
  scanStepsPerTick: 25,
  reservesMs: Object.freeze({ listing: 13_000, ordinary: 22_000, qualifyingReply: 34_000, calendarApply: 3_000 }),
});

type JobRoute = keyof typeof GMAIL_JOB_CLASSES;
type GmailClass = 'live' | 'proposals' | 'continuation' | 'sweep';
interface WorkLease { owner: string; job: JobRoute; class: GmailClass; leaseUntil: string }
interface GmailJobOverrides {
  readonly transport?: (uid: string) => GmailTransport;
  readonly ensureReadable?: (uid: string) => Promise<void>;
}

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

function markerAuthorized(
  marker: M5aMarker, scan: M5aScanDocument | null, monitor: GmailMonitor | null, controls: unknown,
): boolean {
  const origin = marker.origin;
  const parsed = parseM5aControls(controls);
  if (!origin || !parsed?.email.enabled || marker.emailEpoch !== parsed.email.epoch) return false;
  if (origin.kind === 'monitor') return Boolean(monitor?.enabled && monitor.m5
    && monitor.generation === origin.generation && monitor.m5.pauseEpoch === origin.pauseEpoch
    && !monitor.m5.pausedSince && monitor.m5.providerAccountId === marker.providerAccountId);
  const scanAuthorized = Boolean(scan && (scan.status === 'running' || scan.status === 'failed')
    && scan.scanId === origin.scanId && scan.kind === origin.scanKind);
  if (!scanAuthorized || !origin.monitorGeneration) return scanAuthorized;
  return Boolean(monitor?.enabled && monitor.m5
    && monitor.generation === origin.monitorGeneration
    && monitor.m5.pauseEpoch === origin.pauseEpoch
    && !monitor.m5.pausedSince
    && monitor.m5.providerAccountId === marker.providerAccountId);
}

export async function cleanupCalendarWaits(storage: StorageAdapter, now: Date, deadlineMs = Date.now() + GMAIL_JOB_LIMITS.cleanupMs): Promise<number> {
  const rows = await storage.listGroup<M5aMarker>(INTELLIGENCE_SOURCE_MARKERS, {
    where: [['state', '==', 'waiting_for_calendar'], ['nextEligibleAt', '<=', now.toISOString()]],
    orderBy: { field: 'nextEligibleAt', direction: 'asc' }, limit: GMAIL_JOB_LIMITS.cleanupMarkers,
  });
  let released = 0;
  for (const row of rows) {
    if (Date.now() >= deadlineMs) break;
    const uid = uidFrom(row.path, INTELLIGENCE_SOURCE_MARKERS, row.id);
    if (!uid) continue;
    await storage.runTransaction(async tx => {
      const current = await tx.get<M5aMarker>(row.path);
      if (current?.state !== 'waiting_for_calendar' || current.requestedAt !== row.data.requestedAt) return;
      const origin = current.origin;
      const scanPath = origin?.kind === 'scan'
        ? `${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/${origin.scanKind === 'daily' ? 'dailyV2'
          : origin.scanKind === 'live' ? 'liveV2' : 'manualV2'}` : null;
      const [scan, monitor, controls] = await Promise.all([
        scanPath ? tx.get<M5aScanDocument>(scanPath) : Promise.resolve(null),
        origin?.kind === 'monitor' || origin?.kind === 'scan' && Boolean(origin.monitorGeneration)
          ? tx.get<GmailMonitor>(`${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`) : Promise.resolve(null),
        tx.get(M5A_CONTROLS_PATH),
      ]);
      if (markerAuthorized(current, scan, monitor, controls)) return;
      tx.set(row.path, { ...current, state: 'released', owner: undefined, leaseUntil: undefined,
        nextEligibleAt: undefined, requestedAt: undefined, origin: undefined });
      released++;
    });
  }
  return released;
}

interface LaneCandidate { readonly uid: string }

/**
 * A fixed number of real concurrent lanes over one ordered candidate batch.
 * Each lane runs one account step at a time and checks the step's conservative
 * reserve against the deadline fixed at tick admission. A lost account lease
 * consumes no lane: that worker immediately tries the next candidate.
 */
async function runCandidateLanes<T extends LaneCandidate>(
  candidates: readonly T[],
  lanes: number,
  reserveMs: (candidate: T) => number,
  deadlineMs: number,
  run: (candidate: T) => Promise<boolean>,
): Promise<number> {
  const unique = candidates.filter((candidate, index) =>
    candidates.findIndex(other => other.uid === candidate.uid) === index);
  let cursor = 0;
  let processed = 0;
  const worker = async (): Promise<void> => {
    while (cursor < unique.length) {
      const candidate = unique[cursor++]!;
      if (Date.now() + reserveMs(candidate) > deadlineMs) return;
      if (await run(candidate)) processed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, unique.length) }, worker));
  return processed;
}

export function runReservedLanesForTests(
  candidates: readonly string[],
  lanes: number,
  reserveMs: number,
  deadlineMs: number,
  run: (uid: string) => Promise<boolean>,
): Promise<number> {
  return runCandidateLanes(candidates.map(uid => ({ uid })), lanes, () => reserveMs, deadlineMs,
    candidate => run(candidate.uid));
}

export function runAccountLeasedLanesForTests(
  candidates: readonly string[],
  lanes: number,
  route: JobRoute,
  jobClass: 'live' | 'proposals' | 'continuation' | 'sweep',
  runtime: GoogleRuntime,
  run: (uid: string) => Promise<boolean>,
): Promise<number> {
  return runCandidateLanes(candidates.map(uid => ({ uid })), lanes, () => 0, Date.now() + 5_000,
    candidate => withAccountLease(candidate.uid, route, jobClass, runtime, () => run(candidate.uid)));
}

async function proposalStep(uid: string, runtime: GoogleRuntime, overrides: GmailJobOverrides = {}): Promise<boolean> {
  const path = `${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`;
  const monitor = await runtime.storage.get<GmailMonitor>(path);
  if (!monitor?.enabled || !monitor.m5 || !monitor.proposalsPending) return false;
  const claimedVersion = monitor.proposalsVersion ?? 0;
  const controlsAtClaim = parseM5aControls(await runtime.storage.get(M5A_CONTROLS_PATH));
  if (!controlsAtClaim?.email.enabled) return false;
  const emailEpoch = controlsAtClaim.email.epoch;
  const assertAuthority = async (tx?: StorageTransaction): Promise<GmailMonitor> => {
    const reader = tx ?? runtime.storage;
    const [current, controls, connection, paused] = await Promise.all([
      reader.get<GmailMonitor>(path),
      reader.get<unknown>(M5A_CONTROLS_PATH),
      reader.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
      isMonitoringPaused(uid, runtime.storage, tx),
    ]);
    const parsed = parseM5aControls(controls);
    if (!current?.enabled || !current.proposalsPending || current.generation !== monitor.generation
      || current.m5?.providerAccountId !== monitor.m5!.providerAccountId || paused
      || !parsed?.email.enabled || parsed.email.epoch !== emailEpoch
      || connection?.identity.providerAccountId !== monitor.m5!.providerAccountId) throw new Error('proposal_guard_changed');
    return current;
  };
  const defer = async (ms: number) => runtime.storage.runTransaction(async tx => {
    const current = await tx.get<GmailMonitor>(path);
    if (current?.generation === monitor.generation) tx.set(path, {
      ...current, proposalNextEligibleAt: new Date(runtime.now().getTime() + ms).toISOString(),
    });
  });
  try {
    if (await isMonitoringPaused(uid, runtime.storage)
      || await connectedGmailAccount(uid, runtime) !== monitor.m5.providerAccountId) { await defer(5 * 60_000); return false; }
    await (overrides.ensureReadable?.(uid) ?? requireReadableFeature(uid, 'gmail', runtime));
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
    const providerGenerate: ShareStructuredGenerator = runtime.shareModel
      ? async request => {
        const use = slot++;
        if (!await startQuotaPermitSlot(permit, use, { storage: runtime.storage, now: runtime.now() })) throw new LLMUnavailableError('usage_guard_unavailable');
        const response = await runtime.shareModel!(request);
        await settleQuotaPermitSlot(permit, use, response, { storage: runtime.storage, now: runtime.now() });
        return response;
      }
      : async request => {
        const use = slot++;
        return shareLlmProvider(uid, {
          purpose: 'semantic_observation', quotaPermit: { permit, slot: use, storage: runtime.storage }, now: runtime.now,
          ...(runtime.shareProvider ? { provider: runtime.shareProvider } : {}),
        })(request);
      };
    const generate: ShareStructuredGenerator = async request => {
      await assertAuthority();
      return providerGenerate(request);
    };
    let completedAtomically = false;
    try {
      await proposeFromObservations(uid, runtime.now().toISOString(), {
        storage: runtime.storage, generate, throwOnGenerateFailure: true,
        transactionGuard: tx => assertAuthority(tx),
        transactionComplete: async (tx, current) => {
          const pending = (current.proposalsVersion ?? 0) > claimedVersion;
          tx.set(path, { ...current, proposalsDoneVersion: claimedVersion, proposalsPending: pending,
            proposalNextEligibleAt: pending ? runtime.now().toISOString() : new Date(runtime.now().getTime() + 5 * 60_000).toISOString(),
            proposalWaiting: null });
          completedAtomically = true;
        },
      });
      if (!completedAtomically) await runtime.storage.runTransaction(async tx => {
        const current = await assertAuthority(tx);
        const pending = (current.proposalsVersion ?? 0) > claimedVersion;
        tx.set(path, { ...current, proposalsDoneVersion: claimedVersion, proposalsPending: pending,
          proposalNextEligibleAt: pending ? runtime.now().toISOString() : new Date(runtime.now().getTime() + 5 * 60_000).toISOString(),
          proposalWaiting: null });
      });
      return true;
    } finally { await finalizeQuotaPermit(permit, { storage: runtime.storage, now: runtime.now() }); }
  } catch { await defer(5 * 60_000); return false; }
}

async function runLive(runtime: GoogleRuntime, deadlineMs: number, overrides: GmailJobOverrides): Promise<number> {
  const rows = await runtime.storage.listGroup<GmailMonitor>(INTELLIGENCE_MONITORS, {
    where: [['enabled', '==', true], ['nextPollAt', '<=', runtime.now().toISOString()]],
    orderBy: { field: 'nextPollAt', direction: 'asc' }, limit: GMAIL_JOB_LIMITS.lanes.live * 3,
  });
  const candidates = (await Promise.all(rows.map(async row => {
    const uid = uidFrom(row.path, INTELLIGENCE_MONITORS, 'gmail');
    if (!uid) return null;
    const scan = await runtime.storage.get<M5aScanDocument>(`${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/liveV2`);
    return { uid, row, scan };
  }))).filter(candidate => candidate !== null);
  return runCandidateLanes(candidates, GMAIL_JOB_LIMITS.lanes.live,
    candidate => candidate.scan?.page ? GMAIL_JOB_LIMITS.reservesMs.qualifyingReply : GMAIL_JOB_LIMITS.reservesMs.listing,
    deadlineMs,
    candidate => withAccountLease(candidate.uid, 'live', 'live', runtime, async () =>
      (await runGmailMonitorTick(runtime, {
        uid: candidate.uid,
        ...(overrides.transport ? { transport: overrides.transport } : {}),
        ...(overrides.ensureReadable ? { ensureReadable: overrides.ensureReadable } : {}),
      })).accountsChecked > 0));
}

async function runProposals(runtime: GoogleRuntime, deadlineMs: number, overrides: GmailJobOverrides): Promise<number> {
  const rows = await runtime.storage.listGroup<GmailMonitor>(INTELLIGENCE_MONITORS, {
    where: [['proposalsPending', '==', true], ['proposalNextEligibleAt', '<=', runtime.now().toISOString()]],
    orderBy: { field: 'proposalNextEligibleAt', direction: 'asc' }, limit: GMAIL_JOB_LIMITS.lanes.proposals * 5,
  });
  const candidates = rows.flatMap(row => {
    const uid = uidFrom(row.path, INTELLIGENCE_MONITORS, 'gmail');
    return uid ? [{ uid, row }] : [];
  });
  return runCandidateLanes(candidates, GMAIL_JOB_LIMITS.lanes.proposals,
    () => GMAIL_JOB_LIMITS.reservesMs.ordinary, deadlineMs,
    candidate => withAccountLease(candidate.uid, 'live', 'proposals', runtime,
      () => proposalStep(candidate.uid, runtime, overrides)));
}

async function runScanClass(
  kind: 'manual' | 'daily',
  lanes: number,
  runtime: GoogleRuntime,
  deadlineMs: number,
  overrides: GmailJobOverrides,
): Promise<number> {
  const rows = await runtime.storage.listGroup<M5aScanDocument>(INTELLIGENCE_GMAIL_SCANS, {
    where: [['kind', '==', kind], ['status', 'in', ['running', 'failed']], ['nextEligibleAt', '<=', runtime.now().toISOString()]],
    orderBy: { field: 'nextEligibleAt', direction: 'asc' }, limit: lanes * 3,
  });
  const candidates = rows.flatMap(row => {
    const id = kind === 'daily' ? 'dailyV2' : 'manualV2';
    const uid = uidFrom(row.path, INTELLIGENCE_GMAIL_SCANS, id);
    return uid ? [{ uid, row }] : [];
  });
  const jobClass: GmailClass = kind === 'daily' ? 'sweep' : 'continuation';
  return runCandidateLanes(candidates, lanes,
    candidate => candidate.row.data.page ? GMAIL_JOB_LIMITS.reservesMs.qualifyingReply : GMAIL_JOB_LIMITS.reservesMs.listing,
    deadlineMs,
    candidate => withAccountLease(candidate.uid, 'sweep', jobClass, runtime, async () => {
      // A step reads one message. One step a tick read one e-mail a minute, so
      // a 7-day scan of an ordinary mailbox took hours (staging, 2026-10-24).
      // The account keeps stepping while its scan is running and due, and the
      // tick still has a qualifying reply's reserve left, up to a fixed cap.
      const path = `${userCol(candidate.uid, INTELLIGENCE_GMAIL_SCANS)}/${kind === 'daily' ? 'dailyV2' : 'manualV2'}`;
      for (let step = 0; step < GMAIL_JOB_LIMITS.scanStepsPerTick; step += 1) {
        await runM5aScanStep(candidate.uid, kind, runtime, overrides.transport?.(candidate.uid),
          overrides.ensureReadable ? () => overrides.ensureReadable!(candidate.uid) : undefined);
        if (kind === 'daily') await advanceCompletedDaily(candidate.uid, runtime);
        if (Date.now() + GMAIL_JOB_LIMITS.reservesMs.qualifyingReply > deadlineMs) break;
        const scan = await runtime.storage.get<M5aScanDocument>(path);
        if (!scan || scan.status !== 'running' || scan.nextEligibleAt > runtime.now().toISOString()) break;
      }
      return true;
    }));
}

async function bootstrapSweeps(runtime: GoogleRuntime, deadlineMs: number): Promise<number> {
  const rows = await runtime.storage.listGroup<GmailMonitor>(INTELLIGENCE_MONITORS, {
    where: [['enabled', '==', true], ['m5.v', '==', 1], ['m5.nextSweepAt', '<=', runtime.now().toISOString()]],
    orderBy: { field: 'm5.nextSweepAt', direction: 'asc' }, limit: GMAIL_JOB_LIMITS.lanes.sweep * 3,
  });
  const candidates = rows.flatMap(row => {
    const uid = uidFrom(row.path, INTELLIGENCE_MONITORS, 'gmail');
    return uid ? [{ uid, row }] : [];
  });
  return runCandidateLanes(candidates, GMAIL_JOB_LIMITS.lanes.sweep,
    () => GMAIL_JOB_LIMITS.reservesMs.calendarApply, deadlineMs,
    candidate => withAccountLease(candidate.uid, 'sweep', 'sweep', runtime,
      () => createDueDailyScan(candidate.uid, runtime)));
}

async function runCalendarMaintenance(runtime: GoogleRuntime, deadlineMs: number): Promise<number> {
  const rows = await runtime.storage.listGroup<BusySourceReplacementFence>(BUSY_SOURCE_FENCES, {
    where: [['jitTarget.nextEligibleAt', '<=', runtime.now().toISOString()]],
    orderBy: { field: 'jitTarget.nextEligibleAt', direction: 'asc' }, limit: 3,
  });
  const candidates = rows.flatMap(row => {
    const uid = uidFrom(row.path, BUSY_SOURCE_FENCES, row.id);
    return uid ? [{ uid, row }] : [];
  });
  return runCandidateLanes(candidates, GMAIL_JOB_LIMITS.lanes.calendar_maintenance,
    () => GMAIL_JOB_LIMITS.reservesMs.calendarApply, deadlineMs,
    candidate => runCalendarMaintenanceStep(candidate.uid, runtime));
}

export async function runGmailJobTickForTests(
  route: JobRoute,
  options: { now?: Date; runtime?: GoogleRuntime } & GmailJobOverrides = {},
): Promise<{ success: true; route: JobRoute; classes: readonly string[]; processed: number; cleaned: number }> {
  const tickStartedAt = Date.now();
  const tickDeadline = tickStartedAt + GMAIL_JOB_LIMITS.tickMs;
  const base = options.runtime ?? googleRuntime();
  const runtime = options.now ? { ...base, now: () => new Date(options.now!) } : base;
  const cleaned = await cleanupCalendarWaits(runtime.storage, runtime.now(),
    Math.min(tickDeadline, tickStartedAt + GMAIL_JOB_LIMITS.cleanupMs));
  let processed = 0;
  if (route === 'live') {
    const results = await Promise.all([runLive(runtime, tickDeadline, options), runProposals(runtime, tickDeadline, options)]);
    processed += results[0] + results[1];
  } else {
    processed += await bootstrapSweeps(runtime, tickDeadline);
    const results = await Promise.all([
      runScanClass('manual', GMAIL_JOB_LIMITS.lanes.continuation, runtime, tickDeadline, options),
      runScanClass('daily', GMAIL_JOB_LIMITS.lanes.sweep, runtime, tickDeadline, options),
      runCalendarMaintenance(runtime, tickDeadline),
    ]);
    processed += results[0] + results[1] + results[2];
  }
  return { success: true, route, classes: GMAIL_JOB_CLASSES[route], processed, cleaned };
}
