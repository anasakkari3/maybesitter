import { createHash, randomUUID } from 'node:crypto';
import { createGmailTransport, type GmailTransport } from '../integrations/gmail/production/gmailTransport';
import { googleAccessToken, requireReadableFeature } from '../integrations/google/googleConnectService';
import { googleRuntime, type GoogleRuntime } from '../integrations/google/googleRuntime';
import { getAiConsent } from '../consents/aiConsentService';
import { getStorage, INTELLIGENCE_GMAIL_SCANS, INTELLIGENCE_MONITORS, INTELLIGENCE_SOURCE_MARKERS, requireUserId, userCol, userDoc, type StorageAdapter } from '../storage';
import { intelligenceEnabled } from './gate';
import { analyzeSource } from './analyzeSource';
import { isMonitoringPaused } from '../watchers/monitoringSettings';
import { analyzeArbitratedGmailMessage, connectedGmailAccount, legacyGmailArbitrationEnabled } from './gmailArbitration';
import { addLocalDays, localDayKey, localMidnightOf } from '../services/mobile/time';

export interface GmailMonitor {
  enabled: boolean;
  generation: string;
  cursor: string | null;
  pageToken: string | null;
  nextPollAt: string;
  lease?: { owner: string; leaseUntil: string } | null;
  leaseUntil: string | null;
  lastSuccessAt: string | null;
  error: 'source_unavailable' | 'analysis_unavailable' | null;
  m5?: {
    v: 1;
    providerAccountId: string;
    enabledAt: string;
    timezone: string | null;
    at: string;
    pauseEpoch: number;
    pausedSince: string | null;
    excluded: Array<{ from: string; to: string }>;
    nextSweepAt?: string;
    sweepTimezone?: string;
    pendingSweepDay?: string;
    pendingSweepFrom?: string;
  };
  proposalsVersion?: number;
  proposalsDoneVersion?: number;
  proposalsPending?: boolean;
  proposalNextEligibleAt?: string;
  liveWaiting?: GmailMonitorWaiting | null;
  proposalWaiting?: GmailMonitorWaiting | null;
}

export interface GmailMonitorWaiting {
  readonly reason: 'daily_ai_limit' | 'rate_limit';
  readonly resumesAt: string;
  readonly generation: string;
  readonly providerAccountId: string;
}

export function publicMonitorWaiting(monitor: GmailMonitor | null): Pick<GmailMonitorWaiting, 'reason' | 'resumesAt'> | null {
  if (!monitor?.m5) return null;
  const applicable = [monitor.liveWaiting, monitor.proposalWaiting].filter((wait): wait is GmailMonitorWaiting => Boolean(wait
    && wait.generation === monitor.generation && wait.providerAccountId === monitor.m5!.providerAccountId));
  if (applicable.length === 0) return null;
  const chosen = applicable.find(wait => wait.reason === 'daily_ai_limit') ?? applicable[0]!;
  return { reason: chosen.reason, resumesAt: chosen.resumesAt };
}

function monitorPath(uid: string): string {
  requireUserId(uid);
  return `${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`;
}

function markerPath(uid: string, messageId: string): string {
  const id = createHash('sha256').update(`gmail\0${messageId}`).digest('hex');
  return `${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${id}`;
}

function transportFor(uid: string, runtime: GoogleRuntime): GmailTransport {
  return createGmailTransport({
    accessToken: () => googleAccessToken(uid, 'gmail', runtime),
    reauth: () => googleAccessToken(uid, 'gmail', runtime, { forceRefresh: true }),
    fetchImpl: runtime.fetchImpl,
    rejectHistoryTruncation: true,
  });
}

function excludedFromMonitor(monitor: GmailMonitor, at: string): boolean {
  if (!monitor.m5) return false;
  const instant = Date.parse(at);
  return instant < Date.parse(monitor.m5.enabledAt) || monitor.m5.excluded.some(interval =>
    instant >= Date.parse(interval.from) && instant < Date.parse(interval.to));
}

async function assertEnrolledMonitorAuthority(uid: string, expected: GmailMonitor, owner: string, runtime: GoogleRuntime): Promise<GmailMonitor> {
  const current = await readGmailMonitor(uid, runtime.storage);
  if (!current?.enabled || current.generation !== expected.generation || current.lease?.owner !== owner
    || current.m5?.pauseEpoch !== expected.m5?.pauseEpoch || current.m5?.pausedSince) throw new Error('monitor_disabled');
  if (current.m5 && await connectedGmailAccount(uid, runtime) !== current.m5.providerAccountId) {
    await runtime.storage.runTransaction(async tx => {
      const latest = await tx.get<GmailMonitor>(monitorPath(uid));
      if (latest?.generation === current.generation) tx.set(monitorPath(uid), {
        ...latest, enabled: false, generation: randomUUID(), cursor: null, pageToken: null,
        lease: null, leaseUntil: null, liveWaiting: null, proposalWaiting: null,
      });
    });
    throw new Error('reconnect_needed');
  }
  return current;
}

