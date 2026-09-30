/**
 * The capture chat «احكيها» (owner decision 2026-09-30).
 *
 * One message in, one reply out, and the conversation's current proposal —
 * the very proposal shape the capture route returns, stored in the same
 * store, so the existing clarify and confirm routes take its `proposalId`
 * unchanged. Nothing here writes a commitment: the only way anything is kept
 * is the person's own confirm.
 *
 * ── One model call per message ───────────────────────────────────
 *
 * The model is shown the conversation (the person's turns and its own earlier
 * replies) and the current list, and answers `{ reply, action, items }` with
 * the complete list after this message. Every item then goes through the
 * capture boundary as a capture's clause does — the validator, the time
 * lexicon's guards, the weekly-block offer, the clarification builder, the
 * past-time guard, the multi-time valve — checked against the person's turns
 * together, and the chat's own guard takes off any hour or day they never
 * said (`captureBoundary/chatEvidence`). The reply is shown only if it passes
 * `chatReply`; otherwise a template built from the proposal is.
 *
 * ── Always a working answer ──────────────────────────────────────
 *
 * The model unavailable, a cap reached (60 a day per person, the global daily
 * cap, the minute cap — `lib/llm/usageGuard`, unchanged), a provider error,
 * the kill switch, or an answer that is not the agreed shape: the person's
 * turns, joined, are read by the rules exactly as a capture without a model
 * is, and the reply is a template in their language. `engine` says which.
 *
 * ── What is kept, and for whom ───────────────────────────────────
 *
 * `users/{uid}/captureConversations/{id}` (`conversationStore`): addressed by
 * the uid and the id together, so another account's id is a 404. At most
 * `MAX_CHAT_TURNS` turns, and the person's words together never longer than a
 * capture may be (`CAPTURE_INPUT_MAX_CHARACTERS`) — the oldest turns go first
 * — so the validator never reads more than it reads for a capture. A message
 * refused as an injection is not kept at all.
 *
 * Content-free throughout: the model call logs through `captureLlmProvider`
 * (counts, latency, a hashed uid), the funnel counts a length, and nothing
 * here logs a message, a reply or the model's output.
 */
import { randomUUID } from 'crypto';
import { CAPTURE_INPUT_MAX_CHARACTERS } from '../../../src/contracts/v1/captureContracts';
import type { CaptureProposalContract } from '../../../src/contracts/v1/captureContracts';
import { resolveModuleRuntime, type RuntimeControlSnapshot } from '../../../src/contracts/v1/runtimeControls';
import { screenForInjection } from '../../../src/extraction/injectionBoundary';
import { CAPTURE_MIN_CALL_TIMEOUT_MS, type LLMProviderFunction } from '../../../src/extraction/llm/llmProvider';
import { localTimeSpecFor } from '../../../src/extraction/timeLexicon';
import { getAiConsent } from '../../consents/aiConsentService';
import { CHAT_TIMEOUT_MS, captureLlmProvider } from '../../llm/captureProvider';
import { CAPTURE_SERVER_BUDGET_MS, CaptureInputTooLargeError } from '../captureBoundary/captureBoundaryService';
import { chatEvidenceFrom } from '../captureBoundary/chatEvidence';
import { proposeMobileChatTurn, readMobileChatProposal } from '../mobile/mobileCaptureService';
import { dateFromOptionalIso, normalizeTimezone } from '../mobile/time';
import { buildChatPrompt, parseChatModelAnswer, type ChatPromptItem } from './chatPrompt';
import { detectChatLanguage, safeChatReply, templateReply, type ChatLanguage } from './chatReply';
import {
  CaptureConversationStore,
  conversationExpired,
  isConversationId,
  type CaptureChatTurn,
  type StoredCaptureConversation,
} from './conversationStore';

/** The most turns a conversation keeps, the person's and the assistant's together. */
export const MAX_CHAT_TURNS = 12;

/**
 * Server time kept back from the model call for what follows it: the
 * boundary's validation and the two writes. The call gets the rest of the
 * capture budget (`CAPTURE_SERVER_BUDGET_MS`), at most `CHAT_TIMEOUT_MS`.
 */
const CHAT_AFTER_MODEL_RESERVE_MS = 1_500;

export type CaptureChatErrorReason = 'message_required' | 'invalid_conversation_id' | 'conversation_not_found';

