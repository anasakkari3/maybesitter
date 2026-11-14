import { createHash, createHmac } from 'node:crypto';
import type { GmailMessagePayload } from '../integrations/gmail/adapter';
import { uidHash } from '../llm/llmLog';
import {
  GMAIL_SENDER_STATS,
  getStorage,
  userCol,
  userDoc,
  type StorageAdapter,
} from '../storage';
import { isConversationReply } from './emailTriage';
import { liveAccount } from './memoryBasis';

type EnvLike = Readonly<Record<string, string | undefined>>;

export const SENDER_EMPTY_THRESHOLD = 5;
export const SUBJECT_EMPTY_THRESHOLD = 5;
export const GMAIL_SENDER_FILTER_AUDIT_RATE = 0.05;

const CONVERSATION_PREFIX = /^\s*(?:re|fwd?|aw|wg|sv|vs|tr|השב|תשובה|הועבר|رد|الرد|تحويل|إعادة توجيه)\s*(?:\[\d{1,3}\])?\s*[:：]/i;
const EMAIL_ADDRESS = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export interface GmailSubjectStats {
  readonly fullyRead: number;
  readonly produced: number;
  readonly skipped: number;
}

export interface GmailSenderStats {
  readonly v: 1;
  readonly senderKey: string;
  readonly fullyRead: number;
  readonly produced: number;
  readonly skipped: number;
  readonly subjects: Readonly<Record<string, GmailSubjectStats>>;
  readonly displayAddress: string;
  readonly repliedTo: boolean;
  readonly lastSeenAt: string;
}

export interface SenderFilterDecisionMessage {
  readonly id: string;
  readonly subjectKey: string | null;
  readonly conversationReply: boolean;
  readonly sentByAccount: boolean;
  readonly starred: boolean;
}

export type SenderFilterDecisionReason =
  | 'missing_sender'
  | 'sent_by_account'
  | 'conversation_reply'
  | 'starred'
  | 'replied_to_sender'
  | 'below_threshold'
  | 'audit_sample'
  | 'sender_empty'
  | 'subject_empty'
  | 'sender_and_subject_empty';

export interface SenderFilterDecision {
  readonly action: 'read' | 'skip';
  readonly reason: SenderFilterDecisionReason;
  readonly audited: boolean;
}

export interface SenderFilterMessageIdentity {
  readonly from: string | null;
  readonly subject: string | null;
}

export interface SenderFilterOutcomeMessage extends SenderFilterMessageIdentity {
  readonly id: string;
  readonly sentByAccount?: boolean;
  readonly isReply?: boolean;
  readonly starred?: boolean;
  readonly recipients?: readonly string[];
}

export interface EvaluatedSenderFilter {
  readonly decision: SenderFilterDecision;
  readonly stats: GmailSenderStats | null;
  readonly senderKey: string | null;
  readonly subjectKey: string | null;
}

export function gmailSenderFilterEnabled(env: EnvLike = process.env): boolean {
  return env.MAYBESITTER_GMAIL_SENDER_FILTER?.trim().toLowerCase() === 'on';
}

export function normalizeSubject(subject: string | null | undefined): string {
  let normalized = (subject ?? '').normalize('NFKC').trim();
  while (CONVERSATION_PREFIX.test(normalized)) normalized = normalized.replace(CONVERSATION_PREFIX, '').trimStart();
  return normalized.toLowerCase().replace(/[0-9\u0660-\u0669\u06f0-\u06f9]+/g, '#').replace(/\s+/g, ' ').trim();
}

export function normalizeSenderAddress(sender: string | null | undefined): string | null {
  const match = EMAIL_ADDRESS.exec((sender ?? '').normalize('NFKC'));
  return match ? match[0]!.toLowerCase() : null;
}