export async function readGmailMonitor(uid: string, storage: StorageAdapter = getStorage()): Promise<GmailMonitor | null> {
  return storage.get<GmailMonitor>(monitorPath(uid));
}

/** The person explicitly opts in. A new enablement starts at the current mailbox cursor. */
function monitorTimezone(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date()); return value; }
  catch { throw new Error('invalid_timezone'); }
}

function validStoredTimezone(value: unknown): string | null {
  try { return monitorTimezone(value); } catch { return null; }
}

export interface SweepWindow {
  readonly day: string;
  readonly from: string;
  readonly until: string;
  readonly dueAt: string;
  readonly timezone: string;
}

/** One civil day; using local midnights makes 23/25-hour DST days exact. */
export function sweepWindowFor(enabledAt: string, timezone: string, day = localDayKey(enabledAt, timezone)): SweepWindow {
  const midnight = localMidnightOf(day, timezone);
  const until = addLocalDays(midnight, 1, timezone);
  return {
    day,
    from: new Date(Math.max(Date.parse(midnight), Date.parse(enabledAt))).toISOString(),
    until,
    dueAt: new Date(Date.parse(until) + 3 * 60 * 60_000).toISOString(),
    timezone,
  };
}

export async function setGmailMonitor(
  uid: string,
  enabled: boolean,
  runtime: GoogleRuntime = googleRuntime(),
  options: { enrollM5?: boolean; timezone?: unknown } = {},
): Promise<GmailMonitor> {
  if (enabled) {
    if (!intelligenceEnabled(runtime.env as Record<string, string | undefined>)) throw new Error('feature_unavailable');
    if (await getAiConsent(uid, { storage: runtime.storage }) !== 'granted') throw new Error('consent_required');
    await requireReadableFeature(uid, 'gmail', runtime);
  }
  const now = runtime.now().toISOString();
  const timezone = options.timezone === undefined ? undefined : monitorTimezone(options.timezone);
  const providerAccountId = enabled && options.enrollM5 ? await connectedGmailAccount(uid, runtime) : null;
  if (enabled && options.enrollM5 && !providerAccountId) throw new Error('reconnect_needed');
  return runtime.storage.runTransaction(async tx => {
    const path = monitorPath(uid);
    const dailyPath = `${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/dailyV2`;
    const [current, daily, user] = await Promise.all([
      tx.get<GmailMonitor>(path),
      tx.get<{ status?: string }>(dailyPath),
      tx.get<Record<string, unknown>>(userDoc(uid)),
    ]);
    if (current?.enabled === enabled && !options.enrollM5) return current;
    const existingM5 = current?.m5;
    const enrolling = enabled && options.enrollM5;
    const sameIdentity = enrolling && existingM5?.providerAccountId === providerAccountId;
    const enabledAt = sameIdentity && current?.enabled ? existingM5.enabledAt : now;
    const storedTimezone = timezone === undefined ? existingM5?.timezone ?? null : timezone;
    const accountTimezone = validStoredTimezone(user?.timezone);
    const sweepTimezone = accountTimezone ?? storedTimezone;
    const window = enrolling && sweepTimezone ? sweepWindowFor(enabledAt, sweepTimezone) : null;
    const m5 = enrolling ? {
      v: 1 as const, providerAccountId: providerAccountId!, enabledAt,
      timezone: storedTimezone, at: existingM5?.at ?? now,
      pauseEpoch: sameIdentity ? existingM5?.pauseEpoch ?? 0 : 0,
      pausedSince: sameIdentity ? existingM5?.pausedSince ?? null : null,
      excluded: sameIdentity ? existingM5?.excluded ?? [] : [],
      ...(window ? { nextSweepAt: window.dueAt, sweepTimezone: sweepTimezone!, pendingSweepDay: window.day, pendingSweepFrom: window.from } : {}),
    } : existingM5
      ? enabled ? existingM5 : (({ nextSweepAt: _next, ...rest }) => rest)(existingM5)
      : undefined;
    const stateChanged = current?.enabled !== enabled;
    const next: GmailMonitor = {
      enabled, generation: !stateChanged && current ? current.generation : randomUUID(), cursor: current?.cursor ?? null,
      pageToken: null, nextPollAt: now, leaseUntil: null, lease: null,
      lastSuccessAt: current?.lastSuccessAt ?? null, error: null,
      proposalsVersion: current?.proposalsVersion ?? 0,
      proposalsDoneVersion: current?.proposalsDoneVersion ?? 0,
      proposalsPending: false,
      proposalNextEligibleAt: now,
      liveWaiting: null,
      proposalWaiting: null,
      ...(m5 ? { m5 } : {}),
    };
    tx.set(path, next);
    if (daily?.status === 'held') tx.delete(dailyPath);
    if (!enabled && daily && (daily.status === 'running' || daily.status === 'failed')) tx.set(dailyPath, {
      ...daily, status: 'failed', failure: 'monitoring_off', failedAt: now,
      leaseOwner: null, leaseUntil: null,
    });
    return next;
  });
}

