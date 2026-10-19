import { createHash, randomUUID } from 'node:crypto';
import { applyCommand, type Command, type DomainEvent } from '../../src/domain/stateMachine';
import { mapExtractionToCommand } from '../../src/extraction/mapExtractionToCommand';
import { extract as ruleBasedExtract } from '../../src/extraction/ruleBasedExtractor';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts';
import { createGmailTransport, type GmailTransport } from '../integrations/gmail/production/gmailTransport';
import { GmailProviderError } from '../integrations/gmail/adapter';
import { googleAccessToken, requireReadableFeature } from '../integrations/google/googleConnectService';
import type { GoogleRuntime } from '../integrations/google/googleRuntime';
import { connectionIdFor } from '../integrations/providers/production/storedConnectionStore';
import { candidateClashes, readFreeSlotSchedule } from '../planning/freeSlots';
import { cleanEmail } from '../services/share/emailCleaner';
import { loadDomainState, writeDomainDiff } from '../services/mobile/participantState';
import {
  getStorage,
  INTELLIGENCE_AUTO_ADDS,
  INTELLIGENCE_GMAIL_SCANS,
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

const WEEK_MS = 7 * 24 * 60 * 60_000;
const LEASE_MS = 120_000;

export type ScanFailure = 'reconnect_needed' | 'source_unavailable' | 'analysis_unavailable' | 'monitoring_off';
export type Receipt = 'read' | 'unavailable';

export interface M5aMarker {
  readonly v: 2;
  readonly state: 'claimed' | 'done' | 'unavailable' | 'released' | 'waiting_for_calendar';
  readonly owner?: string;
  readonly leaseUntil?: string;
  readonly providerAccountId?: string;
  readonly providerMarkerId?: string;
  readonly preexisting?: boolean;
  readonly processedAt?: string;
  readonly outcome?: 'analyzed' | 'trimmed' | 'empty';
  readonly observationIds?: readonly string[];
  readonly autoAddId?: string | null;
  readonly receipts?: Readonly<Record<string, Receipt>>;
}

export interface ScanCounts {
  messagesRead: number;
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
  kind: 'manual' | 'daily';
  status: 'running' | 'complete' | 'failed';
  origin: 'manual' | 'backfill';
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
export function transitionReceipt(marker: M5aMarker, scanId: string, next: Receipt): ReceiptTransition {
  const previous = marker.receipts?.[scanId];
  if (previous === next || previous === 'read') return { marker, readDelta: 0, unavailableDelta: 0 };
  const receipts = { ...(marker.receipts ?? {}), [scanId]: next };
  return {
    marker: { ...marker, receipts },
    readDelta: next === 'read' ? 1 : 0,
    unavailableDelta: next === 'unavailable' ? 1 : previous === 'unavailable' ? -1 : 0,
  };
}

export function gmailRefFor(providerAccountId: string, messageId: string): string {
  return createHash('sha256').update(`${providerAccountId}\0${messageId}`).digest('hex');
}

export function providerMarkerIdFor(uid: string, providerAccountId: string, messageId: string): string {
  return createHash('sha256').update(`${uid}\0${providerAccountId}\0${messageId}`).digest('hex');
}

export function legacyMarkerIdFor(messageId: string): string {
  return createHash('sha256').update(`gmail\0${messageId}`).digest('hex');
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

function markerPath(uid: string, markerId: string): string {
  return `${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${markerId}`;
}

function observationPath(uid: string, id: string): string {
  return `${userCol(uid, INTELLIGENCE_OBSERVATIONS)}/${id}`;
}

const emptyCounts = (): ScanCounts => ({
  messagesRead: 0, messagesUnavailable: 0, messagesTrimmed: 0,
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

export function publicScanStatus(scan: M5aScanDocument | null): Record<string, unknown> | null {
  if (!scan) return null;
  const common = {
    scanId: scan.scanId, status: scan.status, origin: scan.origin, from: scan.from, until: scan.until,
    startedAt: scan.startedAt, messagesRead: scan.messagesRead, messagesUnavailable: scan.messagesUnavailable,
    messagesTrimmed: scan.messagesTrimmed, observationsFound: scan.observationsFound,
    addedFromEmail: scan.addedFromEmail,
  };
  if (scan.status === 'complete') return { ...common, finishedAt: scan.finishedAt };
  if (scan.status === 'failed') return { ...common, failedAt: scan.failedAt, failure: scan.failure };
  return { ...common, waiting: null };
}

export function publicQueued(scan: M5aScanDocument | null): Record<string, unknown> | null {
  const queue = scan?.queued;
  return queue ? { scanId: queue.scanId, origin: queue.origin, from: queue.from, until: queue.until, acceptedAt: queue.acceptedAt } : null;
}

export function publicDailyStatus(scan: (M5aScanDocument & { day?: string; heldAt?: string; reason?: string }) | null): Record<string, unknown> | null {
  if (!scan) return null;
  if (scan.status === ('held' as M5aScanDocument['status']) && scan.reason === 'no_timezone') {
    return { status: 'held', reason: 'no_timezone', heldAt: scan.heldAt };
  }
  const common = publicScanStatus(scan);
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
}

function autoAddCandidate(
  message: Awaited<ReturnType<GmailTransport['getMessageById']>>,
  observations: readonly SemanticObservation[],
  timezone: string | null,
): AutoAddCandidate | null {
  if (!message || !message.sentByAccount || !message.isReply || message.bodyFormat !== 'text/plain' || !timezone) return null;
  const own = ownTextOf(message.text);
  if (own.boundary !== 'quote_header') return null;
  const cleaned = cleanEmail(own.own).body.trim();
  const agreements = observations.filter(item => (item.kind === 'commitment' || item.kind === 'event') && cleaned.includes(item.evidence));
  const unique = agreements.filter((item, index) => index === agreements.findIndex(other => other.evidence === item.evidence));
  if (unique.length !== 1) return null;
  const span = sentenceHolding(cleaned, unique[0]!.evidence);
  if (!span || !onlyGreetingRest(span.rest) || !singleAgreementSentence(span.sentence)) return null;
  const extracted = ruleBasedExtract(span.sentence, { now: new Date(message.receivedAt), timezone });
  if (!extracted.dueAt || extracted.missingFields.length > 0 || extracted.ambiguityFlags.includes('multiple_commitments')) return null;
  const mapped = mapExtractionToCommand(extracted, message.receivedAt);
  const create = mapped.find((command): command is Extract<Command, { type: 'CreateDraft' }> => command.type === 'CreateDraft');
  return create ? { evidence: unique[0]!.evidence, sentence: span.sentence, command: create } : null;
}

function classifyFailure(error: unknown): ScanFailure {
  if (error instanceof Error && (error.message === 'source_analysis_failed' || error.message === 'analysis_unavailable')) return 'analysis_unavailable';
  if (error instanceof Error && error.message === 'reconnect_needed') return 'reconnect_needed';
  if (error instanceof GmailProviderError && (error.status === 401 || error.status === 403)) return 'reconnect_needed';
  return 'source_unavailable';
}

async function failScan(uid: string, scanId: string, owner: string, failure: ScanFailure, storage: StorageAdapter, now: string): Promise<void> {
  await storage.runTransaction(async tx => {
    const scan = await tx.get<M5aScanDocument>(scanPath(uid));
    if (!scan || scan.scanId !== scanId || scan.leaseOwner !== owner) return;
    tx.set(scanPath(uid), { ...scan, status: 'failed', failure, failedAt: now, leaseOwner: null, leaseUntil: null, nextEligibleAt: now });
  });
}

async function releaseClaims(uid: string, owner: string, ids: readonly string[], storage: StorageAdapter): Promise<void> {
  await storage.runTransaction(async tx => {
    const markers = await Promise.all(ids.map(id => tx.get<M5aMarker>(markerPath(uid, id))));
    markers.forEach((marker, index) => {
      if (marker?.state === 'claimed' && marker.owner === owner) tx.set(markerPath(uid, ids[index]!), {
        ...marker, state: 'released', owner: undefined, leaseUntil: undefined,
      });
    });
  });
}

async function countFinishedMarker(
  uid: string, scan: M5aScanDocument, owner: string, messageId: string, markerId: string,
  storage: StorageAdapter,
): Promise<boolean> {
  return storage.runTransaction(async tx => {
    const [current, marker] = await Promise.all([
      tx.get<M5aScanDocument>(scanPath(uid)), tx.get<M5aMarker>(markerPath(uid, markerId)),
    ]);
    if (!current || current.scanId !== scan.scanId || current.leaseOwner !== owner || marker?.state !== 'done') return false;
    const receipt = transitionReceipt(marker, scan.scanId, 'read');
    const done = Array.from(new Set([...(current.page?.done ?? []), messageId]));
    tx.set(markerPath(uid, markerId), receipt.marker);
    tx.set(scanPath(uid), advancePage({
      ...current,
      messagesRead: current.messagesRead + receipt.readDelta,
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
  const claimed = await storage.runTransaction(async tx => {
    const [scan, providerMarker, legacyMarker] = await Promise.all([
      tx.get<M5aScanDocument>(scanPath(uid)),
      tx.get<M5aMarker | Record<string, unknown>>(markerPath(uid, providerMarkerId)),
      tx.get<M5aMarker | Record<string, unknown>>(markerPath(uid, legacyMarkerId)),
    ]);
    if (!scan || scan.scanId !== claimedScan.scanId || scan.leaseOwner !== owner) return { kind: 'lost' as const };
    const now = runtime.now().toISOString();
    const providerDecision = markerDecision(providerMarker, 'm5a', now);
    const legacyDecision = markerDecision(legacyMarker, 'm5a', now);
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
    return { kind: 'claimed' as const, preexisting };
  });
  if (claimed.kind === 'lost' || claimed.kind === 'blocked') return;
  if (claimed.kind === 'done') {
    await countFinishedMarker(uid, claimedScan, owner, messageId, claimed.markerId, storage);
    return;
  }

  try {
    const message = await transport.getMessageById(messageId);
    if (!message) {
      await storage.runTransaction(async tx => {
        const [scan, provider, legacy] = await Promise.all([
          tx.get<M5aScanDocument>(scanPath(uid)), tx.get<M5aMarker>(markerPath(uid, providerMarkerId)), tx.get<M5aMarker>(markerPath(uid, legacyMarkerId)),
        ]);
        if (!scan || scan.scanId !== claimedScan.scanId || scan.leaseOwner !== owner
          || provider?.owner !== claimOwner || legacy?.owner !== claimOwner) return;
        const receipt = transitionReceipt({ ...provider, state: 'unavailable' }, scan.scanId, 'unavailable');
        const done = Array.from(new Set([...(scan.page?.done ?? []), messageId]));
        tx.set(markerPath(uid, providerMarkerId), receipt.marker);
        tx.set(markerPath(uid, legacyMarkerId), { ...legacy, state: 'released', owner: undefined, leaseUntil: undefined });
        tx.set(scanPath(uid), advancePage({ ...scan,
          messagesRead: scan.messagesRead + receipt.readDelta,
          messagesUnavailable: scan.messagesUnavailable + receipt.unavailableDelta,
          page: scan.page ? { ...scan.page, done } : null,
        }));
      });
      return;
    }
    const raw = [message.subject ?? '', message.text].filter(Boolean).join('\n');
    const prepared = trimForAnalysis(raw);
    const observations = prepared.text ? await analyzeSourceStaged(uid, 'gmail', prepared.text,
      runtime.shareModel ? { generate: runtime.shareModel } : {}) : [];
    const candidate = autoAddCandidate(message, observations, claimedScan.timezone);
    const ref = gmailRefFor(claimedScan.providerAccountId, messageId);
    const addId = autoAddIdFor(uid, claimedScan.providerAccountId, messageId);
    const at = runtime.now().toISOString();

    await storage.runTransaction(async tx => {
      const [scan, provider, legacy, controls, user, connection, existingObservations, state, existingAutoAdd] = await Promise.all([
        tx.get<M5aScanDocument>(scanPath(uid)),
        tx.get<M5aMarker>(markerPath(uid, providerMarkerId)),
        tx.get<M5aMarker>(markerPath(uid, legacyMarkerId)),
        tx.get<unknown>(M5A_CONTROLS_PATH),
        tx.get<Record<string, any>>(userDoc(uid)),
        tx.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
        tx.list<StoredObservation>(userCol(uid, INTELLIGENCE_OBSERVATIONS)),
        loadDomainState(tx, uid),
        tx.get<AutoAddRecord>(autoAddPath(uid, addId)),
      ]);
      const parsedControls = parseM5aControls(controls);
      if (!scan || scan.scanId !== claimedScan.scanId || scan.leaseOwner !== owner
        || provider?.owner !== claimOwner || legacy?.owner !== claimOwner
        || !parsedControls?.email.enabled || parsedControls.email.epoch !== scan.emailEpoch
        || !isLiveConnection(connection) || connection.identity.providerAccountId !== scan.providerAccountId
        || user?.personalizationPurge?.state === 'purging') throw new Error('scan_fence_changed');

      const priorTrace = claimed.preexisting || existingObservations.some(row => row.data.sourceRef === messageId || row.data.sourceRef === ref);
      const spentCommitment = Object.values(state.commitments).some(commitment => commitment.addedFrom?.autoAddId === addId);
      let autoAdd: AutoAddRecord | null = null;
      let finalState = state;
      let events: DomainEvent[] = [];
      let supporting = new Set<string>();
      if (candidate && !priorTrace && !existingAutoAdd && !spentCommitment && user?.trust?.calendarConsent === true) {
        const create: Extract<Command, { type: 'CreateDraft' }> = {
          ...candidate.command,
          now: at,
          commitment: { ...candidate.command.commitment, id: `m5a_${addId.slice(0, 32)}` },
          draftStatus: 'pending_confirmation',
        };
        if (create.commitment.timeSpec?.dueAt && Date.parse(create.commitment.timeSpec.dueAt) > runtime.now().getTime()) {
          const schedule = await readFreeSlotSchedule(uid, {
            startsAt: create.commitment.timeSpec.dueAt,
            endsAt: create.commitment.timeSpec.endAt ?? new Date(Date.parse(create.commitment.timeSpec.dueAt) + 60 * 60_000).toISOString(),
          }, tx as unknown as StorageAdapter, at);
          if (candidateClashes(schedule, { timeSpec: {
            kind: create.commitment.timeSpec.kind ?? 'scheduled_event',
            dueAt: create.commitment.timeSpec.dueAt,
            endAt: create.commitment.timeSpec.endAt ?? null,
            remindAt: create.commitment.timeSpec.remindAt ?? null,
            allDay: create.commitment.timeSpec.allDay ?? false,
            timezone: create.commitment.timeSpec.timezone ?? scan.timezone ?? 'UTC',
          } }).state === 'free') {
            let transition = applyCommand(finalState, create);
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
        writeDomainDiff(tx, uid, state, finalState, events, user as never, at);
        tx.create(autoAddPath(uid, addId), autoAdd);
      }
      const outcome = prepared.trimmed ? 'trimmed' : prepared.text ? 'analyzed' : 'empty';
      const baseMarker: M5aMarker = {
        ...provider, v: 2, state: 'done', owner: undefined, leaseUntil: undefined, processedAt: at,
        outcome, observationIds, autoAddId: autoAdd?.autoAddId ?? null,
      };
      const receipt = transitionReceipt(baseMarker, scan.scanId, 'read');
      const done = Array.from(new Set([...(scan.page?.done ?? []), messageId]));
      tx.set(markerPath(uid, providerMarkerId), receipt.marker);
      tx.set(markerPath(uid, legacyMarkerId), { ...receipt.marker, providerMarkerId, providerAccountId: scan.providerAccountId });
      tx.set(scanPath(uid), advancePage({ ...scan,
        messagesRead: scan.messagesRead + receipt.readDelta,
        messagesUnavailable: scan.messagesUnavailable + receipt.unavailableDelta,
        messagesTrimmed: scan.messagesTrimmed + (receipt.readDelta && prepared.trimmed ? 1 : 0),
        observationsFound: scan.observationsFound + (receipt.readDelta ? observationIds.length : 0),
        addedFromEmail: scan.addedFromEmail + (receipt.readDelta && autoAdd ? 1 : 0),
        page: scan.page ? { ...scan.page, done } : null,
      }));
    });
  } catch (error) {
    await releaseClaims(uid, claimOwner, markerIds, storage);
    throw error;
  }
}

async function runStep(uid: string, runtime: GoogleRuntime, supplied?: GmailTransport): Promise<void> {
  const storage = runtime.storage;
  const now = runtime.now();
  const owner = randomUUID();
  const claimed = await storage.runTransaction(async tx => {
    const [scan, controls, user, connection] = await Promise.all([
      tx.get<M5aScanDocument>(scanPath(uid)),
      tx.get<unknown>(M5A_CONTROLS_PATH),
      tx.get<Record<string, any>>(userDoc(uid)),
      tx.get<IntegrationConnectionRecord>(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google'))),
    ]);
    if (!scan || (scan.status !== 'running' && scan.status !== 'failed')) return null;
    if (scan.leaseUntil && scan.leaseUntil > now.toISOString()) return null;
    const parsed = parseM5aControls(controls);
    if (!parsed?.email.enabled || parsed.email.epoch !== scan.emailEpoch || user?.personalizationPurge?.state === 'purging') {
      tx.set(scanPath(uid), { ...scan, status: 'failed', failure: 'monitoring_off', failedAt: now.toISOString(),
        leaseOwner: null, leaseUntil: null, nextEligibleAt: now.toISOString() });
      return null;
    }
    if (!isLiveConnection(connection) || connection.identity.providerAccountId !== scan.providerAccountId) {
      tx.set(scanPath(uid), { ...scan, status: 'failed', failure: 'reconnect_needed', failedAt: now.toISOString(),
        leaseOwner: null, leaseUntil: null, nextEligibleAt: now.toISOString() });
      return null;
    }
    const next = { ...scan, status: 'running' as const, failure: null, failedAt: null,
      leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString() };
    tx.set(scanPath(uid), next);
    return next;
  });
  if (!claimed) return;
  try {
    await requireReadableFeature(uid, 'gmail', runtime);
    const transport = supplied ?? transportFor(uid, runtime);
    if (!claimed.page) {
      let listed: Awaited<ReturnType<GmailTransport['listRecentMessageIds']>>;
      try {
        listed = await transport.listRecentMessageIds({ query: claimed.query, maxResults: 100, pageToken: claimed.pageToken });
      } catch (error) {
        if (claimed.pageToken !== null && error instanceof GmailProviderError && error.status === 400) {
          await storage.runTransaction(async tx => {
            const scan = await tx.get<M5aScanDocument>(scanPath(uid));
            if (scan?.scanId === claimed.scanId && scan.leaseOwner === owner) tx.set(scanPath(uid), {
              ...scan, pageToken: null, page: null, leaseOwner: null, leaseUntil: null,
            });
          });
          return;
        }
        throw error;
      }
      await storage.runTransaction(async tx => {
        const scan = await tx.get<M5aScanDocument>(scanPath(uid));
        if (!scan || scan.scanId !== claimed.scanId || scan.leaseOwner !== owner) return;
        const withPage = { ...scan, page: { ids: [...listed.ids], nextPageToken: listed.nextPageToken, done: [] } };
        tx.set(scanPath(uid), listed.ids.length === 0 ? advancePage(withPage) : { ...withPage, leaseOwner: null, leaseUntil: null });
      });
      return;
    }
    const nextId = claimed.page.ids.find(id => !claimed.page!.done.includes(id));
    if (!nextId) {
      await storage.runTransaction(async tx => {
        const scan = await tx.get<M5aScanDocument>(scanPath(uid));
        if (scan?.scanId === claimed.scanId && scan.leaseOwner === owner) tx.set(scanPath(uid), advancePage(scan));
      });
      return;
    }
    await processMessage(uid, claimed, owner, nextId, transport, runtime);
  } catch (error) {
    await failScan(uid, claimed.scanId, owner, classifyFailure(error), storage, runtime.now().toISOString());
  }
}

export async function readM5aScan(uid: string, storage: StorageAdapter = getStorage()): Promise<M5aScanDocument | null> {
  return storage.get<M5aScanDocument>(scanPath(uid));
}

export async function readM5aDailyScan(
  uid: string,
  storage: StorageAdapter = getStorage(),
): Promise<(M5aScanDocument & { day?: string; heldAt?: string; reason?: string }) | null> {
  return storage.get<M5aScanDocument & { day?: string; heldAt?: string; reason?: string }>(dailyScanPath(uid));
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
      || user?.personalizationPurge?.state === 'purging'
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
  if (admitted.run) await runStep(uid, runtime);
  return (await readM5aScan(uid, storage)) ?? admitted.scan;
}
