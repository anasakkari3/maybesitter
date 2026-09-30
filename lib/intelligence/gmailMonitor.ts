import { createHash, randomUUID } from 'node:crypto';
import { createGmailTransport, type GmailTransport } from '../integrations/gmail/production/gmailTransport';
import { googleAccessToken, requireReadableFeature } from '../integrations/google/googleConnectService';
import { googleRuntime, type GoogleRuntime } from '../integrations/google/googleRuntime';
import { getAiConsent } from '../consents/aiConsentService';
import { getStorage, INTELLIGENCE_MONITORS, INTELLIGENCE_SOURCE_MARKERS, requireUserId, userCol, type StorageAdapter } from '../storage';
import { intelligenceEnabled } from './gate';
import { analyzeSource } from './analyzeSource';
import { proposeFromObservations } from './proposalEngine';
import { isMonitoringPaused } from '../watchers/monitoringSettings';

export interface GmailMonitor {
  enabled: boolean;
  generation: string;
  cursor: string | null;
  pageToken: string | null;
  nextPollAt: string;
  leaseUntil: string | null;
  lastSuccessAt: string | null;
  error: 'source_unavailable' | 'analysis_unavailable' | null;
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

export async function readGmailMonitor(uid: string, storage: StorageAdapter = getStorage()): Promise<GmailMonitor | null> {
  return storage.get<GmailMonitor>(monitorPath(uid));
}

/** The person explicitly opts in. A new enablement starts at the current mailbox cursor. */
export async function setGmailMonitor(uid: string, enabled: boolean, runtime: GoogleRuntime = googleRuntime()): Promise<GmailMonitor> {
  if (enabled) {
    if (!intelligenceEnabled(runtime.env as Record<string, string | undefined>)) throw new Error('feature_unavailable');
    if (await getAiConsent(uid, { storage: runtime.storage }) !== 'granted') throw new Error('consent_required');
    await requireReadableFeature(uid, 'gmail', runtime);
  }
  const now = runtime.now().toISOString();
  return runtime.storage.runTransaction(async tx => {
    const path = monitorPath(uid);
    const current = await tx.get<GmailMonitor>(path);
    if (current?.enabled === enabled) return current;
    const next: GmailMonitor = {
      enabled, generation: randomUUID(), cursor: enabled ? null : current?.cursor ?? null,
      pageToken: null, nextPollAt: now, leaseUntil: null,
      lastSuccessAt: current?.lastSuccessAt ?? null, error: null,
    };
    tx.set(path, next);
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
  options: { transport?: (uid: string) => Pick<GmailTransport, 'listHistory'>; ensureReadable?: (uid: string) => Promise<void> } = {},
): Promise<GmailMonitorTick> {
  if (!intelligenceEnabled(runtime.env as Record<string, string | undefined>)) {
    return { enabled: false, accountsChecked: 0, messagesAnalyzed: 0, failures: 0 };
  }
  const now = runtime.now().toISOString();
  const rows = await runtime.storage.listGroup<GmailMonitor>(INTELLIGENCE_MONITORS, {
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
      if (!current?.enabled || current.nextPollAt > now || (current.leaseUntil && current.leaseUntil > now)) return null;
      tx.set(monitorPath(uid), { ...current, leaseUntil: new Date(Date.parse(now) + 55_000).toISOString(), generation: claim });
      return { ...current, generation: claim };
    });
    if (!acquired) continue;
    checked++;
    try {
      if (await isMonitoringPaused(uid, runtime.storage)) {
        await runtime.storage.runTransaction(async tx => {
          const current = await tx.get<GmailMonitor>(monitorPath(uid));
          if (current?.generation !== claim) return;
          tx.set(monitorPath(uid), { ...current, leaseUntil: null,
            nextPollAt: new Date(Date.parse(now) + 5 * 60_000).toISOString() });
        });
        continue;
      }
      if (await getAiConsent(uid, { storage: runtime.storage }) !== 'granted') throw new Error('analysis_unavailable');
      await (options.ensureReadable?.(uid) ?? requireReadableFeature(uid, 'gmail', runtime));
      const transport = options.transport?.(uid) ?? transportFor(uid, runtime);
      const page = await transport.listHistory({
        connectionId: 'intelligence', startHistoryId: acquired.cursor,
        pageToken: acquired.pageToken, maxResults: 10,
      });
      // Baseline is deliberate: monitoring future mail never silently imports an old mailbox.
      let processed = 0;
      let newObservations = 0;
      let remaining = false;
      for (const message of page.messages) {
        if (processed >= 4) { remaining = true; break; }
        if (await runtime.storage.get(markerPath(uid, message.id))) continue;
        const current = await readGmailMonitor(uid, runtime.storage);
        if (!current?.enabled || current.generation !== claim) throw new Error('monitor_disabled');
        const content = [message.subject ?? '', message.text].filter(Boolean).join('\n');
        if (content.trim() && content.length <= 12_000) {
          const found = await analyzeSource(uid, 'gmail', message.id, content, message.receivedAt,
            runtime.shareModel
              ? { generate: runtime.shareModel, storage: runtime.storage, monitorGuard: { path: monitorPath(uid), generation: claim } }
              : { storage: runtime.storage, monitorGuard: { path: monitorPath(uid), generation: claim } });
          newObservations += found.length;
          analyzed++;
        }
        await runtime.storage.set(markerPath(uid, message.id), { processedAt: now });
        processed++;
      }
      await runtime.storage.runTransaction(async tx => {
        const current = await tx.get<GmailMonitor>(monitorPath(uid));
        if (current?.generation !== claim || !current.enabled) return;
        tx.set(monitorPath(uid), {
          ...current,
          cursor: remaining ? acquired.cursor : page.nextPageToken ? acquired.cursor : page.historyId,
          pageToken: remaining ? acquired.pageToken : page.nextPageToken,
          leaseUntil: null,
          nextPollAt: new Date(Date.parse(now) + (remaining || page.nextPageToken ? 60_000 : 5 * 60_000)).toISOString(),
          lastSuccessAt: now, error: null,
        });
      });
      if (newObservations > 0) {
        // The inbox is ready before the next app open. This is still proposal
        // generation only: no commitment is written until the person accepts.
        try {
          await proposeFromObservations(uid, now, runtime.shareModel
            ? { storage: runtime.storage, generate: runtime.shareModel } : { storage: runtime.storage });
        } catch { /* The source cursor is already safe; opening Today can retry generation. */ }
      }
    } catch (error) {
      failures++;
      await runtime.storage.runTransaction(async tx => {
        const current = await tx.get<GmailMonitor>(monitorPath(uid));
        if (current?.generation !== claim) return;
        tx.set(monitorPath(uid), { ...current, leaseUntil: null,
          nextPollAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
          error: error instanceof Error && error.message === 'source_analysis_failed' || error instanceof Error && error.message === 'analysis_unavailable'
            ? 'analysis_unavailable' : 'source_unavailable' });
      });
    }
  }
  return { enabled: true, accountsChecked: checked, messagesAnalyzed: analyzed, failures };
}
