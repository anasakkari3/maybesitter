import { createHash, randomUUID } from 'node:crypto';
import { applyCommand, type Command, type DomainEvent } from '../../src/domain/stateMachine';
import { mapExtractionToCommand } from '../../src/extraction/mapExtractionToCommand';
import { extract as ruleBasedExtract } from '../../src/extraction/ruleBasedExtractor';
import { extractWithOllama } from '../../src/extraction/ollamaExtractor';
import { LLMUnavailableError } from '../../src/extraction/llm';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts';
import { createGmailTransport, type GmailTransport } from '../integrations/gmail/production/gmailTransport';
import { GmailProviderError } from '../integrations/gmail/adapter';
import { googleAccessToken, requireReadableFeature } from '../integrations/google/googleConnectService';
import type { GoogleRuntime } from '../integrations/google/googleRuntime';
import { connectionIdFor } from '../integrations/providers/production/storedConnectionStore';
import { candidateClashes, runScheduleDecisionHook } from '../planning/freeSlots';
import { cleanEmail } from '../services/share/emailCleaner';
import { captureLlmProvider } from '../llm/captureProvider';
import { shareLlmProvider, type ShareStructuredGenerator } from '../llm/shareProvider';
import {
  finalizeQuotaPermit,
  quotaScopeFor,
  reserveQuotaPermit,
  retryAfterSecondsFor,
  settleQuotaPermitSlot,
  startQuotaPermitSlot,
  type QuotaPermit,
  type QuotaPermitOutcome,
} from '../llm/usageGuard';
import { writeDomainDiff } from '../services/mobile/participantState';
import { readActivityStats, recordActivityEvents } from '../services/activity/activityStats';
import {
  getStorage,
  INTELLIGENCE_AUTO_ADDS,
  INTELLIGENCE_GMAIL_SCANS,
  INTELLIGENCE_MONITORS,
  INTELLIGENCE_OBSERVATIONS,
  INTELLIGENCE_SOURCE_MARKERS,
  PROVIDER_CONNECTIONS,
  userCol,
  userDoc,
  userSubDoc,
  type StorageAdapter,
} from '../storage';
import { M5A_CONTROLS_PATH, parseM5aControls } from '../release/m5aControls';
import { analyzeSourceStaged } from './analyzeSource';
import { autoAddPath, commitmentBaselineFingerprint, type AutoAddRecord } from './autoAdds';
import { observationId, type StoredObservation } from './observationStore';
import { ownTextOf } from './ownText';
import type { SemanticObservation } from './semantic';
import { loadAutoAddSnapshot } from './autoAddSnapshot';
import { addLocalDays, localDayKey, localMidnightOf } from '../services/mobile/time';
import { calendarCoverageForEmail, waitForCalendarAndFetch } from './gmailCalendarJit';
import { legacyMarkerIdFor, providerMarkerIdFor } from '../watchers/monitoringSettings';
import { liveAccount } from './memoryBasis';

export { legacyMarkerIdFor, providerMarkerIdFor } from '../watchers/monitoringSettings';

const WEEK_MS = 7 * 24 * 60 * 60_000;
/**
 * What one message's permit reserves. The read is up to 12,000 characters
 * (about 6,000 tokens at the densest) plus SEMANTIC_MAX_OUTPUT_TOKENS (2,048);
 * a self-reply's second call adds a capture call's share. Sized to the worst
 * case so usage settled after the call cannot pass the daily cap (#814).
 */
export const M5A_PERMIT_TOKENS = Object.freeze({ oneCall: 9_000, twoCalls: 11_500, captureSlot: 2_500 });
const LEASE_MS = 120_000;

export type ScanFailure = 'reconnect_needed' | 'source_unavailable' | 'analysis_unavailable' | 'monitoring_off' | 'daily_limit';
export type Receipt = 'read' | 'unavailable';
export type M5aUnitKind = 'manual' | 'daily' | 'live';

export interface M5aMarker {
  readonly v: 2;
  readonly state: 'claimed' | 'done' | 'unavailable' | 'released' | 'waiting_for_calendar';
  readonly owner?: string;
  readonly leaseUntil?: string;
  readonly providerAccountId?: string;
  readonly providerMarkerId?: string;
  readonly preexisting?: boolean;
  readonly processedAt?: string;
  readonly outcome?: 'analyzed' | 'trimmed' | 'empty' | 'bulk';
  readonly observationIds?: readonly string[];
  readonly autoAddId?: string | null;
  readonly receipts?: Readonly<Record<string, Receipt>>;
  readonly messageId?: string;
  readonly emailEpoch?: number;
  readonly origin?: {
    readonly kind: 'scan';
    readonly scanId: string;
    readonly scanKind: M5aUnitKind;
    readonly monitorGeneration?: string;
    readonly pauseEpoch?: number;
  } | {
    readonly kind: 'monitor';
    readonly generation: string;
    readonly pauseEpoch: number;
  };
  readonly requestedAt?: string;
  readonly nextEligibleAt?: string;
}

export interface ScanCounts {
  messagesRead: number;
  /** Optional while persisted scans created by older builds still exist. */
  messagesSkippedBulk?: number;
  messagesUnavailable: number;
  messagesTrimmed: number;
  observationsFound: number;
  addedFromEmail: number;
}

interface QueuedScan {
  scanId: string;
  origin: 'manual' | 'backfill';
  from: string;
  until: string;
  acceptedAt: string;
  timezone: string | null;
  providerAccountId: string;
  emailEpoch: number;
}

export interface M5aScanDocument extends ScanCounts {
  scanId: string;
  kind: M5aUnitKind;
  status: 'running' | 'complete' | 'failed';
  origin: 'manual' | 'backfill' | 'live';
  providerAccountId: string;
  emailEpoch: number;
  query: string;
  from: string;
  until: string;
  timezone: string | null;
  startedAt: string;
  finishedAt: string | null;
  failedAt: string | null;
  failure: ScanFailure | null;
  pageToken: string | null;
  page: { ids: string[]; nextPageToken: string | null; done: string[] } | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  queued: QueuedScan | null;
  nextEligibleAt: string;
  waiting?: { reason: 'daily_ai_limit' | 'rate_limit'; resumesAt: string } | null;
  day?: string;
  monitorGeneration?: string;
  pauseEpoch?: number;
  excluded?: Array<{ from: string; to: string }>;
  liveHistoryId?: string;
  liveNextPageToken?: string | null;
}

export interface ReceiptTransition {
  marker: M5aMarker;
  readDelta: number;
  unavailableDelta: number;
}

export type MarkerReader = 'm5a' | 'base' | 'cleanup';
export type MarkerDecision = 'claim' | 'takeover' | 'count' | 'process' | 'skip' | 'block' | 'release' | 'none';

/**
 * The shared marker-state table. Keeping the decision in one pure function is
 * important: rollback readers must not regress to the old "any marker means
 * processed" rule while an M5a owner still holds a live claim.
 */
export function markerDecision(
  marker: M5aMarker | Record<string, unknown> | null | undefined,
  reader: MarkerReader,
  now: string,
  providerAccountId?: string,
): MarkerDecision {
  if (!marker) return reader === 'm5a' ? 'claim' : reader === 'base' ? 'process' : 'none';
  if ((marker as M5aMarker).v !== 2) return reader === 'm5a' ? 'claim' : reader === 'base' ? 'skip' : 'none';
  const current = marker as M5aMarker;
  if (current.state === 'released' || current.state === 'unavailable') {
    return reader === 'm5a' ? 'claim' : reader === 'base' ? 'process' : 'none';
  }
  if (current.state === 'done') return reader === 'm5a' ? 'count' : reader === 'base' ? 'skip' : 'none';
  if (current.state === 'waiting_for_calendar') return reader === 'cleanup' ? 'release' : 'block';
  if (current.state === 'claimed') {
    if ((current.leaseUntil ?? '') > now) return 'block';
    if (reader === 'cleanup') return 'none';
    if (reader === 'base' && current.providerAccountId && current.providerAccountId !== providerAccountId) return 'skip';
    return 'takeover';
  }
  return reader === 'cleanup' ? 'none' : 'block';
}

/** The sole receipt transition: a scan counts one terminal outcome, and read wins after restoration. */
export function transitionReceipt(
  marker: M5aMarker,
  scanId: string,
  next: Receipt,
  activeScanIds?: readonly string[],
): ReceiptTransition {
  const previous = marker.receipts?.[scanId];
  const active = activeScanIds ? new Set([...activeScanIds, scanId]) : null;
  const kept = Object.fromEntries(Object.entries(marker.receipts ?? {}).filter(([id]) => !active || active.has(id)));
  const receipts = { ...kept, [scanId]: previous === 'read' ? 'read' : next };
  if (previous === next || previous === 'read') return { marker: { ...marker, receipts }, readDelta: 0, unavailableDelta: 0 };
  return {
    marker: { ...marker, receipts },
    readDelta: next === 'read' ? 1 : 0,
    unavailableDelta: next === 'unavailable' ? 1 : previous === 'unavailable' ? -1 : 0,
  };
}