/** A request the chat refuses; the route answers with `status` and `reason`. */
export class CaptureChatError extends Error {
  constructor(readonly reason: CaptureChatErrorReason, readonly status: 400 | 404) {
    super(reason === 'conversation_not_found'
      ? 'conversation not found'
      : reason === 'invalid_conversation_id' ? 'conversationId is not a conversation id' : 'message is required');
    this.name = 'CaptureChatError';
  }
}

export interface CaptureChatInput {
  conversationId?: unknown;
  message?: unknown;
  timezone?: unknown;
  referenceTime?: unknown;
}

export type CaptureChatProposal = Awaited<ReturnType<typeof proposeMobileChatTurn>>;

export interface CaptureChatResponse {
  conversationId: string;
  reply: string;
  engine: 'model' | 'rules';
  proposal: CaptureChatProposal | null;
  turns: CaptureChatTurn[];
}

export interface CaptureChatDependencies {
  /**
   * The model, for this account. Absent: the metered, logged, gated
   * `captureLlmProvider(uid, { purpose: 'capture_chat' })`. `null`: no model.
   */
  llmProviderFor?: ((uid: string) => LLMProviderFunction | null) | undefined;
  conversations?: CaptureConversationStore;
  controls?: RuntimeControlSnapshot;
  clock?: () => number;
}

let testDependencies: CaptureChatDependencies | null = null;

/** Tests only: what the route's calls use in place of the production defaults. */
export function setCaptureChatDependenciesForTests(dependencies: CaptureChatDependencies | null): void {
  testDependencies = dependencies;
}

const defaultConversations = new CaptureConversationStore();

/**
 * The turns kept, newest last: at most `limit`, never starting with an
 * assistant reply, and the person's words together within the capture cap.
 */
export function boundedTurns(turns: readonly CaptureChatTurn[], limit: number = MAX_CHAT_TURNS): CaptureChatTurn[] {
  const kept = [...turns];
  const userLength = () => kept.filter((turn) => turn.role === 'user').map((turn) => turn.text).join('\n').length;
  while (kept.length > 1 && (kept.length > limit || userLength() > CAPTURE_INPUT_MAX_CHARACTERS || kept[0]!.role !== 'user')) {
    kept.shift();
  }
  return kept;
}

/** The list as the model is shown it: titles and the person's own clock. */
function promptItems(proposal: CaptureChatProposal | null, timezone: string): ChatPromptItem[] {
  if (!proposal) return [];
  return proposal.items.map((item) => {
    const local = item.resolvedTime ? localTimeSpecFor(new Date(item.resolvedTime), timezone) : null;
    return {
      title: item.title,
      date: local?.date ?? item.resolvedDate ?? null,
      time: local?.time ?? null,
      needsDayOrTime: Boolean(item.needsClarification),
    };
  });
}

/**
 * A proposal worth showing as cards: one with items or «maybe» seeds (#519),
 * that is not a refusal. A seed-only capture is `unresolved_intent`, not
 * nothing: only the person can say whether it is worth keeping.
 */
function shown(proposal: CaptureChatProposal): CaptureChatProposal | null {
  return proposal.status !== 'rejected' && (proposal.items.length > 0 || proposal.seeds.length > 0) ? proposal : null;
}