function hmac(uid: string, kind: 'sender' | 'subject', value: string, env: EnvLike = process.env): string {
  const salt = env.MAYBESITTER_LLM_UID_SALT;
  const productionLike = env.NODE_ENV === 'production'
    || env.MAYBESITTER_ENV === 'staging'
    || env.MAYBESITTER_ENV === 'production';
  if (!salt && productionLike) throw new Error('MAYBESITTER_LLM_UID_SALT is required in production-like environments');
  return createHmac('sha256', salt ?? '').update(`${uid}\0${kind}\0${value}`).digest('hex');
}

export function senderKey(uid: string, sender: string, env: EnvLike = process.env): string {
  return hmac(uid, 'sender', normalizeSenderAddress(sender) ?? sender.normalize('NFKC').trim().toLowerCase(), env);
}

export function subjectKey(uid: string, subject: string, env: EnvLike = process.env): string {
  return hmac(uid, 'subject', normalizeSubject(subject), env);
}

/** The same id is always audited or never audited, across retries and processes. */
export function isSenderFilterAuditSample(messageId: string): boolean {
  const digest = createHash('sha256').update(`gmail-sender-filter\0${messageId}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32 < GMAIL_SENDER_FILTER_AUDIT_RATE;
}

export function decide(stats: GmailSenderStats | null, message: SenderFilterDecisionMessage): SenderFilterDecision {
  const read = (reason: SenderFilterDecisionReason, audited = false): SenderFilterDecision => ({ action: 'read', reason, audited });
  if (!stats) return read('missing_sender');
  if (message.sentByAccount) return read('sent_by_account');
  if (message.conversationReply) return read('conversation_reply');
  if (message.starred) return read('starred');
  if (stats.repliedTo) return read('replied_to_sender');
  const senderEmpty = stats.produced === 0 && stats.fullyRead >= SENDER_EMPTY_THRESHOLD;
  const subject = message.subjectKey ? stats.subjects[message.subjectKey] : undefined;
  const subjectEmpty = Boolean(subject && subject.produced === 0 && subject.fullyRead >= SUBJECT_EMPTY_THRESHOLD);
  if (!senderEmpty && !subjectEmpty) return read('below_threshold');
  if (isSenderFilterAuditSample(message.id)) return read('audit_sample', true);
  return {
    action: 'skip',
    reason: senderEmpty && subjectEmpty ? 'sender_and_subject_empty' : senderEmpty ? 'sender_empty' : 'subject_empty',
    audited: false,
  };
}

function statsPath(uid: string, key: string): string {
  return `${userCol(uid, GMAIL_SENDER_STATS)}/${key}`;
}

function keysFor(uid: string, message: SenderFilterMessageIdentity): {
  address: string | null;
  senderKey: string | null;
  subjectKey: string | null;
} {
  const address = normalizeSenderAddress(message.from);
  const normalizedSubject = normalizeSubject(message.subject);
  return {
    address,
    senderKey: address ? senderKey(uid, address) : null,
    subjectKey: normalizedSubject ? subjectKey(uid, normalizedSubject) : null,
  };
}

function initialStats(key: string, address: string, at: string): GmailSenderStats {
  return {
    v: 1, senderKey: key, fullyRead: 0, produced: 0, skipped: 0,
    subjects: {}, displayAddress: address, repliedTo: false, lastSeenAt: at,
  };
}

function withFullRead(
  current: GmailSenderStats | null,
  key: string,
  address: string,
  subKey: string | null,
  produced: boolean,
  at: string,
): GmailSenderStats {
  const base = current ?? initialStats(key, address, at);
  const subjects = { ...base.subjects };
  if (subKey) {
    const subject = subjects[subKey] ?? { fullyRead: 0, produced: 0, skipped: 0 };
    subjects[subKey] = {
      ...subject,
      fullyRead: subject.fullyRead + 1,
      produced: subject.produced + (produced ? 1 : 0),
    };
  }
  return {
    ...base,
    fullyRead: base.fullyRead + 1,
    produced: base.produced + (produced ? 1 : 0),
    subjects,
    displayAddress: address,
    lastSeenAt: at,
  };
}

function withSkipped(current: GmailSenderStats, subKey: string | null, at: string): GmailSenderStats {
  const subjects = { ...current.subjects };
  if (subKey && subjects[subKey]) subjects[subKey] = { ...subjects[subKey]!, skipped: subjects[subKey]!.skipped + 1 };
  return { ...current, skipped: current.skipped + 1, subjects, lastSeenAt: at };
}

function contentFreeAuditMiss(uid: string, key: string, subKey: string | null): void {
  console.warn(JSON.stringify({
    event: 'gmail_sender_filter_audit_miss',
    uidHash: uidHash(uid),
    senderKey: key,
    ...(subKey ? { subjectKey: subKey } : {}),
  }));
}

export interface GmailSenderStatsStore {
  getForMessage(uid: string, message: SenderFilterMessageIdentity): Promise<GmailSenderStats | null>;
  evaluate(uid: string, message: GmailMessagePayload): Promise<EvaluatedSenderFilter>;
  recordFullRead(
    uid: string,
    message: SenderFilterOutcomeMessage,
    produced: boolean,
    at: string,
    options?: { audited?: boolean },
  ): Promise<void>;
  recordSkipped(uid: string, message: SenderFilterOutcomeMessage, at: string): Promise<void>;
}

export function createGmailSenderStatsStore(storage: StorageAdapter = getStorage()): GmailSenderStatsStore {
  return {
    async getForMessage(uid, message) {
      const keys = keysFor(uid, message);
      return keys.senderKey ? storage.get<GmailSenderStats>(statsPath(uid, keys.senderKey)) : null;
    },

    async evaluate(uid, message) {
      const keys = keysFor(uid, message);
      const stats = keys.senderKey ? await storage.get<GmailSenderStats>(statsPath(uid, keys.senderKey)) : null;
      return {
        stats,
        senderKey: keys.senderKey,
        subjectKey: keys.subjectKey,
        decision: decide(stats, {
          id: message.id,
          subjectKey: keys.subjectKey,
          conversationReply: Boolean(message.isReply) || isConversationReply(message.subject),
          sentByAccount: Boolean(message.sentByAccount),
          starred: Boolean(message.starred),
        }),
      };
    },

    async recordFullRead(uid, message, produced, at, options = {}) {
      const keys = keysFor(uid, message);
      const repliedTo = message.sentByAccount && message.isReply
        ? Array.from(new Set((message.recipients ?? []).map(normalizeSenderAddress).filter((value): value is string => Boolean(value))))
        : [];
      await storage.runTransaction(async tx => {
        const [account, current, ...recipientRows] = await Promise.all([
          tx.get(userDoc(uid)),
          keys.senderKey ? tx.get<GmailSenderStats>(statsPath(uid, keys.senderKey)) : Promise.resolve(null),
          ...repliedTo.map(address => tx.get<GmailSenderStats>(statsPath(uid, senderKey(uid, address)))),
        ]);
        if (!liveAccount(account)) return;
        if (keys.senderKey && keys.address && !message.sentByAccount) {
          tx.set(statsPath(uid, keys.senderKey), withFullRead(current, keys.senderKey, keys.address, keys.subjectKey, produced, at));
        }
        repliedTo.forEach((address, index) => {
          const key = senderKey(uid, address);
          const base = recipientRows[index] ?? initialStats(key, address, at);
          tx.set(statsPath(uid, key), { ...base, displayAddress: address, repliedTo: true, lastSeenAt: at });
        });
      });
      if (options.audited && produced && keys.senderKey) contentFreeAuditMiss(uid, keys.senderKey, keys.subjectKey);
    },

    async recordSkipped(uid, message, at) {
      const keys = keysFor(uid, message);
      if (!keys.senderKey) return;
      await storage.runTransaction(async tx => {
        const [account, current] = await Promise.all([
          tx.get(userDoc(uid)), tx.get<GmailSenderStats>(statsPath(uid, keys.senderKey!)),
        ]);
        if (!liveAccount(account) || !current) return;
        tx.set(statsPath(uid, keys.senderKey!), withSkipped(current, keys.subjectKey, at));
      });
    },
  };
}