export interface GmailMonitorTick {
  enabled: boolean;
  accountsChecked: number;
  messagesAnalyzed: number;
  failures: number;
}

/** One bounded staging account per cron call. A cursor advances only after all messages on a page were analyzed. */
export async function runGmailMonitorTick(
  runtime: GoogleRuntime = googleRuntime(),
  options: { uid?: string; transport?: (uid: string) => Pick<GmailTransport, 'listHistory'>; ensureReadable?: (uid: string) => Promise<void> } = {},
): Promise<GmailMonitorTick> {
  if (!intelligenceEnabled(runtime.env as Record<string, string | undefined>)) {
    return { enabled: false, accountsChecked: 0, messagesAnalyzed: 0, failures: 0 };
  }
  const now = runtime.now().toISOString();
  const rows = options.uid
    ? await runtime.storage.get<GmailMonitor>(monitorPath(options.uid)).then(monitor => monitor && monitor.enabled && monitor.nextPollAt <= now
      ? [{ id: 'gmail', path: monitorPath(options.uid!), data: monitor }] : [])
    : await runtime.storage.listGroup<GmailMonitor>(INTELLIGENCE_MONITORS, {
      where: [['enabled', '==', true], ['nextPollAt', '<=', now]],
      orderBy: { field: 'nextPollAt', direction: 'asc' }, limit: 1,
    });
  let checked = 0;
  let analyzed = 0;
  let failures = 0;
  for (const row of rows) {
    const match = /^users\/([A-Za-z0-9_-]{1,128})\/intelligenceMonitors\/gmail$/.exec(row.path);
    if (!match) continue;
    const uid = match[1]!;
    const claim = randomUUID();
    const acquired = await runtime.storage.runTransaction(async tx => {
      const current = await tx.get<GmailMonitor>(monitorPath(uid));
      const activeLease = current?.m5 ? current.lease?.leaseUntil : current?.leaseUntil;
      if (!current?.enabled || current.nextPollAt > now || (activeLease && activeLease > now)) return null;
      if (current.m5) {
        tx.set(monitorPath(uid), { ...current, lease: { owner: claim, leaseUntil: new Date(Date.parse(now) + 120_000).toISOString() } });
        return current;
      }
      // Exact legacy behaviour for monitors that never enrolled in M5a.
      tx.set(monitorPath(uid), { ...current, leaseUntil: new Date(Date.parse(now) + 55_000).toISOString(), generation: claim });
      return { ...current, generation: claim };
    });
    if (!acquired) continue;
    checked++;
    try {
      if (acquired.m5) await assertEnrolledMonitorAuthority(uid, acquired, claim, runtime);
      if (await isMonitoringPaused(uid, runtime.storage)) {
        await runtime.storage.runTransaction(async tx => {
          const current = await tx.get<GmailMonitor>(monitorPath(uid));
          if (!current || (current.m5 ? current.generation !== acquired.generation || current.lease?.owner !== claim : current.generation !== claim)) return;
          tx.set(monitorPath(uid), { ...current, leaseUntil: null, lease: null,
            nextPollAt: new Date(Date.parse(now) + 5 * 60_000).toISOString() });
        });
        continue;
      }
      if (await getAiConsent(uid, { storage: runtime.storage }) !== 'granted') throw new Error('analysis_unavailable');
      await (options.ensureReadable?.(uid) ?? requireReadableFeature(uid, 'gmail', runtime));
      const transport = options.transport?.(uid) ?? transportFor(uid, runtime);
      if (acquired.m5) await assertEnrolledMonitorAuthority(uid, acquired, claim, runtime);
      const page = await transport.listHistory({
        connectionId: 'intelligence', startHistoryId: acquired.cursor,
        pageToken: acquired.pageToken, maxResults: 10,
      });
      const arbitrate = await legacyGmailArbitrationEnabled(runtime);
      let providerAccountId = arbitrate ? await connectedGmailAccount(uid, runtime) : null;
      if (arbitrate && !providerAccountId) throw new Error('source_unavailable');
      // Baseline is deliberate: monitoring future mail never silently imports an old mailbox.
      let processed = 0;
      let newObservations = 0;
      let remaining = false;
      for (const message of page.messages) {
        if (processed >= 4) { remaining = true; break; }
        if (acquired.m5) {
          const current = await assertEnrolledMonitorAuthority(uid, acquired, claim, runtime);
          if (excludedFromMonitor(current, message.receivedAt)) { processed++; continue; }
        }
        const existingMarker = await runtime.storage.get<Record<string, unknown>>(markerPath(uid, message.id));
        const useArbitration = arbitrate || existingMarker?.v === 2;
        if (useArbitration) {
          providerAccountId ??= await connectedGmailAccount(uid, runtime);
          if (!providerAccountId) throw new Error('source_unavailable');
          const result = await analyzeArbitratedGmailMessage(uid, providerAccountId!, message, runtime, {
            path: monitorPath(uid), generation: acquired.generation,
          });
          if (result.kind === 'blocked') { remaining = true; break; }
          if (result.kind === 'processed') {
            newObservations += result.observations.length;
            analyzed++;
          }
          processed++;
          continue;
        }
        if (existingMarker) continue;
        const current = await readGmailMonitor(uid, runtime.storage);
        if (!current?.enabled || current.generation !== acquired.generation
          || (current.m5 && (current.lease?.owner !== claim || current.m5.pauseEpoch !== acquired.m5?.pauseEpoch))) throw new Error('monitor_disabled');
        const content = [message.subject ?? '', message.text].filter(Boolean).join('\n');
        if (content.trim() && content.length <= 12_000) {
          const found = await analyzeSource(uid, 'gmail', message.id, content, message.receivedAt,
            runtime.shareModel
              ? { generate: runtime.shareModel, storage: runtime.storage, monitorGuard: { path: monitorPath(uid), generation: acquired.generation } }
              : { storage: runtime.storage, monitorGuard: { path: monitorPath(uid), generation: acquired.generation } });
          newObservations += found.length;
          analyzed++;
        }
        await runtime.storage.set(markerPath(uid, message.id), { processedAt: now });
        processed++;
      }
      await runtime.storage.runTransaction(async tx => {
        const current = await tx.get<GmailMonitor>(monitorPath(uid));
        if (!current?.enabled || current.generation !== acquired.generation
          || (current.m5 && (current.lease?.owner !== claim || current.m5.pauseEpoch !== acquired.m5?.pauseEpoch))) return;
        tx.set(monitorPath(uid), {
          ...current,
          cursor: remaining ? acquired.cursor : page.nextPageToken ? acquired.cursor : page.historyId,
          pageToken: remaining ? acquired.pageToken : page.nextPageToken,
          leaseUntil: null, lease: null,
          nextPollAt: new Date(Date.parse(now) + (remaining || page.nextPageToken ? 60_000 : page.messages.length > 0 ? 5 * 60_000 : 15 * 60_000)).toISOString(),
          lastSuccessAt: now, error: null,
          ...(newObservations > 0 ? {
            proposalsVersion: (current.proposalsVersion ?? 0) + 1,
            proposalsPending: true,
            proposalNextEligibleAt: now,
          } : {}),
        });
      });
    } catch (error) {
      failures++;
      await runtime.storage.runTransaction(async tx => {
        const current = await tx.get<GmailMonitor>(monitorPath(uid));
        if (!current || (current.m5 ? current.generation !== acquired.generation || current.lease?.owner !== claim : current.generation !== claim)) return;
        tx.set(monitorPath(uid), { ...current, leaseUntil: null, lease: null,
          nextPollAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
          error: error instanceof Error && error.message === 'source_analysis_failed' || error instanceof Error && error.message === 'analysis_unavailable'
            ? 'analysis_unavailable' : 'source_unavailable' });
      });
    }
  }
  return { enabled: true, accountsChecked: checked, messagesAnalyzed: analyzed, failures };
}
