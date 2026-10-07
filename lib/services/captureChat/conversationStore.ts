/**
 * Where a capture-chat conversation lives between turns (owner decision
 * 2026-09-30).
 *
 * `users/{uid}/captureConversations/{conversationId}`: addressed by the uid
 * *and* the id, never by the id alone. There is no collection-group lookup, so
 * a conversation id another account minted names nothing under this uid — the
 * route answers 404 exactly as it does for an id that never existed.
 *
 * ── Two expiries, as the proposal store has ─────────────────────
 *
 * `updatedAt` is what the service reads: a conversation idle for longer than
 * a capture proposal stays confirmable (`CAPTURE_PROPOSAL_TTL_MS`) is over,
 * because its proposal is. `expiresAt` is Firestore's TTL sweep
 * (infra/firestore-ttl.sh), a day after the last turn, the same retention the
 * proposals have — the person's words are not kept once nobody can use them.
 *
 * The same storage the proposals use, per environment: the memory adapter in
 * tests, Firestore on staging and production.
 */
import { CAPTURE_PROPOSAL_TTL_MS } from '../../../src/contracts/v1/captureContracts';
import { CAPTURE_PROPOSAL_RETENTION_MS } from '../captureBoundary/proposalStore';
import { CAPTURE_CONVERSATIONS, getStorage, userSubDoc, type StorageAdapter } from '../../storage';

export interface CaptureChatTurn {
  role: 'user' | 'assistant';
  text: string;
  /** False only for a server-synthesised display turn; never user evidence. */
  evidence?: false;
}

export interface StoredCaptureConversation {
  conversationId: string;
  turns: CaptureChatTurn[];
  /** The conversation's current proposal, or null when it has none. */
  proposalId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Exact last message response, so a transport retry within two minutes cannot apply its delta twice. */
  messageReceipt?: {
    fingerprint: string;
    receivedAt: number;
    answer: unknown;
    /** Proposal state the answer describes; a later card mutation makes the receipt stale. */
    proposalId: string | null;
    proposalRevision: number | null;
    lockedRefs: string[];
  };
}

interface ConversationDocument extends StoredCaptureConversation {
  expiresAt: Date;
}

/** A conversation id this server minted: a v4-shaped uuid, and nothing else. */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID.test(value);
}

export function captureConversationPath(uid: string, conversationId: string): string {
  return userSubDoc(uid, CAPTURE_CONVERSATIONS, conversationId);
}

/** Idle longer than a proposal stays confirmable: the conversation is over. */
export function conversationExpired(conversation: StoredCaptureConversation, nowMs: number = Date.now()): boolean {
  const updated = Date.parse(conversation.updatedAt);
  return !Number.isFinite(updated) || nowMs - updated > CAPTURE_PROPOSAL_TTL_MS;
}

function isTurn(value: unknown): value is CaptureChatTurn {
  const turn = value as CaptureChatTurn | null;
  return Boolean(turn) && (turn!.role === 'user' || turn!.role === 'assistant') && typeof turn!.text === 'string';
}

export class CaptureConversationStore {
  constructor(private readonly injected?: StorageAdapter) {}

  /** Resolved per call, like the proposal store, so a test may swap the adapter. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  async get(uid: string, conversationId: string): Promise<StoredCaptureConversation | null> {
    if (!isConversationId(conversationId)) return null;
    const document = await this.storage.get<ConversationDocument>(captureConversationPath(uid, conversationId));
    if (!document || document.conversationId !== conversationId) return null;
    return {
      conversationId: document.conversationId,
      turns: Array.isArray(document.turns) ? document.turns.filter(isTurn).map((turn) => ({
        role: turn.role,
        text: turn.text,
        ...(turn.evidence === false ? { evidence: false as const } : {}),
      })) : [],
      proposalId: typeof document.proposalId === 'string' ? document.proposalId : null,
      createdAt: String(document.createdAt ?? ''),
      updatedAt: String(document.updatedAt ?? ''),
      ...(document.messageReceipt
        && typeof document.messageReceipt.fingerprint === 'string'
        && typeof document.messageReceipt.receivedAt === 'number'
        && Number.isFinite(document.messageReceipt.receivedAt)
        && document.messageReceipt.answer
        && typeof document.messageReceipt.answer === 'object'
        && (document.messageReceipt.proposalId === null || typeof document.messageReceipt.proposalId === 'string')
        && (document.messageReceipt.proposalRevision === null
          || (typeof document.messageReceipt.proposalRevision === 'number' && Number.isInteger(document.messageReceipt.proposalRevision)))
        && Array.isArray(document.messageReceipt.lockedRefs)
        && document.messageReceipt.lockedRefs.every((ref) => typeof ref === 'string')
        ? { messageReceipt: {
          fingerprint: document.messageReceipt.fingerprint,
          receivedAt: document.messageReceipt.receivedAt,
          answer: document.messageReceipt.answer,
          proposalId: document.messageReceipt.proposalId,
          proposalRevision: document.messageReceipt.proposalRevision,
          lockedRefs: [...document.messageReceipt.lockedRefs].sort(),
        } }
        : {}),
    };
  }

  async put(uid: string, conversation: StoredCaptureConversation, now: Date = new Date()): Promise<void> {
    await this.storage.set<ConversationDocument>(captureConversationPath(uid, conversation.conversationId), {
      conversationId: conversation.conversationId,
      turns: conversation.turns.map((turn) => ({
        role: turn.role,
        text: turn.text,
        ...(turn.evidence === false ? { evidence: false as const } : {}),
      })),
      proposalId: conversation.proposalId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      ...(conversation.messageReceipt === undefined ? {} : { messageReceipt: conversation.messageReceipt }),
      expiresAt: new Date(now.getTime() + CAPTURE_PROPOSAL_RETENTION_MS),
    });
  }
}
