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
 * `chatReply` — with the one missing question added when that is all it
 * lacks; otherwise a template built from the proposal is.
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
import { CAPTURE_INPUT_MAX_CHARACTERS, captureAppLocaleFrom } from '../../../src/contracts/v1/captureContracts';
import type { CaptureProposalContract } from '../../../src/contracts/v1/captureContracts';
import { resolveModuleRuntime, type RuntimeControlSnapshot } from '../../../src/contracts/v1/runtimeControls';
import { screenForInjection } from '../../../src/extraction/injectionBoundary';
import { CAPTURE_MIN_CALL_TIMEOUT_MS, LLMUnavailableError, type LLMProviderFunction } from '../../../src/extraction/llm/llmProvider';
import { localTimeSpecFor } from '../../../src/extraction/timeLexicon';
import { getAiConsent } from '../../consents/aiConsentService';
import { CHAT_TIMEOUT_MS, captureLlmProvider } from '../../llm/captureProvider';
import { CAPTURE_SERVER_BUDGET_MS, CaptureInputTooLargeError } from '../captureBoundary/captureBoundaryService';
import { chatEvidenceFrom, chatTimeAllowance, chatUserTurnsWithAcceptedOffers, looksLikeListEdit } from '../captureBoundary/chatEvidence';
import { isTimeOnlyText } from '../../../src/extraction/clauseSplitter';
import { clarifyMobileCapture, proposalCollisionCandidates, proposeMobileChatTurn, readMobileChatProposal } from '../mobile/mobileCaptureService';
import { dateFromOptionalIso, normalizeTimezone } from '../mobile/time';
import { buildChatPrompt, parseChatModelAnswer, type ChatPromptItem } from './chatPrompt';
import { conflictForPrompt, readPersonSchedule, scheduleForPrompt, withItemConflicts, withProposalClashes, type PersonSchedule } from './chatConflicts';
import { clashKey, withConflictsNamed } from './chatWhy';
import { detectChatLanguage, safeChatReply, templateReply, withShapeNoted, withWeeklyOffer, type ChatLanguage } from './chatReply';
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

/**
 * The failures worth one more call (see the model call below): the provider
 * failed without answering, and not for a reason another call would repeat.
 */
const CHAT_RETRY_REASONS: ReadonlySet<string> = new Set(['server_error', 'unavailable', 'provider_error']);

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
  /**
   * The phone's UI language, `'ar' | 'en' | 'he'` (owner request 2026-09-30):
   * the reply and every item's title are in it, whatever language the person
   * writes in. Anything else is ignored, and the reply follows their message.
   */
  locale?: unknown;
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

/**
 * The list as the model is shown it, and as the next message is matched
 * against it: titles in the person's own words — with the app-language title
 * the card shows beside them, when it differs (owner request 2026-09-30) —
 * and the person's own clock.
 */
function promptItems(
  proposal: CaptureChatProposal | null,
  timezone: string,
  sourceTitles: ReadonlyMap<string, string> = new Map(),
): ChatPromptItem[] {
  if (!proposal) return [];
  return proposal.items.map((item) => {
    const local = item.resolvedTime ? localTimeSpecFor(new Date(item.resolvedTime), timezone) : null;
    const source = sourceTitles.get(item.itemId);
    const clashes = (item.conflicts ?? []).flatMap((conflict) => {
      const entry = conflictForPrompt(conflict, timezone);
      return entry ? [entry] : [];
    });
    return {
      title: source ?? item.title,
      ...(source && source !== item.title ? { appTitle: item.title } : {}),
      date: local?.date ?? item.resolvedDate ?? null,
      time: local?.time ?? null,
      needsDayOrTime: Boolean(item.needsClarification),
      ...(clashes.length > 0 ? { clashesWith: clashes } : {}),
    };
  });
}

/**
 * The proposal with each timed item's clashes (`chatConflicts`), against the
 * person's schedule as read for this message. Owner request 2026-09-30.
 */