export function gmailRefFor(providerAccountId: string, messageId: string): string {
  return createHash('sha256').update(`${providerAccountId}\0${messageId}`).digest('hex');
}

export function autoAddIdFor(uid: string, providerAccountId: string, messageId: string): string {
  return createHash('sha256').update(`${uid}\0${providerAccountId}\0${messageId}`).digest('hex');
}

function scanPath(uid: string): string {
  return `${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/manualV2`;
}

function dailyScanPath(uid: string): string {
  return `${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/dailyV2`;
}

function scanDocumentPath(uid: string, kind: M5aUnitKind): string {
  return kind === 'daily' ? dailyScanPath(uid)
    : kind === 'live' ? `${userCol(uid, INTELLIGENCE_GMAIL_SCANS)}/liveV2` : scanPath(uid);
}

function markerPath(uid: string, markerId: string): string {
  return `${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${markerId}`;
}

function observationPath(uid: string, id: string): string {
  return `${userCol(uid, INTELLIGENCE_OBSERVATIONS)}/${id}`;
}

const emptyCounts = (): ScanCounts => ({
  messagesRead: 0, messagesSkippedBulk: 0, messagesUnavailable: 0, messagesTrimmed: 0,
  observationsFound: 0, addedFromEmail: 0,
});

function isLiveConnection(connection: IntegrationConnectionRecord | null): connection is IntegrationConnectionRecord {
  return Boolean(connection && connection.identity.providerAccountId && connection.credentialRef
    && connection.state !== 'revoked' && connection.state !== 'not_connected'
    && connection.capabilities.includes('mail_read'));
}

async function providerAccountId(uid: string, storage: StorageAdapter): Promise<string> {
  const connection = await storage.get<IntegrationConnectionRecord>(
    userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')),
  );
  if (!isLiveConnection(connection)) throw new Error('reconnect_needed');
  return connection.identity.providerAccountId!;
}

function validTimezone(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date()); return value; }
  catch { return null; }
}

function newQueued(now: Date, origin: 'manual' | 'backfill', timezone: string | null, provider: string, emailEpoch: number): QueuedScan {
  return {
    scanId: randomUUID(), origin, from: new Date(now.getTime() - WEEK_MS).toISOString(),
    until: now.toISOString(), acceptedAt: now.toISOString(), timezone,
    providerAccountId: provider, emailEpoch,
  };
}

function documentFromQueued(queue: QueuedScan): M5aScanDocument {
  return {
    ...emptyCounts(), scanId: queue.scanId, kind: 'manual', status: 'running', origin: queue.origin,
    providerAccountId: queue.providerAccountId, emailEpoch: queue.emailEpoch,
    query: `after:${Math.floor(Date.parse(queue.from) / 1000)} before:${Math.ceil(Date.parse(queue.until) / 1000) + 1}`,
    from: queue.from, until: queue.until, timezone: queue.timezone, startedAt: queue.acceptedAt,
    finishedAt: null, failedAt: null, failure: null, pageToken: null, page: null,
    leaseOwner: null, leaseUntil: null, queued: null, nextEligibleAt: queue.acceptedAt,
  };
}

/** Gmail search windows exclude paused intervals before any message body read. */
export function gmailQueryOutsideIntervals(
  from: string,
  until: string,
  excluded: readonly { from: string; to: string }[] = [],
): string {
  const start = Date.parse(from);
  const end = Date.parse(until);
  let cursor = start;
  const windows: Array<{ from: number; until: number }> = [];
  for (const interval of [...excluded].sort((a, b) => Date.parse(a.from) - Date.parse(b.from))) {
    const blockedFrom = Math.max(start, Date.parse(interval.from));
    const blockedUntil = Math.min(end, Date.parse(interval.to));
    if (!Number.isFinite(blockedFrom) || !Number.isFinite(blockedUntil) || blockedUntil <= cursor) continue;
    if (blockedFrom > cursor) windows.push({ from: cursor, until: blockedFrom });
    cursor = Math.max(cursor, blockedUntil);
  }
  if (cursor < end) windows.push({ from: cursor, until: end });
  if (windows.length === 0) return 'after:2147483647 before:2147483648';
  const clauses = windows.map(window => {
    const before = window.until === end
      ? Math.ceil(window.until / 1000) + 1
      : Math.floor(window.until / 1000);
    return `after:${Math.ceil(window.from / 1000)} before:${before}`;
  });
  return clauses.length === 1 ? clauses[0]! : clauses.map(clause => `(${clause})`).join(' OR ');
}

export function publicScanStatus(
  scan: M5aScanDocument | null,
  supportsDailyLimit = false,
  supportsBulk = false,
): Record<string, unknown> | null {
  if (!scan) return null;
  const common = {
    scanId: scan.scanId, status: scan.status, origin: scan.origin, from: scan.from, until: scan.until,
    startedAt: scan.startedAt, messagesRead: scan.messagesRead, messagesUnavailable: scan.messagesUnavailable,
    messagesTrimmed: scan.messagesTrimmed, observationsFound: scan.observationsFound,
    addedFromEmail: scan.addedFromEmail,
    ...(supportsBulk ? { messagesSkippedBulk: scan.messagesSkippedBulk ?? 0 } : {}),
  };
  if (scan.status === 'complete') return { ...common, finishedAt: scan.finishedAt };
  if (scan.status === 'failed') return {
    ...common,
    failedAt: scan.failedAt,
    // Pre-budget builds use a strict enum and cannot parse the new value.
    failure: scan.failure === 'daily_limit' && !supportsDailyLimit ? 'analysis_unavailable' : scan.failure,
  };
  return { ...common, waiting: scan.waiting ?? null };
}

export function publicQueued(scan: M5aScanDocument | null): Record<string, unknown> | null {
  const queue = scan?.queued;
  return queue ? { scanId: queue.scanId, origin: queue.origin, from: queue.from, until: queue.until, acceptedAt: queue.acceptedAt } : null;
}

export function publicDailyStatus(
  scan: (M5aScanDocument & { day?: string; heldAt?: string; reason?: string }) | null,
  supportsDailyLimit = false,
  supportsBulk = false,
): Record<string, unknown> | null {
  if (!scan) return null;
  if (scan.status === ('held' as M5aScanDocument['status']) && scan.reason === 'no_timezone') {
    return { status: 'held', reason: 'no_timezone', heldAt: scan.heldAt };
  }
  const common = publicScanStatus(scan, supportsDailyLimit, supportsBulk);
  if (!common || !scan.day) return null;
  const { origin: _origin, ...withoutOrigin } = common;
  return { ...withoutOrigin, day: scan.day };
}

function transportFor(uid: string, runtime: GoogleRuntime): GmailTransport {
  return createGmailTransport({
    accessToken: () => googleAccessToken(uid, 'gmail', runtime),
    reauth: () => googleAccessToken(uid, 'gmail', runtime, { forceRefresh: true }),
    fetchImpl: runtime.fetchImpl,
  });
}

function trimForAnalysis(text: string): { text: string; trimmed: boolean } {
  if (text.length <= 12_000) return { text, trimmed: false };
  const first = text.slice(0, 12_000);
  const line = first.lastIndexOf('\n');
  return { text: (line >= 1 ? first.slice(0, line) : first).trim(), trimmed: true };
}

function sentenceHolding(text: string, evidence: string): { sentence: string; rest: string } | null {
  const index = text.indexOf(evidence);
  if (index < 0) return null;
  let start = index;
  while (start > 0 && !/[.!?؟\n]/.test(text[start - 1]!)) start -= 1;
  let end = index + evidence.length;
  while (end < text.length && !/[.!?؟\n]/.test(text[end]!)) end += 1;
  if (end < text.length) end += 1;
  return { sentence: text.slice(start, end).trim(), rest: `${text.slice(0, start)} ${text.slice(end)}`.trim() };
}

const GREETING_OR_CLOSER = /^(?:(?:hi|hello|hey)(?:\s+[^\s,.!،؛]+)?|thanks?|thank you|sure|مرحبا|مرحباً|أهلا|اهلا|شكرا|شكراً|תודה|שלום)[,.!،؛\s]*$/i;
function onlyGreetingRest(text: string): boolean {
  return !text.trim() || text.split(/(?<=[.!?؟])|\n+/).every(part => !part.trim() || GREETING_OR_CLOSER.test(part.trim()));
}

