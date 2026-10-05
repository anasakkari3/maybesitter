import { createHash, randomUUID } from 'node:crypto';
import { createGmailTransport, type GmailTransport } from '../integrations/gmail/production/gmailTransport';
import { googleAccessToken, requireReadableFeature } from '../integrations/google/googleConnectService';
import type { GoogleRuntime } from '../integrations/google/googleRuntime';
import { INTELLIGENCE_GMAIL_SCANS, INTELLIGENCE_SOURCE_MARKERS, userCol } from '../storage';
import { analyzeSource } from './analyzeSource';
import type { StoredObservation } from './observationStore';

// Bound each HTTP request, never the number of messages in the seven-day window.
// Three model calls (at most eight seconds each) leave room for Gmail reads.
const PAGE_SIZE = 3;
const LEASE_MS = 90_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;

interface WeekScan {
  id: string;
  query: string;
  from: string;
  until: string;
  pageToken: string | null;
  messagesVisited: number;
  status: 'running' | 'complete';
  leaseUntil: string | null;
  leaseOwner: string | null;
}

export interface GmailIntelligenceScanResult {
  messagesRead: number;
  observations: StoredObservation[];
  scan: { status: 'running' | 'complete' | 'busy'; messagesVisited: number };
}

function scanPath(uid: string): string {
  return `${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/latest`;
}

function markerPath(uid: string, messageId: string): string {
  const id = createHash('sha256').update(`gmail\0${messageId}`).digest('hex');
  return `${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${id}`;
}

/** One resumable page from a frozen seven-day Gmail window. No overall count limit. */
export async function scanGmailIntelligence(
  uid: string, runtime: GoogleRuntime,
  options: { transport?: Pick<GmailTransport, 'listRecentMessagePage'>; ensureReadable?: (uid: string) => Promise<void> } = {},
): Promise<GmailIntelligenceScanResult> {
  await (options.ensureReadable?.(uid) ?? requireReadableFeature(uid, 'gmail', runtime));
  const storage = runtime.storage;
  const now = runtime.now();
  const nowIso = now.toISOString();
  const owner = randomUUID();
  const path = scanPath(uid);
  const claimed = await storage.runTransaction(async tx => {
    const existing = await tx.get<WeekScan>(path);
    if (existing?.status === 'running' && existing.leaseUntil && existing.leaseUntil > nowIso) return null;
    const start = new Date(now.getTime() - WEEK_MS);
    const next: WeekScan = existing?.status === 'running' ? {
      ...existing, leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
    } : {
      id: randomUUID(),
      query: `after:${Math.floor(start.getTime() / 1000)} before:${Math.ceil(now.getTime() / 1000) + 1}`,
      from: start.toISOString(), until: nowIso, pageToken: null, messagesVisited: 0,
      status: 'running', leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
    };
    tx.set(path, next);
    return next;
  });
  if (!claimed) {
    const current = await storage.get<WeekScan>(path);
    return { messagesRead: 0, observations: [], scan: { status: 'busy', messagesVisited: current?.messagesVisited ?? 0 } };
  }

  try {
    const transport = options.transport ?? createGmailTransport({
      accessToken: () => googleAccessToken(uid, 'gmail', runtime),
      reauth: () => googleAccessToken(uid, 'gmail', runtime, { forceRefresh: true }),
      fetchImpl: runtime.fetchImpl,
    });
    const page = await transport.listRecentMessagePage({
      query: claimed.query, maxResults: PAGE_SIZE, pageToken: claimed.pageToken,
    });
    if (page.nextPageToken && page.nextPageToken === claimed.pageToken) throw new Error('gmail_page_token_repeated');
    const observations: StoredObservation[] = [];
    for (const message of page.messages) {
      const received = Date.parse(message.receivedAt);
      if (received < Date.parse(claimed.from) || received > Date.parse(claimed.until)) continue;
      const marker = markerPath(uid, message.id);
      if (await storage.get(marker)) continue;
      const text = [message.subject ?? '', message.text].filter(Boolean).join('\n');
      if (text.trim() && text.length <= 12_000) {
        observations.push(...await analyzeSource(uid, 'gmail', message.id, text, message.receivedAt,
          runtime.shareModel ? { generate: runtime.shareModel, storage } : { storage }));
      }
      await storage.set(marker, { processedAt: nowIso });
    }
    const completed = page.nextPageToken === null;
    const visited = claimed.messagesVisited + page.messages.length;
    await storage.runTransaction(async tx => {
      const current = await tx.get<WeekScan>(path);
      if (current?.id !== claimed.id || current.leaseOwner !== owner) throw new Error('gmail_scan_lease_lost');
      tx.set(path, { ...current, pageToken: page.nextPageToken, messagesVisited: visited,
        status: completed ? 'complete' : 'running', leaseOwner: null, leaseUntil: null });
    });
    return { messagesRead: page.messages.length, observations,
      scan: { status: completed ? 'complete' : 'running', messagesVisited: visited } };
  } catch (error) {
    await storage.runTransaction(async tx => {
      const current = await tx.get<WeekScan>(path);
      if (current?.id === claimed.id && current.leaseOwner === owner) {
        tx.set(path, { ...current, leaseOwner: null, leaseUntil: null });
      }
    });
    throw error;
  }
}