async function withConflicts(proposal: CaptureChatProposal | null, schedule: PersonSchedule): Promise<CaptureChatProposal | null> {
  if (!proposal) return null;
  const candidates = await proposalCollisionCandidates(proposal);
  return withProposalClashes(withItemConflicts(proposal, candidates, schedule), candidates);
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
  // The app's language, when the phone named it (owner request 2026-09-30):
  // the reply — the model's, checked against it, or a template — is in it
  // whatever the person typed. Without it, the language of their message.
  const appLanguage = captureAppLocaleFrom(input.locale);
  const language: ChatLanguage = appLanguage ?? detectChatLanguage(
    message,
    previousUserTurns.length > 0 ? detectChatLanguage(previousUserTurns[previousUserTurns.length - 1]!.text) : 'ar',
  );
  // What the person already has (owner request 2026-09-30): read once, for the
  // days the model is shown and for the clashes of every proposal answered.
  const schedule = await readPersonSchedule(uid, now);
  const read = conversation.proposalId ? await readMobileChatProposal(conversation.proposalId, uid) : null;
  const current = await withConflicts(read?.proposal ?? null, schedule);
  // Each item's title in the person's own words, where the card shows the
  // app's: what their next message is matched against (`chatEvidence`).
  const listed = promptItems(current, timezone, read?.sourceTitles);
  // The clashes the person was already shown, named by the reply that showed them.
  const alreadyShown = new Set((current?.items ?? []).flatMap((item) => (item.conflicts ?? []).map((conflict) => clashKey(item.title, conflict))));

  /**
   * The answer: the proposal with its clashes on each item, and the reply
   * naming any clash it did not name yet (`withConflictsNamed`) — except for
   * a refused message, which answers nothing about the list.
   */
  const finish = async (
    replyText: string,
    engine: 'model' | 'rules',
    answered: CaptureChatProposal | null,
    turns: CaptureChatTurn[],
    options: { refused?: boolean; conflictsKnown?: boolean } = {},
  ) => {
    const proposal = answered === current || options.conflictsKnown ? answered : await withConflicts(answered, schedule);
    const reply = options.refused || !proposal
      ? replyText
      : withWeeklyOffer(withConflictsNamed(replyText, proposal.items, { language, now, timezone, alreadyShown }), language, proposal, current);
    const kept = boundedTurns([...turns, { role: 'assistant', text: reply }]);
    const updatedAt = new Date(clock()).toISOString();
    await conversations.put(uid, { ...conversation, turns: kept, proposalId: proposal?.proposalId ?? null, updatedAt }, new Date(clock()));
    return { conversationId: conversation.conversationId, reply, engine, proposal, turns: kept };
  };

  // An injection is refused before any model sees it, and is not kept: left
  // in the conversation it would be evidence for every later turn.
  if (screenForInjection(message)) {
    return finish(templateReply({ language, proposal: current, refused: true }), 'rules', current, conversation.turns, { refused: true });
  }

  // The newest message is always kept whole: `boundedTurns` drops the oldest
  // turns until the person's words fit the capture cap, one assistant reply
  // short of the limit so the reply still fits after it.
  const turns = boundedTurns([...conversation.turns, { role: 'user', text: message }], MAX_CHAT_TURNS - 1);
  const userTurns = turns.filter((turn) => turn.role === 'user').map((turn) => turn.text);
  // The person's turns as their items' evidence: a plain "yes" to the one
  // time the assistant offered carries that offer (`chatEvidence`), so the
  // hour they accepted is theirs — and no other hour of the assistant's is.
  const evidenceTurns = chatUserTurnsWithAcceptedOffers(turns);

  // ── the model ───────────────────────────────────────────────────
  const runtime = resolveModuleRuntime('capture', dependencies.controls);
  const consent = await getAiConsent(uid);
  const provider = runtime.mode === 'rules_only' || consent !== 'granted'
    ? null
    : dependencies.llmProviderFor !== undefined
      ? dependencies.llmProviderFor(uid)
      : captureLlmProvider(uid, { purpose: 'capture_chat' });
  /** What the model call may take now: the rest of the capture budget, at most `CHAT_TIMEOUT_MS`. */
  const callBudget = () => Math.min(CHAT_TIMEOUT_MS, CAPTURE_SERVER_BUDGET_MS - (clock() - requestStartedAt) - CHAT_AFTER_MODEL_RESERVE_MS);

  let answer: ReturnType<typeof parseChatModelAnswer> = null;
  if (provider) {
    // The person's own days this conversation is about: today, every day
    // their words name, and the days of the list they see.
    const today = localTimeSpecFor(now, timezone)?.date;
    const days = [
      ...(today ? [today] : []),
      ...Array.from(chatTimeAllowance(evidenceTurns, now, timezone).namedDates),
      ...listed.flatMap((item) => (item.date ? [item.date] : [])),
    ];
    const prompt = buildChatPrompt(
      turns,
      listed,
      { now, timezone, ...(appLanguage ? { titleLanguage: appLanguage } : {}) },
      { replyLanguage: language, ...(appLanguage ? { appLanguage } : {}), savedSchedule: scheduleForPrompt(schedule, days, timezone) },
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeoutMs = callBudget();
      if (timeoutMs < CAPTURE_MIN_CALL_TIMEOUT_MS) break;
      try {
        answer = parseChatModelAnswer(await provider(prompt, { timeoutMs }));
        break;
      } catch (error) {
        // The cap, the kill switch, a timeout, a provider error: the reason is
        // on the call's own log line (`captureLlmProvider`), and the rules
        // answer below. One failure is asked once more, within what is left
        // of the budget (`callBudget`): a provider that failed without an
        // answer — the cold instance after a deploy (chat UAT round 3) —
        // and not a timeout (it would spend the budget twice), a rate
        // limit, a cap, or a request the provider refused. A failed call
        // produced nothing, so nothing is paid for twice.
        answer = null;
        if (attempt > 0 || !(error instanceof LLMUnavailableError) || !CHAT_RETRY_REASONS.has(error.reason)) break;
      }
    }
  }

  if (answer) {
    const changesList = answer.action === 'propose' || answer.action === 'update' || (answer.action === 'ask' && answer.items.length > 0);
    let proposal = current;
    if (changesList) {
      const evidence = chatEvidenceFrom(evidenceTurns);
      const built = await proposeMobileChatTurn(
        { text: message, userTurns: evidenceTurns, items: evidence ? answer.items : [], now, timezone, previous: listed, responseLocale: language, ...(appLanguage ? { locale: appLanguage } : {}) },
        { participantId: uid, requestStartedAt },
      );
      proposal = await withConflicts(shown(built), schedule);
    }
    const { reply } = safeChatReply(answer.reply, {
      language,
      proposal,
      cleared: Boolean(current) && !proposal,
      offTopic: answer.action === 'chat',
      updated: answer.action === 'update' && Boolean(current) && Boolean(proposal),
      timezone,
      // A reason only from the person's words or the list; a clash only when there is one (`chatWhy`).
      grounds: { userTurns: evidenceTurns, items: proposal?.items ?? [], now, timezone },
    });
    // The list the boundary proposes may not be the model's (`proposalShape`:
    // a goal off the timed list, a repeat gone, a day added): the reply says
    // the list the person sees, not the one the model wrote.
    const shaped = changesList
      ? withShapeNoted(reply, { language, modelItems: answer.items, proposal, previous: current, updated: answer.action === 'update' && Boolean(current) })
      : reply;
    return finish(shaped, 'model', proposal, turns, { conflictsKnown: true });
  }

  // ── the rules, on the person's turns joined ─────────────────────
  /*
   * A follow-up that answers or edits the list is not a new commitment (chat
   * UAT round 4: with the cap spent, "make the dentist 5pm" came back as a
   * third item, "make the dentist", today at 17:00, settled — one confirm
   * from a commitment nobody asked for). Without the model:
   *
   *   a bare day or hour, with one item asking   it is that item's answer,
   *                                              through the clarify path the
   *                                              card's own box uses;
   *   any other edit, or a bare time otherwise   the list stays as it is, and
   *                                              the person is told to change
   *                                              it on the card.
   */
  if (current && current.items.length > 0) {
    const timeOnly = isTimeOnlyText(message);
    const asking = current.items.filter((item) => item.needsClarification && item.clarification);
    if (timeOnly && asking.length === 1) {
      const item = asking[0]!;
      try {
        const answered = shown(await clarifyMobileCapture(
          { proposalId: current.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, freeText: message, timezone, referenceTime: now.toISOString() },
          { participantId: uid },
        ));
        if (answered) return finish(templateReply({ language, proposal: answered }), 'rules', answered, turns);
      } catch {
        // Not an answer the question takes (a «الصبح ولا المسا؟» takes only
        // its buttons), or not understood: the list stays, below.
      }
      return finish(templateReply({ language, proposal: current, editFailed: true }), 'rules', current, turns);
    }
    // By the words of either title: the person's own, and the card's.
    if (timeOnly || looksLikeListEdit(message, [...listed.map((item) => item.title), ...current.items.map((item) => item.title)])) {
      return finish(templateReply({ language, proposal: current, editFailed: true }), 'rules', current, turns);
    }
  }
  const built = await proposeMobileChatTurn(
    { text: userTurns.join('\n'), userTurns, items: null, now, timezone, responseLocale: language, ...(appLanguage ? { locale: appLanguage } : {}) },
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