export function preModelCandidateSignals(
  message: Pick<NonNullable<Awaited<ReturnType<GmailTransport['getMessageById']>>>, 'sentByAccount' | 'isReply' | 'bodyFormat' | 'text' | 'receivedAt'>,
  timezone: string | null,
): boolean {
  if (!message.sentByAccount || !message.isReply || message.bodyFormat !== 'text/plain' || !timezone) return false;
  const own = ownTextOf(message.text);
  if (own.boundary !== 'quote_header') return false;
  const cleaned = cleanEmail(own.own).body.trim();
  if (!cleaned) return false;
  const rules = ruleBasedExtract(cleaned, { now: new Date(message.receivedAt), timezone });
  return Boolean(rules.dueAt);
}

/** Deterministic backstop: one action-bearing clause and one time anchor only. */
export function singleAgreementSentence(sentence: string): boolean {
  const secondAction = /\b(?:and\s+(?:also\s+)?)(?:send|call|email|text|bring|come|meet|review|finish|submit)\b|(?:وكمان|وأيضاً|وايضا|\sو)\s*(?:ببعت|برسل|باجي|بجي|بتصل|بخلص)|(?:וגם|\sו)\s*(?:אשלח|אגיע|אתקשר|אסיים)/i;
  if (secondAction.test(sentence)) return false;
  const days = sentence.match(/\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|(?:اليوم|بكرا|غداً|غدا|الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت)|(?:היום|מחר|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/gi) ?? [];
  const clocks = sentence.match(/\b(?:at\s+\d{1,2}(?::\d{2})?)\b|(?:الساعة\s*\d+)|(?:בשעה\s*\d+)/gi) ?? [];
  return days.length === 1 && clocks.length <= 1;
}

interface AutoAddCandidate {
  evidence: string;
  sentence: string;
  command: Extract<Command, { type: 'CreateDraft' }>;
  timezone: { value: string; source: 'account' | 'scan' };
}

function qualifyingAgreement(
  message: Awaited<ReturnType<GmailTransport['getMessageById']>>,
  observations: readonly SemanticObservation[],
): { evidence: string; sentence: string } | null {
  if (!message || !message.sentByAccount || !message.isReply || message.bodyFormat !== 'text/plain') return null;
  const own = ownTextOf(message.text);
  if (own.boundary !== 'quote_header') return null;
  const cleaned = cleanEmail(own.own).body.trim();
  const agreements = observations.filter(item => (item.kind === 'commitment' || item.kind === 'event') && cleaned.includes(item.evidence));
  const unique = agreements.filter((item, index) => index === agreements.findIndex(other => other.evidence === item.evidence));
  if (unique.length !== 1) return null;
  const span = sentenceHolding(cleaned, unique[0]!.evidence);
  if (!span || !onlyGreetingRest(span.rest) || !singleAgreementSentence(span.sentence)) return null;
  return { evidence: unique[0]!.evidence, sentence: span.sentence };
}

function effectiveTimezone(user: Record<string, unknown> | null, scan: M5aScanDocument): AutoAddCandidate['timezone'] | null {
  const account = validTimezone(user?.timezone);
  if (account) return { value: account, source: 'account' };
  return scan.timezone ? { value: scan.timezone, source: 'scan' } : null;
}

async function autoAddCandidate(
  uid: string,
  message: NonNullable<Awaited<ReturnType<GmailTransport['getMessageById']>>>,
  observations: readonly SemanticObservation[],
  timezone: AutoAddCandidate['timezone'] | null,
  runtime: GoogleRuntime,
  permit?: QuotaPermit,
  beforeModel?: () => Promise<void>,
): Promise<AutoAddCandidate | null> {
  const agreement = qualifyingAgreement(message, observations);
  if (!agreement || !timezone) return null;
  const context = { now: new Date(message.receivedAt), timezone: timezone.value };
  const rules = ruleBasedExtract(agreement.sentence, context);
  if (!rules.dueAt || rules.missingFields.length > 0 || rules.ambiguityFlags.includes('multiple_commitments')) return null;
  let extracted = rules;
  const provider = runtime.captureModel
    ? (permit ? async (prompt: string, options: Parameters<NonNullable<GoogleRuntime['captureModel']>>[1]) => {
      if (!await startQuotaPermitSlot(permit, 1, { storage: runtime.storage, now: runtime.now() })) throw new LLMUnavailableError('usage_guard_unavailable');
      const response = await runtime.captureModel!(prompt, options);
      // Test providers return only text, so the permit conservatively settles at zero.
      await settleQuotaPermitSlot(permit, 1, {}, { storage: runtime.storage, now: runtime.now() });
      return response;
    } : runtime.captureModel)
    : captureLlmProvider(uid, {
      purpose: 'capture_extraction',
      now: runtime.now,
      ...(runtime.captureProvider ? { provider: runtime.captureProvider } : {}),
      ...(permit ? { quotaPermit: { permit, slot: 1, storage: runtime.storage } } : {}),
    });
  try {
    extracted = await extractWithOllama(agreement.sentence, context, {
      provider: async (prompt) => {
        if (beforeModel) await beforeModel();
        return provider(prompt, { timeoutMs: 8_000, retry: false });
      },
      repairEnabled: false,
    });
  } catch (error) {
    // The checked-in gate deliberately has no capture model. A configured
    // model's timeout or malformed first answer still fails closed; only the
    // explicit provider-none runtime uses the deterministic capture path.
    if (!(error instanceof LLMUnavailableError && error.reason === 'provider_none')) return null;
  }
  if (!extracted.dueAt || extracted.missingFields.length > 0 || extracted.ambiguityFlags.includes('multiple_commitments')) return null;
  // Semantic/capture disagreement and model/rules date disagreement both keep
  // the observation pending. The model never gets authority to move the item.
  if (extracted.type !== rules.type || extracted.dueAt !== rules.dueAt || extracted.remindAt !== rules.remindAt) return null;
  const mapped = mapExtractionToCommand(extracted, message.receivedAt);
  const create = mapped.find((command): command is Extract<Command, { type: 'CreateDraft' }> => command.type === 'CreateDraft');
  return create ? { evidence: agreement.evidence, sentence: agreement.sentence, command: create, timezone } : null;
}

function classifyFailure(error: unknown): ScanFailure {
  if (error instanceof Error && error.message === 'daily_limit') return 'daily_limit';
  if (error instanceof Error && (error.message === 'source_analysis_failed' || error.message === 'analysis_unavailable')) return 'analysis_unavailable';
  if (error instanceof Error && error.message === 'reconnect_needed') return 'reconnect_needed';
  if (error instanceof GmailProviderError && (error.status === 401 || error.status === 403)) return 'reconnect_needed';
  return 'source_unavailable';
}

async function failScan(uid: string, kind: M5aUnitKind, scanId: string, owner: string, failure: ScanFailure, storage: StorageAdapter, now: string): Promise<void> {
  const failedAt = new Date(now);
  const nextEligibleAt = failure === 'daily_limit'
    ? new Date(Date.UTC(failedAt.getUTCFullYear(), failedAt.getUTCMonth(), failedAt.getUTCDate() + 1)).toISOString()
    : now;
  await storage.runTransaction(async tx => {
    const path = scanDocumentPath(uid, kind);
    const [account, scan] = await Promise.all([
      tx.get(userDoc(uid)),
      tx.get<M5aScanDocument>(path),
    ]);
    if (!liveAccount(account) || !scan || scan.scanId !== scanId || scan.leaseOwner !== owner) return;
    tx.set(path, { ...scan, status: 'failed', failure, failedAt: now, waiting: null,
      leaseOwner: null, leaseUntil: null, nextEligibleAt });
  });
}

async function releaseClaims(uid: string, owner: string, ids: readonly string[], storage: StorageAdapter): Promise<void> {
  // A release only updates a marker that still exists and is owned by this
  // caller. Once the deletion sweep removes it, this cannot recreate it.
  await storage.runTransaction(async tx => {
    const markers = await Promise.all(ids.map(id => tx.get<M5aMarker>(markerPath(uid, id))));
    markers.forEach((marker, index) => {
      if (marker?.state === 'claimed' && marker.owner === owner) tx.set(markerPath(uid, ids[index]!), {
        ...marker, state: 'released', owner: undefined, leaseUntil: undefined,
      });
    });
  });
}

async function releaseMessageForRetry(
  uid: string,
  kind: M5aUnitKind,
  scanId: string,
  scanOwner: string,
  claimOwner: string,
  markerIds: readonly string[],
  storage: StorageAdapter,
): Promise<void> {
  // As above, every write is conditional on the caller-owned scan/marker
  // still existing, so this retry release cannot recreate a swept row.
  await storage.runTransaction(async tx => {
    const [scan, ...markers] = await Promise.all([
      tx.get<M5aScanDocument>(scanDocumentPath(uid, kind)),
      ...markerIds.map(id => tx.get<M5aMarker>(markerPath(uid, id))),
    ]);
    markers.forEach((marker, index) => {
      if (marker?.state === 'claimed' && marker.owner === claimOwner) tx.set(markerPath(uid, markerIds[index]!), {
        ...marker, state: 'released', owner: undefined, leaseUntil: undefined,
      });
    });
    if (scan?.scanId === scanId && scan.leaseOwner === scanOwner) tx.set(scanDocumentPath(uid, kind), {
      ...scan, leaseOwner: null, leaseUntil: null, nextEligibleAt: new Date().toISOString(),
    });
  });
}

function quotaWait(outcome: QuotaPermitOutcome, now: Date): { reason: 'daily_ai_limit' | 'rate_limit'; resumesAt: string } | null {
  if (outcome === 'minute_boundary') {
    const resumes = new Date(now); resumes.setUTCSeconds(0, 0); resumes.setUTCMinutes(resumes.getUTCMinutes() + 1);
    return { reason: 'rate_limit', resumesAt: resumes.toISOString() };
  }
  const scope = quotaScopeFor(outcome);
  if (!scope) return null;
  return {
    reason: scope === 'user_minute' ? 'rate_limit' : 'daily_ai_limit',
    resumesAt: new Date(now.getTime() + retryAfterSecondsFor(scope, now) * 1_000).toISOString(),
  };
}

async function deferClaimForQuota(
  uid: string, scan: M5aScanDocument, scanOwner: string, claimOwner: string,
  markerIds: readonly string[], outcome: QuotaPermitOutcome, runtime: GoogleRuntime,
): Promise<boolean> {
  // Daily budgets are a truthful terminal-for-today status. The failed-scan
  // sweep resumes them after UTC midnight; only short minute waits stay in the
  // running/deferred state.
  if (outcome !== 'minute_boundary' && quotaScopeFor(outcome) !== 'user_minute') return false;
  const wait = quotaWait(outcome, runtime.now());
  if (!wait) return false;
  // This is a claim release, not a new writer: every set below requires the
  // caller-owned durable row to still exist.
  await runtime.storage.runTransaction(async tx => {
    const path = scanDocumentPath(uid, scan.kind);
    const [current, ...markers] = await Promise.all([
      tx.get<M5aScanDocument>(path), ...markerIds.map(id => tx.get<M5aMarker>(markerPath(uid, id))),
    ]);
    if (!current || current.scanId !== scan.scanId || current.leaseOwner !== scanOwner) return;
    markers.forEach((marker, index) => {
      if (marker?.state === 'claimed' && marker.owner === claimOwner) tx.set(markerPath(uid, markerIds[index]!), {
        ...marker, state: 'released', owner: undefined, leaseUntil: undefined,
      });
    });
    tx.set(path, { ...current, leaseOwner: null, leaseUntil: null, nextEligibleAt: wait.resumesAt,
      waiting: outcome === 'minute_boundary' ? null : wait });
  });
  return true;
}

function deterministicCommitmentId(autoAddId: string, command: Extract<Command, { type: 'CreateDraft' }>): string {
  const normalized = JSON.stringify({
    title: command.commitment.title.trim(),
    timeSpec: command.commitment.timeSpec ?? null,
    description: command.commitment.description?.trim() || null,
    person: command.commitment.person?.trim() || null,
    locationTrigger: command.commitment.locationTrigger ?? null,
  });
  return `m5a_${createHash('sha256').update(`${autoAddId}\0${normalized}`).digest('hex').slice(0, 32)}`;
}

async function countFinishedMarker(
  uid: string, scan: M5aScanDocument, owner: string, messageId: string, markerId: string,
  storage: StorageAdapter,
): Promise<boolean> {
  return storage.runTransaction(async tx => {
    const [account, current, daily, marker] = await Promise.all([
      tx.get(userDoc(uid)),
      tx.get<M5aScanDocument>(scanDocumentPath(uid, scan.kind)), tx.get<M5aScanDocument>(dailyScanPath(uid)),
      tx.get<M5aMarker>(markerPath(uid, markerId)),
    ]);
    if (!liveAccount(account) || !current || current.scanId !== scan.scanId
      || current.leaseOwner !== owner || marker?.state !== 'done') return false;
    const receipt = transitionReceipt(marker, scan.scanId, 'read', [current.scanId, daily?.scanId].filter(Boolean) as string[]);
    const done = Array.from(new Set([...(current.page?.done ?? []), messageId]));
    tx.set(markerPath(uid, markerId), receipt.marker);
    tx.set(scanDocumentPath(uid, scan.kind), advancePage({
      ...current,
      messagesRead: current.messagesRead + receipt.readDelta,
      messagesSkippedBulk: (current.messagesSkippedBulk ?? 0) + (receipt.readDelta && marker.outcome === 'bulk' ? 1 : 0),
      messagesUnavailable: current.messagesUnavailable + receipt.unavailableDelta,
      observationsFound: current.observationsFound + (receipt.readDelta ? marker.observationIds?.length ?? 0 : 0),
      addedFromEmail: current.addedFromEmail + (receipt.readDelta && marker.autoAddId ? 1 : 0),
      page: current.page ? { ...current.page, done } : null,
    }));
    return true;
  });
}

function advancePage(scan: M5aScanDocument): M5aScanDocument {
  if (!scan.page || scan.page.done.length < scan.page.ids.length) return { ...scan, leaseOwner: null, leaseUntil: null, nextEligibleAt: scan.startedAt };
  if (scan.page.nextPageToken !== null) return {
    ...scan, pageToken: scan.page.nextPageToken, page: null, leaseOwner: null, leaseUntil: null,
    nextEligibleAt: scan.startedAt,
  };
  const completed: M5aScanDocument = {
    ...scan, status: 'complete', finishedAt: new Date().toISOString(), page: null,
    leaseOwner: null, leaseUntil: null, nextEligibleAt: new Date().toISOString(),
  };
  // A confirmed request behind a running scan is durable work, not merely UI
  // state. Promote it atomically with the terminal page so navigation or a
  // process restart cannot strand it.
  return scan.queued ? documentFromQueued(scan.queued) : completed;
}

/** Re-read every durable fence immediately before Gmail or model dispatch. */
async function assertScanAuthority(
  uid: string,
  expected: M5aScanDocument,
  owner: string,
  runtime: GoogleRuntime,
): Promise<void> {
  return assertScanAuthorityWithReader(uid, expected, owner, runtime.storage);
}

async function assertScanAuthorityWithReader(
  uid: string,
  expected: M5aScanDocument,
  owner: string,
  reader: { get<T>(path: string): Promise<T | null> },
): Promise<void> {
  const [scan, controls, user, connection, monitor] = await Promise.all([
    reader.get<M5aScanDocument>(scanDocumentPath(uid, expected.kind)),
    reader.get<unknown>(M5A_CONTROLS_PATH),
    reader.get<Record<string, any>>(userDoc(uid)),
    reader.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
    reader.get<DailyMonitor>(`${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`),
  ]);
  const parsed = parseM5aControls(controls);
  if (!scan || scan.scanId !== expected.scanId || scan.leaseOwner !== owner
    || !parsed?.email.enabled || parsed.email.epoch !== scan.emailEpoch
    || !liveAccount(user) || user?.personalizationPurge?.state === 'purging'
    || !isLiveConnection(connection) || connection.identity.providerAccountId !== scan.providerAccountId
    || (scan.kind !== 'manual' && (!monitor?.enabled || !monitor.m5
      || monitor.generation !== scan.monitorGeneration || monitor.m5.pauseEpoch !== scan.pauseEpoch
      || Boolean(monitor.m5.pausedSince)))) throw new Error('scan_fence_changed');
}

async function processMessage(
  uid: string,
  claimedScan: M5aScanDocument,
  owner: string,
  messageId: string,
  transport: GmailTransport,
  runtime: GoogleRuntime,
): Promise<void> {
  const storage = runtime.storage;
  const providerMarkerId = providerMarkerIdFor(uid, claimedScan.providerAccountId, messageId);
  const legacyMarkerId = legacyMarkerIdFor(messageId);
  const markerIds = [providerMarkerId, legacyMarkerId];
  const claimOwner = randomUUID();
  const waitingMarker = await storage.get<M5aMarker>(markerPath(uid, providerMarkerId));
  const waitingCoverage = waitingMarker?.state === 'waiting_for_calendar'
    ? await calendarCoverageForEmail(uid, runtime) : null;
  const waitOriginMatches = (marker: M5aMarker | null | undefined): boolean => {
    if (claimedScan.kind === 'live') return marker?.origin?.kind === 'monitor'
      && marker.origin.generation === claimedScan.monitorGeneration
      && marker.origin.pauseEpoch === claimedScan.pauseEpoch;
    return marker?.origin?.kind === 'scan' && marker.origin.scanId === claimedScan.scanId
      && marker.origin.scanKind === claimedScan.kind;
  };
  const claimed = await storage.runTransaction(async tx => {
    const [account, scan, providerMarker, legacyMarker] = await Promise.all([
      tx.get(userDoc(uid)),
      tx.get<M5aScanDocument>(scanDocumentPath(uid, claimedScan.kind)),
      tx.get<M5aMarker | Record<string, unknown>>(markerPath(uid, providerMarkerId)),
      tx.get<M5aMarker | Record<string, unknown>>(markerPath(uid, legacyMarkerId)),
    ]);
    if (!liveAccount(account) || !scan || scan.scanId !== claimedScan.scanId
      || scan.leaseOwner !== owner) return { kind: 'lost' as const };
    const now = runtime.now().toISOString();
    const resumableCoverage = waitingCoverage === 'fresh' || waitingCoverage === 'force_off';
    const providerDecision = (providerMarker as M5aMarker | null)?.state === 'waiting_for_calendar'
      && resumableCoverage && waitOriginMatches(providerMarker as M5aMarker)
      ? 'takeover' : markerDecision(providerMarker, 'm5a', now);
    const legacyDecision = (legacyMarker as M5aMarker | null)?.state === 'waiting_for_calendar'
      && resumableCoverage && waitOriginMatches(legacyMarker as M5aMarker)
      ? 'takeover' : markerDecision(legacyMarker, 'm5a', now);
    const done = providerDecision === 'count'
      ? providerMarker as M5aMarker
      : legacyDecision === 'count' ? legacyMarker as M5aMarker : null;
    if (done) return { kind: 'done' as const, markerId: (providerMarker as M5aMarker)?.state === 'done' ? providerMarkerId : legacyMarkerId };
    if (providerDecision === 'block' || legacyDecision === 'block') return { kind: 'blocked' as const };
    const preexisting = Boolean(legacyMarker && !((legacyMarker as M5aMarker).v === 2 && ['claimed', 'released', 'unavailable'].includes((legacyMarker as M5aMarker).state)));
    const leaseUntil = new Date(runtime.now().getTime() + LEASE_MS).toISOString();
    const providerClaim: M5aMarker = { ...(providerMarker as M5aMarker ?? {}), v: 2, state: 'claimed', owner: claimOwner, leaseUntil,
      providerAccountId: claimedScan.providerAccountId, preexisting };
    const legacyClaim: M5aMarker = { ...(legacyMarker as M5aMarker ?? {}), v: 2, state: 'claimed', owner: claimOwner, leaseUntil,
      providerAccountId: claimedScan.providerAccountId, providerMarkerId, preexisting };
    tx.set(markerPath(uid, providerMarkerId), providerClaim);
    tx.set(markerPath(uid, legacyMarkerId), legacyClaim);
    return { kind: 'claimed' as const, preexisting, forceAutoAddOff: waitingCoverage === 'force_off' };
  });
  if (claimed.kind === 'lost' || claimed.kind === 'blocked') return;
  if (claimed.kind === 'done') {
    await countFinishedMarker(uid, claimedScan, owner, messageId, claimed.markerId, storage);
    return;
  }

  let permit: QuotaPermit | undefined;
  try {
    await assertScanAuthority(uid, claimedScan, owner, runtime);
    const message = await transport.getMessageById(messageId);
    if (!message) {
      await storage.runTransaction(async tx => {
        await assertScanAuthorityWithReader(uid, claimedScan, owner, tx);
        const [scan, daily, provider, legacy] = await Promise.all([
          tx.get<M5aScanDocument>(scanDocumentPath(uid, claimedScan.kind)), tx.get<M5aScanDocument>(dailyScanPath(uid)),
          tx.get<M5aMarker>(markerPath(uid, providerMarkerId)), tx.get<M5aMarker>(markerPath(uid, legacyMarkerId)),
        ]);
        if (!scan || scan.scanId !== claimedScan.scanId || scan.leaseOwner !== owner
          || provider?.owner !== claimOwner || legacy?.owner !== claimOwner) return;
        const receipt = transitionReceipt({ ...provider, state: 'unavailable' }, scan.scanId, 'unavailable',
          [scan.scanId, daily?.scanId].filter(Boolean) as string[]);
        const done = Array.from(new Set([...(scan.page?.done ?? []), messageId]));
        tx.set(markerPath(uid, providerMarkerId), receipt.marker);
        tx.set(markerPath(uid, legacyMarkerId), { ...legacy, state: 'released', owner: undefined, leaseUntil: undefined });
        tx.set(scanDocumentPath(uid, claimedScan.kind), advancePage({ ...scan,
          messagesRead: scan.messagesRead + receipt.readDelta,
          messagesUnavailable: scan.messagesUnavailable + receipt.unavailableDelta,
          page: scan.page ? { ...scan.page, done } : null,
        }));
      });
      return;
    }
    const received = Date.parse(message.receivedAt);
    const excluded = received < Date.parse(claimedScan.from) || received >= Date.parse(claimedScan.until)
      || (claimedScan.excluded ?? []).some(interval => received >= Date.parse(interval.from) && received < Date.parse(interval.to));
    if (excluded) {
      await storage.runTransaction(async tx => {
        await assertScanAuthorityWithReader(uid, claimedScan, owner, tx);
        const [scan, provider, legacy] = await Promise.all([
          tx.get<M5aScanDocument>(scanDocumentPath(uid, claimedScan.kind)),
          tx.get<M5aMarker>(markerPath(uid, providerMarkerId)), tx.get<M5aMarker>(markerPath(uid, legacyMarkerId)),
        ]);
        if (!scan || scan.scanId !== claimedScan.scanId || scan.leaseOwner !== owner
          || provider?.owner !== claimOwner || legacy?.owner !== claimOwner) return;
        const marker: M5aMarker = { ...provider, state: 'done', owner: undefined, leaseUntil: undefined,
          processedAt: runtime.now().toISOString(), outcome: 'empty', observationIds: [], autoAddId: null };
        const done = Array.from(new Set([...(scan.page?.done ?? []), messageId]));
        tx.set(markerPath(uid, providerMarkerId), marker);
        tx.set(markerPath(uid, legacyMarkerId), { ...marker, providerMarkerId });
        tx.set(scanDocumentPath(uid, claimedScan.kind), advancePage({ ...scan, page: scan.page ? { ...scan.page, done } : null }));
      });
      return;
    }
    if (message.isBulk) {
      await storage.runTransaction(async tx => {
        await assertScanAuthorityWithReader(uid, claimedScan, owner, tx);
        const [scan, daily, provider, legacy] = await Promise.all([
          tx.get<M5aScanDocument>(scanDocumentPath(uid, claimedScan.kind)),
          tx.get<M5aScanDocument>(dailyScanPath(uid)),
          tx.get<M5aMarker>(markerPath(uid, providerMarkerId)), tx.get<M5aMarker>(markerPath(uid, legacyMarkerId)),
        ]);
        if (!scan || scan.scanId !== claimedScan.scanId || scan.leaseOwner !== owner
          || provider?.owner !== claimOwner || legacy?.owner !== claimOwner) return;
        const marker: M5aMarker = {
          ...provider, state: 'done', owner: undefined, leaseUntil: undefined,
          processedAt: runtime.now().toISOString(), outcome: 'bulk', observationIds: [], autoAddId: null,
        };
        const receipt = transitionReceipt(marker, scan.scanId, 'read',
          [scan.scanId, daily?.scanId].filter(Boolean) as string[]);
        const done = Array.from(new Set([...(scan.page?.done ?? []), messageId]));
        tx.set(markerPath(uid, providerMarkerId), receipt.marker);
        tx.set(markerPath(uid, legacyMarkerId), { ...receipt.marker, providerMarkerId, providerAccountId: scan.providerAccountId });
        tx.set(scanDocumentPath(uid, claimedScan.kind), advancePage({
          ...scan,
          messagesRead: scan.messagesRead + receipt.readDelta,
          messagesSkippedBulk: (scan.messagesSkippedBulk ?? 0) + receipt.readDelta,
          messagesUnavailable: scan.messagesUnavailable + receipt.unavailableDelta,
          page: scan.page ? { ...scan.page, done } : null,
        }));
      });
      return;
    }
    const raw = [message.subject ?? '', message.text].filter(Boolean).join('\n');
    const prepared = trimForAnalysis(raw);
    const userAtExtraction = await storage.get<Record<string, unknown>>(userDoc(uid));
    const capturedTimezone = effectiveTimezone(userAtExtraction, claimedScan);
    const candidateSignals = preModelCandidateSignals(message, capturedTimezone?.value ?? null);
    let forceAutoAddOff = claimed.forceAutoAddOff;
    if (candidateSignals) {
      const coverage = await calendarCoverageForEmail(uid, runtime);
      if (coverage === 'stale_google' || coverage === 'stale_device' || coverage === 'stale_ics') {
        await waitForCalendarAndFetch(uid, {
          scan: claimedScan, scanOwner: owner, claimOwner, markerIds, messageId,
          fetchGoogle: coverage === 'stale_google',
        }, runtime);
        return;
      }
      forceAutoAddOff = coverage === 'force_off';
    }
    // `shareModel` is the historical lightweight functional-test seam. The
    // production-shaped `shareProvider` seam below deliberately does not take
    // this branch, so end-to-end quota tests exercise the same adapter and
    // whole-unit permit path as production without consuming real model calls.
    if (prepared.text && !runtime.shareModel) {
      const calls = candidateSignals && !forceAutoAddOff ? 2 : 1;
      const reservation = await reserveQuotaPermit(uid, 'semantic_observation', {
        owner: claimOwner, calls, tokenBudget: calls === 2 ? M5A_PERMIT_TOKENS.twoCalls : M5A_PERMIT_TOKENS.oneCall,
        ...(calls === 2 ? { slotBudgets: [M5A_PERMIT_TOKENS.oneCall, M5A_PERMIT_TOKENS.captureSlot] } : {}),
      }, { storage, now: runtime.now() });
      if (reservation.outcome !== 'ok' || !reservation.permit) {
        if (await deferClaimForQuota(uid, claimedScan, owner, claimOwner, markerIds, reservation.outcome, runtime)) return;
        const scope = reservation.outcome === 'minute_boundary' ? null : quotaScopeFor(reservation.outcome);
        throw new Error(scope === 'user_daily' || scope === 'global_daily' ? 'daily_limit' : 'analysis_unavailable');
      }
      permit = reservation.permit;
    }
    const generateWithPermit: ShareStructuredGenerator | undefined = permit
      ? runtime.shareModel
        ? async request => {
          if (!await startQuotaPermitSlot(permit!, 0, { storage, now: runtime.now() })) throw new LLMUnavailableError('usage_guard_unavailable');
          const response = await runtime.shareModel!(request);
          await settleQuotaPermitSlot(permit!, 0, response, { storage, now: runtime.now() });
          return response;
        }
        : shareLlmProvider(uid, {
          purpose: 'semantic_observation', quotaPermit: { permit, slot: 0, storage }, now: runtime.now,
          ...(runtime.shareProvider ? { provider: runtime.shareProvider } : {}),
        })
      : runtime.shareModel;
    const generate: ShareStructuredGenerator | undefined = generateWithPermit
      ? async request => {
        await assertScanAuthority(uid, claimedScan, owner, runtime);
        return generateWithPermit(request);
      }
      : undefined;
    const observations = prepared.text ? await analyzeSourceStaged(uid, 'gmail', prepared.text, generate ? { generate } : {}) : [];
    const candidate = forceAutoAddOff ? null : await autoAddCandidate(
      uid, message, observations, capturedTimezone, runtime, permit,
      () => assertScanAuthority(uid, claimedScan, owner, runtime),
    );
    const ref = gmailRefFor(claimedScan.providerAccountId, messageId);
    const addId = autoAddIdFor(uid, claimedScan.providerAccountId, messageId);
    const at = runtime.now().toISOString();

    const committed = await storage.runTransaction(async tx => {
      const [scan, daily, provider, legacy, controls, user, monitor, existingObservations, existingAutoAdd] = await Promise.all([
        tx.get<M5aScanDocument>(scanDocumentPath(uid, claimedScan.kind)),
        tx.get<M5aScanDocument>(dailyScanPath(uid)),
        tx.get<M5aMarker>(markerPath(uid, providerMarkerId)),
        tx.get<M5aMarker>(markerPath(uid, legacyMarkerId)),
        tx.get<unknown>(M5A_CONTROLS_PATH),
        tx.get<Record<string, any>>(userDoc(uid)),
        tx.get<DailyMonitor>(`${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`),
        tx.list<StoredObservation>(userCol(uid, INTELLIGENCE_OBSERVATIONS), {
          where: [['sourceRef', 'in', [messageId, ref]]], limit: 25,
        }),
        tx.get<AutoAddRecord>(autoAddPath(uid, addId)),
      ]);
      const parsedControls = parseM5aControls(controls);
      const currentTimezone = scan ? effectiveTimezone(user, scan) : null;
      if (candidate && (currentTimezone?.value !== candidate.timezone.value || currentTimezone?.source !== candidate.timezone.source)) {
        return false;
      }
      const dueAt = candidate?.command.commitment.timeSpec?.dueAt ?? null;
      const window = dueAt ? {
        startsAt: dueAt,
        endsAt: candidate?.command.commitment.timeSpec?.endAt ?? new Date(Date.parse(dueAt) + 60 * 60_000).toISOString(),
      } : null;
      const snapshot = candidate && window ? await loadAutoAddSnapshot(tx, uid, window, at) : null;
      const connection = snapshot?.connection ?? await tx.get<IntegrationConnectionRecord>(
        userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')),
      );
      const stats = snapshot ? await readActivityStats(tx, uid) : null;
      if (!scan || scan.scanId !== claimedScan.scanId || scan.leaseOwner !== owner
        || provider?.owner !== claimOwner || legacy?.owner !== claimOwner
        || !parsedControls?.email.enabled || parsedControls.email.epoch !== scan.emailEpoch
        || !isLiveConnection(connection) || connection.identity.providerAccountId !== scan.providerAccountId
        || !liveAccount(user) || user?.personalizationPurge?.state === 'purging'
        || (scan.kind !== 'manual' && (!monitor?.enabled || !monitor.m5 || monitor.generation !== scan.monitorGeneration
          || monitor.m5.pauseEpoch !== scan.pauseEpoch || Boolean(monitor.m5.pausedSince)))) throw new Error('scan_fence_changed');

      const priorTrace = claimed.preexisting || existingObservations.length >= 25
        || existingObservations.some(row => row.data.sourceRef === messageId || row.data.sourceRef === ref);
      const state = snapshot?.state ?? null;
      const spentCommitment = state ? Object.values(state.commitments).some(commitment => commitment.addedFrom?.autoAddId === addId) : false;
      let autoAdd: AutoAddRecord | null = null;
      let finalState = state;
      let events: DomainEvent[] = [];
      let supporting = new Set<string>();
      if (candidate && snapshot && snapshot.boundedAndSettled && state && !priorTrace && !existingAutoAdd
        && !spentCommitment && user?.trust?.calendarConsent === true) {
        const create: Extract<Command, { type: 'CreateDraft' }> = {
          ...candidate.command,
          now: at,
          commitment: { ...candidate.command.commitment, id: deterministicCommitmentId(addId, candidate.command) },
          draftStatus: 'pending_confirmation',
        };
        if (create.commitment.timeSpec?.dueAt && Date.parse(create.commitment.timeSpec.dueAt) > runtime.now().getTime()) {
          await runScheduleDecisionHook('autoAdd');
          if (candidateClashes(snapshot.schedule, { timeSpec: {
            kind: create.commitment.timeSpec.kind ?? 'scheduled_event',
            dueAt: create.commitment.timeSpec.dueAt,
            endAt: create.commitment.timeSpec.endAt ?? null,
            remindAt: create.commitment.timeSpec.remindAt ?? null,
            allDay: create.commitment.timeSpec.allDay ?? false,
            timezone: create.commitment.timeSpec.timezone ?? candidate.timezone.value,
          } }).state === 'free') {
            let transition = applyCommand(finalState!, create);
            finalState = transition.newState; events.push(...transition.events);
            transition = applyCommand(finalState, { type: 'ConfirmCommitment', commitmentId: create.commitment.id, now: at });
            finalState = transition.newState; events.push(...transition.events);
            finalState.commitments[create.commitment.id] = {
              ...finalState.commitments[create.commitment.id]!, addedFrom: { kind: 'email_self_reply', autoAddId: addId },
            };
            supporting = new Set(observations
              .filter(item => item.kind === 'commitment' || item.kind === 'event')
              .map(item => observationId('gmail', ref, item)));
            autoAdd = {
              autoAddId: addId, providerAccountId: scan.providerAccountId, commitmentId: create.commitment.id,
              observationIds: Array.from(supporting), evidence: candidate.evidence,
              baseline: commitmentBaselineFingerprint(finalState.commitments[create.commitment.id]!), at, removedAt: null,
            };
          }
        }
      }

      const observationIds: string[] = [];
      for (const item of observations) {
        const id = observationId('gmail', ref, item);
        observationIds.push(id);
        const existing = existingObservations.find(row => row.data.id === id)?.data;
        if (!existing) tx.create(observationPath(uid, id), {
          ...item, id, source: 'gmail', sourceRef: ref, observedAt: message.receivedAt,
          review: supporting.has(id) ? 'confirmed' : 'pending', reviewedAt: supporting.has(id) ? at : null,
          linkedMemoryId: null, ...(supporting.has(id) ? { autoAddId: addId } : {}),
        } satisfies StoredObservation);
      }
      if (autoAdd) {
        writeDomainDiff(tx, uid, state!, finalState!, events, user as never, at);
        recordActivityEvents(tx, uid, stats!, events);
        tx.create(autoAddPath(uid, addId), autoAdd);
      }
      const outcome = prepared.trimmed ? 'trimmed' : prepared.text ? 'analyzed' : 'empty';
      const baseMarker: M5aMarker = {
        ...provider, v: 2, state: 'done', owner: undefined, leaseUntil: undefined, processedAt: at,
        outcome, observationIds, autoAddId: autoAdd?.autoAddId ?? null,
      };
      const receipt = transitionReceipt(baseMarker, scan.scanId, 'read',
        [scan.scanId, daily?.scanId].filter(Boolean) as string[]);
      const done = Array.from(new Set([...(scan.page?.done ?? []), messageId]));
      tx.set(markerPath(uid, providerMarkerId), receipt.marker);
      tx.set(markerPath(uid, legacyMarkerId), { ...receipt.marker, providerMarkerId, providerAccountId: scan.providerAccountId });
      tx.set(scanDocumentPath(uid, claimedScan.kind), advancePage({ ...scan,
        messagesRead: scan.messagesRead + receipt.readDelta,
        messagesUnavailable: scan.messagesUnavailable + receipt.unavailableDelta,
        messagesTrimmed: scan.messagesTrimmed + (receipt.readDelta && prepared.trimmed ? 1 : 0),
        observationsFound: scan.observationsFound + (receipt.readDelta ? observationIds.length : 0),
        addedFromEmail: scan.addedFromEmail + (receipt.readDelta && autoAdd ? 1 : 0),
        page: scan.page ? { ...scan.page, done } : null,
      }));
      if (scan.kind === 'live' && monitor && observationIds.length > 0) tx.set(
        `${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`, {
          ...monitor,
          proposalsVersion: (monitor.proposalsVersion ?? 0) + 1,
          proposalsPending: true,
          proposalNextEligibleAt: at,
        },
      );
      return true;
    });
    if (!committed) await releaseMessageForRetry(uid, claimedScan.kind, claimedScan.scanId, owner, claimOwner, markerIds, storage);
    if (permit) await finalizeQuotaPermit(permit, { storage, now: runtime.now() });
  } catch (error) {
    if (permit) await finalizeQuotaPermit(permit, { storage, now: runtime.now() });
    await releaseClaims(uid, claimOwner, markerIds, storage);
    throw error;
  }
}

export async function runM5aScanStep(
  uid: string,
  kind: M5aUnitKind,
  runtime: GoogleRuntime,
  supplied?: GmailTransport,
  ensureReadable: () => Promise<void> = () => requireReadableFeature(uid, 'gmail', runtime),
): Promise<void> {
  const storage = runtime.storage;
  const now = runtime.now();
  const owner = randomUUID();
  const claimed = await storage.runTransaction(async tx => {
    const [scan, controls, user, connection, monitor] = await Promise.all([
      tx.get<M5aScanDocument>(scanDocumentPath(uid, kind)),
      tx.get<unknown>(M5A_CONTROLS_PATH),
      tx.get<Record<string, any>>(userDoc(uid)),
      tx.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
      tx.get<DailyMonitor>(`${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`),
    ]);
    if (!liveAccount(user)) return null;
    if (!scan || (scan.status !== 'running' && scan.status !== 'failed') || scan.nextEligibleAt > now.toISOString()) return null;
    if (scan.leaseUntil && scan.leaseUntil > now.toISOString()) return null;
    const parsed = parseM5aControls(controls);
    if (!parsed?.email.enabled || parsed.email.epoch !== scan.emailEpoch || user?.personalizationPurge?.state === 'purging') {
      tx.set(scanDocumentPath(uid, kind), { ...scan, status: 'failed', failure: 'monitoring_off', failedAt: now.toISOString(),
        leaseOwner: null, leaseUntil: null, nextEligibleAt: now.toISOString() });
      return null;
    }
    if (!isLiveConnection(connection) || connection.identity.providerAccountId !== scan.providerAccountId) {
      tx.set(scanDocumentPath(uid, kind), { ...scan, status: 'failed', failure: 'reconnect_needed', failedAt: now.toISOString(),
        leaseOwner: null, leaseUntil: null, nextEligibleAt: now.toISOString() });
      return null;
    }
    if (kind !== 'manual' && (!monitor?.enabled || !monitor.m5 || monitor.generation !== scan.monitorGeneration
      || monitor.m5.providerAccountId !== scan.providerAccountId || monitor.m5.pauseEpoch !== scan.pauseEpoch
      || monitor.m5.pausedSince)) {
      tx.set(scanDocumentPath(uid, kind), { ...scan, status: 'failed', failure: 'monitoring_off', failedAt: now.toISOString(),
        leaseOwner: null, leaseUntil: null, nextEligibleAt: now.toISOString() });
      return null;
    }
    const next = { ...scan, status: 'running' as const, failure: null, failedAt: null,
      waiting: null, leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString() };
    tx.set(scanDocumentPath(uid, kind), next);
    return next;
  });
  if (!claimed) return;
  try {
    await assertScanAuthority(uid, claimed, owner, runtime);
    await ensureReadable();
    const transport = supplied ?? transportFor(uid, runtime);
    if (!claimed.page) {
      await assertScanAuthority(uid, claimed, owner, runtime);
      let listed: Awaited<ReturnType<GmailTransport['listRecentMessageIds']>>;
      try {
        listed = await transport.listRecentMessageIds({ query: claimed.query, maxResults: 100, pageToken: claimed.pageToken });
      } catch (error) {
        if (claimed.pageToken !== null && error instanceof GmailProviderError && error.status === 400) {
          await storage.runTransaction(async tx => {
            await assertScanAuthorityWithReader(uid, claimed, owner, tx);
            const scan = await tx.get<M5aScanDocument>(scanDocumentPath(uid, kind));
            if (scan?.scanId === claimed.scanId && scan.leaseOwner === owner) tx.set(scanDocumentPath(uid, kind), {
              ...scan, pageToken: null, page: null, leaseOwner: null, leaseUntil: null,
            });
          });
          return;
        }
        throw error;
      }
      await storage.runTransaction(async tx => {
        await assertScanAuthorityWithReader(uid, claimed, owner, tx);
        const scan = await tx.get<M5aScanDocument>(scanDocumentPath(uid, kind));
        if (!scan || scan.scanId !== claimed.scanId || scan.leaseOwner !== owner) return;
        const withPage = { ...scan, page: { ids: [...listed.ids], nextPageToken: listed.nextPageToken, done: [] } };
        tx.set(scanDocumentPath(uid, kind), listed.ids.length === 0 ? advancePage(withPage) : { ...withPage, leaseOwner: null, leaseUntil: null });
      });
      return;
    }
    const nextId = claimed.page.ids.find(id => !claimed.page!.done.includes(id));
    if (!nextId) {
      await storage.runTransaction(async tx => {
        await assertScanAuthorityWithReader(uid, claimed, owner, tx);
        const scan = await tx.get<M5aScanDocument>(scanDocumentPath(uid, kind));
        if (scan?.scanId === claimed.scanId && scan.leaseOwner === owner) tx.set(scanDocumentPath(uid, kind), advancePage(scan));
      });
      return;
    }
    await processMessage(uid, claimed, owner, nextId, transport, runtime);
  } catch (error) {
    await failScan(uid, kind, claimed.scanId, owner, classifyFailure(error), storage, runtime.now().toISOString());
  }
  if (kind === 'daily') await advanceCompletedDaily(uid, runtime);
}

export async function readM5aScan(uid: string, storage: StorageAdapter = getStorage()): Promise<M5aScanDocument | null> {
  return storage.get<M5aScanDocument>(scanPath(uid));
}

export async function readM5aDailyScan(
  uid: string,
  storage: StorageAdapter = getStorage(),
): Promise<(M5aScanDocument & { day?: string; heldAt?: string; reason?: string }) | null> {
  const daily = await storage.get<M5aScanDocument & { day?: string; heldAt?: string; reason?: string }>(dailyScanPath(uid));
  if (daily) return daily;
  const [monitor, user] = await Promise.all([
    storage.get<{ enabled?: boolean; m5?: { at?: string; timezone?: string | null } }>(`${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`),
    storage.get<Record<string, unknown>>(userDoc(uid)),
  ]);
  if (monitor?.enabled && monitor.m5 && !validTimezone(user?.timezone) && !validTimezone(monitor.m5.timezone)) {
    return { status: 'held', reason: 'no_timezone', heldAt: monitor.m5.at ?? new Date().toISOString() } as never;
  }
  return null;
}

interface DailyMonitor {
  enabled: boolean;
  generation: string;
  proposalsVersion?: number;
  proposalsPending?: boolean;
  proposalNextEligibleAt?: string;
  m5?: {
    providerAccountId: string;
    enabledAt: string;
    timezone: string | null;
    pauseEpoch: number;
    pausedSince: string | null;
    excluded: Array<{ from: string; to: string }>;
    nextSweepAt?: string;
    sweepTimezone?: string;
    pendingSweepDay?: string;
    pendingSweepFrom?: string;
  };
}

function dailyWindow(enabledAt: string, timezone: string, day: string) {
  const start = localMidnightOf(day, timezone);
  const until = addLocalDays(start, 1, timezone);
  return { from: new Date(Math.max(Date.parse(start), Date.parse(enabledAt))).toISOString(), until };
}

/** Atomically consumes a due monitor bootstrap into the one dailyV2 state machine. */
export async function createDueDailyScan(uid: string, runtime: GoogleRuntime): Promise<boolean> {
  const now = runtime.now().toISOString();
  const monitorPath = `${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`;
  const created = await runtime.storage.runTransaction(async tx => {
    const [monitor, daily, user, controls, connection] = await Promise.all([
      tx.get<DailyMonitor>(monitorPath), tx.get<M5aScanDocument>(dailyScanPath(uid)),
      tx.get<Record<string, any>>(userDoc(uid)), tx.get<unknown>(M5A_CONTROLS_PATH),
      tx.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
    ]);
    const parsed = parseM5aControls(controls);
    if (!liveAccount(user) || !monitor?.enabled || !monitor.m5 || !monitor.m5.nextSweepAt || monitor.m5.nextSweepAt > now
      || monitor.m5.pausedSince || !parsed?.email.enabled || !isLiveConnection(connection)
      || connection.identity.providerAccountId !== monitor.m5.providerAccountId) return false;
    if (daily && (daily.status === 'running' || daily.status === 'failed')) {
      tx.set(monitorPath, { ...monitor, m5: { ...monitor.m5, nextSweepAt: new Date(Date.parse(now) + 6 * 60 * 60_000).toISOString() } });
      return false;
    }
    const timezone = validTimezone(user?.timezone) ?? validTimezone(monitor.m5.timezone);
    if (!timezone) {
      const { nextSweepAt: _next, ...m5 } = monitor.m5;
      tx.set(monitorPath, { ...monitor, m5 });
      return false;
    }
    const day = monitor.m5.pendingSweepDay ?? localDayKey(monitor.m5.enabledAt, timezone);
    if (monitor.m5.sweepTimezone && monitor.m5.sweepTimezone !== timezone) {
      const window = dailyWindow(monitor.m5.enabledAt, timezone, day);
      tx.set(monitorPath, { ...monitor, m5: { ...monitor.m5, sweepTimezone: timezone,
        nextSweepAt: new Date(Date.parse(window.until) + 3 * 60 * 60_000).toISOString() } });
      return false;
    }
    const rawWindow = dailyWindow(monitor.m5.enabledAt, timezone, day);
    const window = { ...rawWindow, from: monitor.m5.pendingSweepFrom
      ? new Date(Math.max(Date.parse(rawWindow.from), Date.parse(monitor.m5.pendingSweepFrom))).toISOString()
      : rawWindow.from };
    const scan: M5aScanDocument = {
      ...emptyCounts(), scanId: randomUUID(), kind: 'daily', status: 'running', origin: 'manual',
      providerAccountId: monitor.m5.providerAccountId, emailEpoch: parsed.email.epoch,
      query: gmailQueryOutsideIntervals(window.from, window.until, monitor.m5.excluded),
      from: window.from, until: window.until, timezone, startedAt: now, finishedAt: null, failedAt: null,
      failure: null, pageToken: null, page: null, leaseOwner: null, leaseUntil: null, queued: null,
      nextEligibleAt: now, waiting: null, day, monitorGeneration: monitor.generation,
      pauseEpoch: monitor.m5.pauseEpoch, excluded: [...monitor.m5.excluded],
    };
    tx.set(dailyScanPath(uid), scan);
    tx.set(monitorPath, { ...monitor, m5: { ...monitor.m5, sweepTimezone: timezone, pendingSweepDay: day,
      nextSweepAt: new Date(Date.parse(now) + 6 * 60 * 60_000).toISOString() } });
    return true;
  });
  return created;
}

export async function advanceCompletedDaily(uid: string, runtime: GoogleRuntime): Promise<void> {
  const monitorPath = `${userCol(uid, INTELLIGENCE_MONITORS)}/gmail`;
  await runtime.storage.runTransaction(async tx => {
    const [scan, monitor, user] = await Promise.all([
      tx.get<M5aScanDocument>(dailyScanPath(uid)), tx.get<DailyMonitor>(monitorPath),
      tx.get<Record<string, unknown>>(userDoc(uid)),
    ]);
    if (!scan || scan.kind !== 'daily' || scan.status !== 'complete' || !scan.day
      || !liveAccount(user)
      || !monitor?.enabled || !monitor.m5 || monitor.generation !== scan.monitorGeneration
      || monitor.m5.pendingSweepDay !== scan.day) return;
    const timezone = validTimezone(user?.timezone) ?? validTimezone(monitor.m5.timezone);
    if (!timezone) {
      const { nextSweepAt: _next, ...m5 } = monitor.m5;
      tx.set(monitorPath, { ...monitor, m5: { ...m5, pendingSweepFrom: scan.until } });
      return;
    }
    const nextDay = localDayKey(scan.until, timezone);
    const nextWindow = dailyWindow(scan.until, timezone, nextDay);
    tx.set(monitorPath, { ...monitor, m5: {
      ...monitor.m5, pendingSweepDay: nextDay, pendingSweepFrom: scan.until,
      sweepTimezone: timezone, nextSweepAt: new Date(Date.parse(nextWindow.until) + 3 * 60 * 60_000).toISOString(),
    } });
  });
}

export async function startOrResumeM5aScan(
  uid: string,
  input: { intent: 'new' | 'resume'; expectedScanId?: string; origin?: 'manual' | 'backfill'; timezone?: string },
  runtime: GoogleRuntime,
): Promise<M5aScanDocument> {
  const storage = runtime.storage;
  const provider = await providerAccountId(uid, storage);
  const now = runtime.now();
  const controls = parseM5aControls(await storage.get(M5A_CONTROLS_PATH));
  if (!controls?.email.enabled) throw new Error('m5_unavailable');
  const timezone = validTimezone(input.timezone);
  const origin = input.origin ?? 'manual';
  const admitted = await storage.runTransaction(async tx => {
    const [existing, currentControls, user, connection] = await Promise.all([
      tx.get<M5aScanDocument>(scanPath(uid)),
      tx.get<unknown>(M5A_CONTROLS_PATH),
      tx.get<Record<string, any>>(userDoc(uid)),
      tx.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
    ]);
    const current = parseM5aControls(currentControls);
    if (!current?.email.enabled || current.email.epoch !== controls.email.epoch
      || !liveAccount(user) || user?.personalizationPurge?.state === 'purging'
      || !isLiveConnection(connection) || connection.identity.providerAccountId !== provider) {
      return { scan: existing, run: false, refused: true };
    }
    if (input.intent === 'resume') {
      if (!existing || input.expectedScanId !== existing.scanId || existing.providerAccountId !== provider) return { scan: existing, run: false, refused: false };
      return { scan: existing, run: existing.status === 'running' || existing.status === 'failed', refused: false };
    }
    const queue = newQueued(now, origin, timezone, provider, controls.email.epoch);
    if (existing?.status === 'running' && existing.providerAccountId === provider) {
      const next = existing.queued ? existing : { ...existing, queued: queue };
      if (!existing.queued) tx.set(scanPath(uid), next);
      return { scan: next, run: false, refused: false };
    }
    const next = documentFromQueued(queue);
    tx.set(scanPath(uid), next);
    // The admission request performs the id-only checkpoint, never a message
    // unit. This makes deletion after listing observable as `unavailable`.
    return { scan: next, run: true, refused: false };
  });
  if (admitted.refused) throw new Error('m5_unavailable');
  if (!admitted.scan) throw new Error('scan_missing');
  if (admitted.run) await runM5aScanStep(uid, 'manual', runtime);
  return (await readM5aScan(uid, storage)) ?? admitted.scan;
}