export async function chatMobileCapture(
  input: CaptureChatInput,
  context: { participantId: string; requestStartedAt?: number },
  dependencies: CaptureChatDependencies = testDependencies ?? {},
): Promise<CaptureChatResponse> {
  const clock = dependencies.clock ?? Date.now;
  const requestStartedAt = context.requestStartedAt ?? clock();
  const uid = context.participantId;

  // The message is bounded before anything reads it, exactly as a capture's
  // text is (#508): the length is checked first, and refused, never cut.
  if (typeof input.message !== 'string' || !input.message.trim()) throw new CaptureChatError('message_required', 400);
  if (input.message.length > CAPTURE_INPUT_MAX_CHARACTERS) throw new CaptureInputTooLargeError();
  const message = input.message.trim();
  const timezone = normalizeTimezone(input.timezone);
  const now = dateFromOptionalIso(input.referenceTime, new Date(clock()), 'referenceTime');

  const conversations = dependencies.conversations ?? defaultConversations;
  let conversation: StoredCaptureConversation;
  if (input.conversationId === undefined || input.conversationId === null) {
    const createdAt = new Date(clock()).toISOString();
    conversation = { conversationId: randomUUID(), turns: [], proposalId: null, createdAt, updatedAt: createdAt };
  } else {
    if (!isConversationId(input.conversationId)) throw new CaptureChatError('invalid_conversation_id', 400);
    const found = await conversations.get(uid, input.conversationId);
    // Another account's id and an expired one are the same answer: there is
    // no such conversation here.
    if (!found || conversationExpired(found, clock())) throw new CaptureChatError('conversation_not_found', 404);
    conversation = found;
  }

  const previousUserTurns = conversation.turns.filter((turn) => turn.role === 'user');
  const language: ChatLanguage = detectChatLanguage(
    message,
    previousUserTurns.length > 0 ? detectChatLanguage(previousUserTurns[previousUserTurns.length - 1]!.text) : 'ar',
  );
  const current = conversation.proposalId ? await readMobileChatProposal(conversation.proposalId, uid) : null;

  const finish = async (reply: string, engine: 'model' | 'rules', proposal: CaptureChatProposal | null, turns: CaptureChatTurn[]) => {
    const kept = boundedTurns([...turns, { role: 'assistant', text: reply }]);
    const updatedAt = new Date(clock()).toISOString();
    await conversations.put(uid, { ...conversation, turns: kept, proposalId: proposal?.proposalId ?? null, updatedAt }, new Date(clock()));
    return { conversationId: conversation.conversationId, reply, engine, proposal, turns: kept };
  };

  // An injection is refused before any model sees it, and is not kept: left
  // in the conversation it would be evidence for every later turn.
  if (screenForInjection(message)) {
    return finish(templateReply({ language, proposal: current, refused: true }), 'rules', current, conversation.turns);
  }

  // The newest message is always kept whole: `boundedTurns` drops the oldest
  // turns until the person's words fit the capture cap, one assistant reply
  // short of the limit so the reply still fits after it.
  const turns = boundedTurns([...conversation.turns, { role: 'user', text: message }], MAX_CHAT_TURNS - 1);
  const userTurns = turns.filter((turn) => turn.role === 'user').map((turn) => turn.text);

  // ── the model ───────────────────────────────────────────────────
  const runtime = resolveModuleRuntime('capture', dependencies.controls);
  const consent = await getAiConsent(uid);
  const provider = runtime.mode === 'rules_only' || consent !== 'granted'
    ? null
    : dependencies.llmProviderFor !== undefined
      ? dependencies.llmProviderFor(uid)
      : captureLlmProvider(uid, { purpose: 'capture_chat' });
  const timeoutMs = Math.min(CHAT_TIMEOUT_MS, CAPTURE_SERVER_BUDGET_MS - (clock() - requestStartedAt) - CHAT_AFTER_MODEL_RESERVE_MS);

  let answer: ReturnType<typeof parseChatModelAnswer> = null;
  if (provider && timeoutMs >= CAPTURE_MIN_CALL_TIMEOUT_MS) {
    try {
      const text = await provider(buildChatPrompt(turns, promptItems(current, timezone), { now, timezone }), { timeoutMs });
      answer = parseChatModelAnswer(text);
    } catch {
      // The cap, the kill switch, a timeout, a provider error: the reason is
      // on the call's own log line (`captureLlmProvider`), and the rules
      // answer below.
      answer = null;
    }
  }

  if (answer) {
    const changesList = answer.action === 'propose' || answer.action === 'update' || (answer.action === 'ask' && answer.items.length > 0);
    let proposal = current;
    if (changesList) {
      const evidence = chatEvidenceFrom(userTurns);
      const built = await proposeMobileChatTurn(
        { text: message, userTurns, items: evidence ? answer.items : [], now, timezone },
        { participantId: uid, requestStartedAt },
      );
      proposal = shown(built);
    }
    const { reply } = safeChatReply(answer.reply, {
      language,
      proposal,
      cleared: Boolean(current) && !proposal,
      offTopic: answer.action === 'chat',
    });
    return finish(reply, 'model', proposal, turns);
  }

  // ── the rules, on the person's turns joined ─────────────────────
  const built = await proposeMobileChatTurn(
    { text: userTurns.join('\n'), userTurns, items: null, now, timezone },
    { participantId: uid, requestStartedAt },
  );
  const proposal = shown(built);
  // Nobody asked for anything to be removed here: an empty reading is
  // "what do you need?", or the off-topic redirect for a question.
  const reply = templateReply({
    language,
    proposal: proposal ?? (built as Pick<CaptureProposalContract, 'items' | 'noCommitmentReason'>),
  });
  return finish(reply, 'rules', proposal, turns);
}
