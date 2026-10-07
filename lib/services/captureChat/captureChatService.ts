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
 * replies) and the current list with opaque refs, and answers with locked/open
 * ref operations plus newly added items. Changed and new fields go through the
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
import { createHash, randomUUID } from 'crypto';
import { CAPTURE_INPUT_MAX_CHARACTERS, captureAppLocaleFrom, type CaptureProposalEditContract } from '../../../src/contracts/v1/captureContracts';
import type { CaptureProposalContract } from '../../../src/contracts/v1/captureContracts';
import { resolveModuleRuntime, type RuntimeControlSnapshot } from '../../../src/contracts/v1/runtimeControls';
import { screenForInjection } from '../../../src/extraction/injectionBoundary';
import { CAPTURE_MIN_CALL_TIMEOUT_MS, LLMUnavailableError, type LLMProviderFunction } from '../../../src/extraction/llm/llmProvider';
import { clockTimesIn } from '../../../src/extraction/ruleBasedExtractor';
import { bareHalfOfDayAnswer, dayPartHour, instantFromLocal, localTimeSpecFor, namesDay, nonNegatedHalfOfDay, withoutNegatedDayPart } from '../../../src/extraction/timeLexicon';
import { geminiChatSchemaFor } from '../../../src/extraction/ollamaExtractionSchema';
import { getAiConsent } from '../../consents/aiConsentService';
import { CHAT_TIMEOUT_MS, captureLlmProvider } from '../../llm/captureProvider';
import { CAPTURE_SERVER_BUDGET_MS, CaptureInputTooLargeError } from '../captureBoundary/captureBoundaryService';
import { applyStructuredEdit, StructuredEditConversationNotFoundError, StructuredEditError } from '../captureBoundary/structuredEdit';
import { chatEvidenceFrom, chatTimeAllowance, chatUserTurnsWithAcceptedOffers, isPlainYes, looksLikeListEdit } from '../captureBoundary/chatEvidence';
import { isTimeOnlyText } from '../../../src/extraction/clauseSplitter';
import { clarifyMobileCapture, proposalCollisionCandidates, proposeMobileChatTurn, readMobileChatProposal } from '../mobile/mobileCaptureService';
import { dateFromOptionalIso, normalizeTimezone } from '../mobile/time';
import { buildChatPrompt, oneUnambiguousClockIn, parseChatModelAnswer, validateChatCitations, type ChatModelAnswer, type ChatPromptItem } from './chatPrompt';
import { conflictForPrompt, readPersonSchedule, scheduleForPrompt, withItemConflicts, withProposalClashes, type PersonSchedule } from './chatConflicts';
import { clashKey, withConflictsNamed } from './chatWhy';
import { candidateIntervalOf, type CollisionCandidate } from '../timeCollision';
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
const EXPLICIT_PRIORITY = /\b(?:urgent|important|critical|must|have to|top priority|high priority|low priority)\b|(?:^|\s)(?:ضروري|مهم|عاجل|لازم)(?=\s|$)|(?:^|\s)(?:דחוף|חשוב|חייב|חייבת)(?=\s|$)/i;

function citedSpanStatesPriority(message: string, source: unknown): boolean {
  if (typeof source !== 'string') return EXPLICIT_PRIORITY.test(message);
  const folded = (text: string) => text.normalize('NFKC').toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0591-\u05C7\u0640]/g, '')
    .replace(/\s+/g, ' ').trim();
  return folded(message).includes(folded(source)) && EXPLICIT_PRIORITY.test(source);
}

function modelClockFrom(fields: Record<string, unknown>, timezone: string): { date: string | null; time: string | null } {
  const spec = fields.localTimeSpec && typeof fields.localTimeSpec === 'object' && !Array.isArray(fields.localTimeSpec)
    ? fields.localTimeSpec as Record<string, unknown>
    : null;
  const instant = [fields.remindAt, fields.dueAt]
    .find((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  const derived = instant ? localTimeSpecFor(new Date(instant), timezone) : null;
  return {
    date: typeof spec?.date === 'string' ? spec.date : derived?.date ?? null,
    time: typeof spec?.time === 'string' ? spec.time : derived?.time ?? null,
  };
}

function clockFallsInHalf(time: string, half: 'am' | 'pm' | 'night'): boolean {
  const match = /^(\d{2}):([0-5]\d)$/.exec(time);
  if (!match) return false;
  const hour = Number(match[1]);
  if (hour > 23) return false;
  if (half === 'am') return hour < 12;
  if (half === 'pm') return hour >= 12;
  return hour < 6 || hour >= 18;
}

/** The two complete forms that may answer an AM/PM card without guessing. */
function agreedAmPmAnswerClock(
  source: string,
  modelClock: { date: string | null; time: string | null },
  askedTime: string | null,
  now: Date,
  timezone: string,
): string | null {
  const half = bareHalfOfDayAnswer(source);
  if (half && askedTime) {
    const statedHour = Number(askedTime.slice(0, 2)) % 12;
    const hour = half === 'am' ? statedHour : statedHour + 12;
    return `${String(hour).padStart(2, '0')}:${askedTime.slice(3, 5)}`;
  }
  if (/ish\b/i.test(source)) return null;
  if (namesDay(source)) {
    const namedDates = chatTimeAllowance([source], now, timezone).namedDates;
    if (namedDates.size !== 1 || !modelClock.date || !namedDates.has(modelClock.date)) return null;
  }
  const stated = oneUnambiguousClockIn(source);
  return stated && modelClock.time === stated ? stated : null;
}

function visibleProposalState(proposal: CaptureChatProposal | null): unknown {
  return {
    items: (proposal?.items ?? []).map((item) => ({
      ...item,
      ...(item.clarification ? { clarification: { ...item.clarification, questionId: undefined } } : {}),
    })),
    seeds: proposal?.seeds ?? [],
    removedItems: proposal?.removedItems ?? [],
  };
}

export type CaptureChatErrorReason = 'message_required' | 'invalid_conversation_id' | 'conversation_not_found' | 'edit_invalid';

/** A request the chat refuses; the route answers with `status` and `reason`. */
export class CaptureChatError extends Error {
  constructor(readonly reason: CaptureChatErrorReason, readonly status: 400 | 404) {
    super(reason === 'conversation_not_found'
      ? 'conversation not found'
      : reason === 'invalid_conversation_id' ? 'conversationId is not a conversation id'
        : reason === 'edit_invalid' ? 'edit invalid' : 'message is required');
    this.name = 'CaptureChatError';
  }
}

export interface CaptureChatInput {
  conversationId?: unknown;
  message?: unknown;
  edit?: unknown;
  spoken?: unknown;
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

/** The edit lost its proposal revision; the route returns this answer verbatim in a 409. */
export class CaptureChatProposalChangedError extends Error {
  constructor(readonly answer: CaptureChatResponse, readonly state: 'open' | 'confirmed') {
    super('proposal changed');
    this.name = 'CaptureChatProposalChangedError';
  }
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
  const userLength = () => kept.filter((turn) => turn.role === 'user' && turn.evidence !== false).map((turn) => turn.text).join('\n').length;
  while (kept.length > limit) {
    const synthetic = kept.findIndex((turn) => turn.role === 'user' && turn.evidence === false);
    if (synthetic < 0) break;
    kept.splice(synthetic, kept[synthetic + 1]?.role === 'assistant' ? 2 : 1);
  }
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
  refs: Readonly<Record<string, string>> = {},
  lockedRefs: ReadonlySet<string> = new Set(),
): ChatPromptItem[] {
  if (!proposal) return [];
  const items = proposal.items.map((item): ChatPromptItem & { ref: string } => {
    const local = item.resolvedTime ? localTimeSpecFor(new Date(item.resolvedTime), timezone) : null;
    const source = sourceTitles.get(item.itemId);
    const clashes = (item.conflicts ?? []).flatMap((conflict) => {
      const entry = conflictForPrompt(conflict, timezone);
      return entry ? [entry] : [];
    });
    return {
      ref: refs[item.itemId] ?? '',
      locked: lockedRefs.has(refs[item.itemId] ?? ''),
      title: source ?? item.title,
      ...(source && source !== item.title ? { appTitle: item.title } : {}),
      date: local?.date ?? item.resolvedDate ?? null,
      time: local?.time ?? null,
      needsDayOrTime: Boolean(item.needsClarification),
      ...(clashes.length > 0 ? { clashesWith: clashes } : {}),
    };
  });
  const seeds = proposal.seeds.map((seed): ChatPromptItem & { ref: string } => ({
    ref: refs[seed.seedItemId] ?? '',
    locked: lockedRefs.has(refs[seed.seedItemId] ?? ''),
    title: seed.summary,
    date: null,
    time: null,
    needsDayOrTime: false,
    kind: seed.kind,
  }));
  const byId = new Map([
    ...items.map((entry, index) => [proposal.items[index]!.itemId, entry] as const),
    ...seeds.map((entry, index) => [proposal.seeds[index]!.seedItemId, entry] as const),
  ]);
  const ordered = proposal.understood?.flatMap((point) => {
    const id = point.kind === 'commitment' ? point.itemId : point.seedItemId;
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
  const complete = ordered?.length === items.length + seeds.length ? ordered : [...items, ...seeds];
  return complete;
}

/**
 * The proposal with each timed item's clashes (`chatConflicts`), against the
 * person's schedule as read for this message. Owner request 2026-09-30.
 */
/**
 * Where each item's clashes were measured from, kept with the proposal object
 * `withConflicts` returned: one read of the drafts serves both the clashes and
 * the clash the reply names (Codex inspection F4C-001).
 */
const collisionStartsByProposal = new WeakMap<CaptureChatProposal, ReadonlyMap<string, string>>();

/** Each item's collision start: the candidate's own start (`candidateIntervalOf`), never the card's reminder. */
export function collisionStartsFrom(candidates: ReadonlyMap<string, CollisionCandidate>): Map<string, string> {
  return new Map(Array.from(candidates, ([itemId, candidate]) => [itemId, candidateIntervalOf(candidate).startsAt] as const));
}

async function withConflicts(proposal: CaptureChatProposal | null, schedule: PersonSchedule): Promise<CaptureChatProposal | null> {
  if (!proposal) return null;
  const candidates = await proposalCollisionCandidates(proposal);
  const conflicted = withProposalClashes(withItemConflicts(proposal, candidates, schedule), candidates);
  collisionStartsByProposal.set(conflicted, collisionStartsFrom(candidates));
  return conflicted;
}

/**
 * The proposal's items with where each one's clashes were measured from
 * (load pass F4, Codex inspection F4-003): the draft's due time, the same
 * start `withItemConflicts` used, so the reply names the clash that begins
 * with the item even when a reminder comes before it.
 */
function withCollisionStarts(proposal: CaptureChatProposal): Array<CaptureChatProposal['items'][number] & { collisionStart: string | null }> {
  // No second read: a proposal that did not come through `withConflicts` has
  // no starts, and the reply then names the first clash, as before F4.
  const starts = collisionStartsByProposal.get(proposal);
  return proposal.items.map((item) => ({ ...item, collisionStart: starts?.get(item.itemId) ?? null }));
}

/**
 * A proposal worth showing as cards: one with items or «maybe» seeds (#519),
 * that is not a refusal. A seed-only capture is `unresolved_intent`, not
 * nothing: only the person can say whether it is worth keeping.
 */
function shown(proposal: CaptureChatProposal): CaptureChatProposal | null {
  return proposal.status !== 'rejected'
    && (proposal.items.length > 0 || proposal.seeds.length > 0 || (proposal.removedItems?.length ?? 0) > 0)
    ? proposal
    : null;
}

export async function chatMobileCapture(
  input: CaptureChatInput,
  context: { participantId: string; requestStartedAt?: number },
  dependencies: CaptureChatDependencies = testDependencies ?? {},
): Promise<CaptureChatResponse> {
  const clock = dependencies.clock ?? Date.now;
  const requestStartedAt = context.requestStartedAt ?? clock();
  const uid = context.participantId;

  const hasMessage = Object.prototype.hasOwnProperty.call(input, 'message');
  const hasEdit = Object.prototype.hasOwnProperty.call(input, 'edit');
  if (hasMessage && hasEdit) throw new CaptureChatError('message_required', 400);
  if (hasEdit && Object.prototype.hasOwnProperty.call(input, 'spoken')) throw new CaptureChatError('edit_invalid', 400);
  if (!hasMessage && !hasEdit) throw new CaptureChatError('message_required', 400);

  const conversations = dependencies.conversations ?? defaultConversations;

  if (hasEdit) {
    if (!isConversationId(input.conversationId)) {
      if (input.conversationId === undefined || input.conversationId === null) throw new CaptureChatError('edit_invalid', 400);
      throw new CaptureChatError('invalid_conversation_id', 400);
    }
    const conversation = await conversations.get(uid, input.conversationId);
    if (!conversation || conversationExpired(conversation, clock())) throw new CaptureChatError('conversation_not_found', 404);
    if (!input.edit || typeof input.edit !== 'object' || Array.isArray(input.edit)) throw new CaptureChatError('edit_invalid', 400);
    const now = dateFromOptionalIso(input.referenceTime, new Date(clock()), 'referenceTime');
    const locale = captureAppLocaleFrom(input.locale) ?? 'ar';
    const current = conversation.proposalId ? await readMobileChatProposal(conversation.proposalId, uid, { includeConfirmed: true }) : null;
    if (!current) throw new CaptureChatError('conversation_not_found', 404);
    try {
      const outcome = await applyStructuredEdit({
        uid,
        conversation,
        edit: input.edit as CaptureProposalEditContract,
        locale,
        now,
        engine: current.proposal.provenance.requestedEngine === 'model' ? 'model' : 'rules',
      });
      if (outcome.kind === 'changed') {
        const currentTurns = outcome.turns ?? conversation.turns;
        const answer: CaptureChatResponse = {
          conversationId: conversation.conversationId,
          reply: currentTurns.at(-1)?.role === 'assistant' ? currentTurns.at(-1)!.text : '',
          engine: outcome.proposal.provenance.requestedEngine === 'model' ? 'model' : 'rules',
          proposal: outcome.proposal,
          turns: currentTurns,
        };
        throw new CaptureChatProposalChangedError(answer, outcome.confirmed ? 'confirmed' : 'open');
      }
      const answer = outcome.answer as CaptureChatResponse;
      if (answer.proposal) {
        const schedule = await readPersonSchedule(uid, now);
        answer.proposal = await withConflicts(answer.proposal, schedule);
      }
      return answer;
    } catch (error) {
      if (error instanceof StructuredEditConversationNotFoundError) throw new CaptureChatError('conversation_not_found', 404);
      if (error instanceof StructuredEditError) throw new CaptureChatError('edit_invalid', 400);
      throw error;
    }
  }

  // The message is bounded before anything reads it, exactly as a capture's
  // text is (#508): the length is checked first, and refused, never cut.
  if (typeof input.message !== 'string' || !input.message.trim()) throw new CaptureChatError('message_required', 400);
  if (input.message.length > CAPTURE_INPUT_MAX_CHARACTERS) throw new CaptureInputTooLargeError();
  const message = input.message.trim();
  const timezone = normalizeTimezone(input.timezone);
  const now = dateFromOptionalIso(input.referenceTime, new Date(clock()), 'referenceTime');
  const messageFingerprint = createHash('sha256').update(JSON.stringify({
    message,
    spoken: input.spoken === true,
    locale: captureAppLocaleFrom(input.locale) ?? null,
  })).digest('hex');

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

  // A card answer, seed keep, or confirm can mutate the proposal without
  // changing the conversation document. A transport retry still replays the
  // stored words and never calls the model twice; when the proposal moved,
  // overlay its live value so the answer cannot put an old card back on screen.
  const read = conversation.proposalId ? await readMobileChatProposal(conversation.proposalId, uid) : null;
  const currentLockedRefs = read ? Array.from(read.lockedRefs).sort() : [];
  const receiptAge = conversation.messageReceipt ? clock() - conversation.messageReceipt.receivedAt : Number.POSITIVE_INFINITY;
  const receiptMatchesProposal = conversation.messageReceipt !== undefined
    && conversation.messageReceipt.proposalId === (read?.proposal.proposalId ?? null)
    && conversation.messageReceipt.proposalRevision === (read?.proposal.revision ?? null)
    && JSON.stringify(conversation.messageReceipt.lockedRefs) === JSON.stringify(currentLockedRefs);
  if (conversation.messageReceipt?.fingerprint === messageFingerprint
    && receiptAge >= 0 && receiptAge <= 120_000) {
    const replay = conversation.messageReceipt.answer as CaptureChatResponse;
    if (receiptMatchesProposal) return replay;
    const previousEvidenceTurns = conversation.turns.filter((turn) => turn.role === 'user' && turn.evidence !== false);
    const replayLanguage = captureAppLocaleFrom(input.locale) ?? detectChatLanguage(
      message,
      previousEvidenceTurns.length > 0 ? detectChatLanguage(previousEvidenceTurns.at(-1)!.text) : 'ar',
    );
    const liveProposal = read?.proposal ?? null;
    const receiptProposal = !liveProposal && conversation.messageReceipt.proposalId
      ? await readMobileChatProposal(conversation.messageReceipt.proposalId, uid, { includeConfirmed: true })
      : null;
    return {
      ...replay,
      reply: templateReply({
        language: replayLanguage,
        proposal: liveProposal,
        alreadySaved: receiptProposal?.confirmed === true,
      }),
      proposal: liveProposal,
    };
  }

  const evidenceConversationTurns = conversation.turns.filter((turn) => turn.evidence !== false);
  const previousUserTurns = evidenceConversationTurns.filter((turn) => turn.role === 'user');
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
  const current = await withConflicts(read?.proposal ?? null, schedule);
  // Each item's title in the person's own words, where the card shows the
  // app's: what their next message is matched against (`chatEvidence`).
  const listed = promptItems(current, timezone, read?.sourceTitles, read?.refs, read?.lockedRefs);
  const listTitles = [...listed.map((item) => item.title), ...(current?.items.map((item) => item.title) ?? [])];
  const editsCurrentList = Boolean(current) && looksLikeListEdit(message, listTitles);
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
    options: { refused?: boolean; conflictsKnown?: boolean; weeklyEvidence?: string } = {},
  ) => {
    const proposal = answered === current || options.conflictsKnown ? answered : await withConflicts(answered, schedule);
    const reply = options.refused || !proposal
      ? replyText
      : withWeeklyOffer(
        withConflictsNamed(replyText, withCollisionStarts(proposal), { language, now, timezone, alreadyShown }),
        language,
        proposal,
        current,
        options.weeklyEvidence,
      );
    const kept = boundedTurns([...turns, { role: 'assistant', text: reply }]);
    const updatedAt = new Date(clock()).toISOString();
    const answer = { conversationId: conversation.conversationId, reply, engine, proposal, turns: kept };
    const receiptProposal = proposal ? await readMobileChatProposal(proposal.proposalId, uid) : null;
    await conversations.put(uid, {
      ...conversation,
      turns: kept,
      proposalId: proposal?.proposalId ?? null,
      updatedAt,
      messageReceipt: {
        fingerprint: messageFingerprint,
        receivedAt: clock(),
        answer,
        proposalId: receiptProposal?.proposal.proposalId ?? null,
        proposalRevision: receiptProposal?.proposal.revision ?? null,
        lockedRefs: receiptProposal ? Array.from(receiptProposal.lockedRefs).sort() : [],
      },
    }, new Date(clock()));
    return answer;
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
  const evidenceOnlyTurns = turns.filter((turn) => turn.evidence !== false);
  const userTurns = evidenceOnlyTurns.filter((turn) => turn.role === 'user').map((turn) => turn.text);
  // The person's turns as their items' evidence: a plain "yes" to the one
  // time the assistant offered carries that offer (`chatEvidence`), so the
  // hour they accepted is theirs — and no other hour of the assistant's is.
  const evidenceTurns = chatUserTurnsWithAcceptedOffers(evidenceOnlyTurns);

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
  let modelAnswered = false;
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
      evidenceOnlyTurns,
      listed,
      { now, timezone, ...(appLanguage ? { titleLanguage: appLanguage } : {}) },
      { replyLanguage: language, ...(appLanguage ? { appLanguage } : {}), savedSchedule: scheduleForPrompt(schedule, days, timezone) },
    );
    const lockedRefs = new Set(listed.filter((item) => item.locked).map((item) => item.ref));
    const openRefs = new Set(listed.filter((item) => !item.locked).map((item) => item.ref));
    const responseSchema = geminiChatSchemaFor(Array.from(lockedRefs), Array.from(openRefs));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeoutMs = callBudget();
      if (timeoutMs < CAPTURE_MIN_CALL_TIMEOUT_MS) break;
      try {
        const rawAnswer = await provider(prompt, { timeoutMs, responseSchema });
        modelAnswered = true;
        answer = parseChatModelAnswer(rawAnswer, { lockedRefs, openRefs });
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

  if (modelAnswered && !answer) {
    return finish(templateReply({ language, proposal: current }), 'model', current, turns);
  }

  if (answer) {
    if ((answer.ignoredRefOperations ?? 0) > 0) {
      console.info('[capture/chat] ignored ref operations', { count: answer.ignoredRefOperations });
    }
    const samePoint = (operation: (typeof answer.open)[number]): boolean => {
      if (operation.op !== 'update' || !operation.fields || typeof operation.fields !== 'object') return false;
      const before = listed.find((item) => item.ref === operation.ref);
      if (!before) return false;
      const fields = operation.fields as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(fields, 'corrections')) return false;
      const clock = modelClockFrom(fields, timezone);
      const title = typeof fields.title === 'string' ? fields.title : typeof fields.action === 'string' ? fields.action : '';
      const appTitle = typeof fields.appTitle === 'string' ? fields.appTitle : undefined;
      const kind = typeof fields.kind === 'string' ? fields.kind : undefined;
      const entityId = read ? Object.entries(read.refs).find(([, ref]) => ref === operation.ref)?.[0] : undefined;
      const stored = entityId ? read?.resultsByItemId.get(entityId) : undefined;
      const sameStoredField = (key: 'priority' | 'rangeMinutes' | 'recurrenceHint' | 'allDay'): boolean =>
        !Object.prototype.hasOwnProperty.call(fields, key)
        || JSON.stringify(fields[key]) === JSON.stringify(stored?.[key])
        || (key === 'priority' && !citedSpanStatesPriority(message, operation.source));
      return title.trim() === before.title
        && (appTitle === undefined || appTitle === before.appTitle)
        && (kind === undefined ? before.kind === undefined : kind === before.kind)
        && clock.date === before.date
        && clock.time === before.time
        && sameStoredField('priority')
        && sameStoredField('rangeMinutes')
        && sameStoredField('recurrenceHint')
        && sameStoredField('allDay');
    };
    const amPmAskedRefs = new Set(listed.filter((item) => {
      const entityId = read ? Object.entries(read.refs).find(([, ref]) => ref === item.ref)?.[0] : undefined;
      return entityId && current?.items.find((entry) => entry.itemId === entityId)?.clarification?.questionKey === 'ask_am_pm';
    }).map((item) => item.ref));
    const noOpRefs = new Set(answer.open.filter((operation) => !amPmAskedRefs.has(operation.ref) && samePoint(operation)).map((operation) => operation.ref));
    const open = answer.open.map((operation) => noOpRefs.has(operation.ref)
      ? { ref: operation.ref, op: 'keep' as const }
      : operation);
    const cited = current ? validateChatCitations({ ...answer, open }, message, { now, timezone, amPmAskedRefs }) : null;
    if (current && !cited) {
      return finish(templateReply({ language, proposal: current, editFailed: true }), 'model', current, turns, { conflictsKnown: true });
    }
    if (current && cited?.timeDisagrees) {
      return finish(templateReply({ language, proposal: current, timeUnclear: true }), 'model', current, turns, { conflictsKnown: true });
    }
    const trustedClockByRef = new Map<string, string>();
    let citedUpdateIndex = 0;
    for (const operation of open) {
      if (operation.op !== 'update') continue;
      const source = cited?.deltaSources[citedUpdateIndex++] ?? message;
      if (!operation.fields || typeof operation.fields !== 'object' || Array.isArray(operation.fields)) continue;
      const modelClock = modelClockFrom(operation.fields as Record<string, unknown>, timezone);
      const modelTime = modelClock.time;
      if (!amPmAskedRefs.has(operation.ref)) {
        if (modelTime && clockTimesIn(source).length === 0 && dayPartHour(source, { answer: true }) !== null) {
          const half = nonNegatedHalfOfDay(source);
          if (!half || !clockFallsInHalf(modelTime, half)) {
            return finish(templateReply({ language, proposal: current, timeUnclear: true }), 'model', current, turns, { conflictsKnown: true });
          }
          trustedClockByRef.set(operation.ref, modelTime);
        }
        continue;
      }
      const entityId = read ? Object.entries(read.refs).find(([, ref]) => ref === operation.ref)?.[0] : undefined;
      const stored = entityId ? read?.resultsByItemId.get(entityId) : undefined;
      const answered = agreedAmPmAnswerClock(source, modelClock, stored?.localTimeSpec?.time ?? null, now, timezone);
      if (!answered) {
        return finish(templateReply({ language, proposal: current, timeUnclear: true }), 'model', current, turns, { conflictsKnown: true });
      }
      trustedClockByRef.set(operation.ref, answered);
    }
    let updateSourceIndex = 0;
    const resolvedOpen = open.map((operation) => {
      if (operation.op !== 'update' || !operation.fields || typeof operation.fields !== 'object' || Array.isArray(operation.fields)) return operation;
      const source = cited?.deltaSources[updateSourceIndex++] ?? message;
      const entityId = read ? Object.entries(read.refs).find(([, ref]) => ref === operation.ref)?.[0] : undefined;
      const card = entityId ? current?.items.find((item) => item.itemId === entityId) : undefined;
      const stored = entityId ? read?.resultsByItemId.get(entityId) : undefined;
      const half = card?.clarification?.questionKey === 'ask_am_pm' ? bareHalfOfDayAnswer(source) : null;
      const askedTime = stored?.localTimeSpec?.time;
      if (!half || !askedTime) return operation;
      const fields = operation.fields as Record<string, unknown>;
      const date = stored?.localTimeSpec?.date;
      if (!date) return operation;
      const time = trustedClockByRef.get(operation.ref);
      if (!time) return operation;
      const instant = instantFromLocal(date, time, timezone)?.toISOString();
      if (!instant) return operation;
      return {
        ...operation,
        fields: {
          ...fields,
          dueAt: fields.dueAt === null && !stored.dueAt ? null : instant,
          remindAt: fields.remindAt === null && !stored.remindAt ? null : instant,
          localTimeSpec: { date, time, timezone },
          missingFields: Array.isArray(fields.missingFields) ? fields.missingFields.filter((field) => field !== 'time') : [],
          ambiguityFlags: Array.isArray(fields.ambiguityFlags) ? fields.ambiguityFlags.filter((flag) => flag !== 'vague_time') : [],
        },
      };
    });
    const modelUpdates = resolvedOpen.filter((operation) => operation.op === 'update');
    const answeredAmPmClocks = modelUpdates.map((operation) => trustedClockByRef.get(operation.ref) ?? null);
    const addedItems = cited?.added ?? answer.added.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const { source: _source, ...fields } = entry as Record<string, unknown>;
      return fields;
    });
    const deltaItems = [
      ...modelUpdates.map((operation) => operation.fields),
      ...addedItems,
    ];
    const changesList = answer.locked.some((operation) => operation.op === 'remove')
      || open.some((operation) => operation.op === 'remove' || operation.op === 'update')
      || addedItems.length > 0;
    let proposal = current;
    if (changesList) {
      const evidence = chatEvidenceFrom(evidenceTurns);
      const built = await proposeMobileChatTurn(
        {
          text: message,
          userTurns: evidenceTurns,
          // Updates are ref-targeted and retain the prior card as their
          // baseline. Added entries have no prior identity: only this newest
          // turn may supply their title, kind, day or time.
          evidenceStartIndices: [
            ...modelUpdates.map(() => 0),
            ...addedItems.map(() => Math.max(0, evidenceTurns.length - 1)),
          ],
          changedFieldEvidenceStartIndices: deltaItems.map(() => Math.max(0, evidenceTurns.length - 1)),
          ...(cited ? {
            operationSources: isPlainYes(message) && evidenceTurns.at(-1)?.startsWith(`${message}\n`)
              ? cited.deltaSources.map(() => evidenceTurns.at(-1)!)
              : cited.deltaSources.map((source, index) => index < modelUpdates.length
                && amPmAskedRefs.has(modelUpdates[index]!.ref) ? withoutNegatedDayPart(source) : source),
            ...(answeredAmPmClocks.some(Boolean) ? { answeredAmPmClocks } : {}),
          } : {}),
          items: evidence ? deltaItems : [],
          now,
          timezone,
          previous: listed.map((item) => {
            const entityId = read
              ? Object.entries(read.refs).find(([, ref]) => ref === item.ref)?.[0]
              : undefined;
            const result = entityId ? read?.resultsByItemId.get(entityId) : undefined;
            return result ? { ...item, result } : item;
          }),
          previousMatchIndices: [
            ...modelUpdates.map((operation) => listed.findIndex((item) => item.ref === operation.ref)),
            ...addedItems.map(() => null),
          ],
          // The update entries above are in ref order, not title order. Added
          // entries deliberately have no previous match.
          ...(current ? { baseProposalId: current.proposalId } : {}),
          refPlan: {
            locked: answer.locked,
            open: resolvedOpen,
            delta: [
              ...modelUpdates.map((operation) => ({
                kind: noOpRefs.has(operation.ref) ? 'keep' as const : 'update' as const,
                ref: operation.ref,
              })),
              ...addedItems.map(() => ({ kind: 'added' as const })),
            ],
          },
          responseLocale: language,
          spoken: input.spoken === true,
          ...(appLanguage ? { locale: appLanguage } : {}),
        },
        { participantId: uid, requestStartedAt },
      );
      proposal = await withConflicts(shown(built), schedule);
    }
    const listChanged = JSON.stringify(visibleProposalState(current)) !== JSON.stringify(visibleProposalState(proposal));
    const after = proposal ? await readMobileChatProposal(proposal.proposalId, uid) : null;
    const modelClock = (fields: Record<string, unknown>): { date: string | null; time: string | null } =>
      modelClockFrom(fields, timezone);
    const updateSourceByRef = new Map(modelUpdates.map((operation, index) => [
      operation.ref,
      cited?.deltaSources[index] ?? message,
    ]));
    const partlyAppliedUpdate = (operation: (typeof answer.open)[number]): boolean => {
      if (operation.op !== 'update' || noOpRefs.has(operation.ref)
        || !operation.fields || typeof operation.fields !== 'object' || Array.isArray(operation.fields)) return false;
      const entityId = read ? Object.entries(read.refs).find(([, ref]) => ref === operation.ref)?.[0] : undefined;
      if (!entityId || !after) return true;
      const beforePrompt = listed.find((item) => item.ref === operation.ref);
      const beforeResult = read?.resultsByItemId.get(entityId);
      const actualResult = after.resultsByItemId.get(entityId);
      const actualItem = proposal?.items.find((item) => item.itemId === entityId);
      const actualSeed = proposal?.seeds.find((seed) => seed.seedItemId === entityId);
      if (!actualItem && !actualSeed) return true;
      const fields = operation.fields as Record<string, unknown>;
      const desiredClock = modelClock(fields);
      const actualClock = actualResult ? modelClock(actualResult as unknown as Record<string, unknown>) : {
        date: actualItem?.resolvedDate ?? null,
        time: actualItem?.resolvedTime ? localTimeSpecFor(new Date(actualItem.resolvedTime), timezone)?.time ?? null : null,
      };
      const desiredTitle = typeof fields.title === 'string' ? fields.title : typeof fields.action === 'string' ? fields.action : '';
      const beforeTitle = beforeResult?.title ?? beforePrompt?.title ?? '';
      const actualTitle = actualResult?.title ?? actualItem?.title ?? actualSeed?.summary ?? '';
      if (desiredTitle && desiredTitle !== beforeTitle && actualTitle !== desiredTitle) return true;
      const desiredKind = typeof fields.kind === 'string' ? fields.kind : 'commitment';
      const beforeKind = beforePrompt?.kind ?? 'commitment';
      const actualKind = actualSeed?.kind ?? 'commitment';
      if (desiredKind !== beforeKind && actualKind !== desiredKind) return true;
      const beforeClock = beforeResult ? modelClock(beforeResult as unknown as Record<string, unknown>) : {
        date: beforePrompt?.date ?? null,
        time: beforePrompt?.time ?? null,
      };
      if (desiredClock.date !== beforeClock.date && actualClock.date !== desiredClock.date) return true;
      if (desiredClock.time !== beforeClock.time && actualClock.time !== desiredClock.time) return true;
      for (const key of ['priority', 'rangeMinutes', 'recurrenceHint', 'allDay'] as const) {
        if (key === 'priority' && !EXPLICIT_PRIORITY.test(updateSourceByRef.get(operation.ref) ?? '')) continue;
        if (JSON.stringify(fields[key]) !== JSON.stringify(beforeResult?.[key])
          && JSON.stringify(actualResult?.[key]) !== JSON.stringify(fields[key])) return true;
      }
      return false;
    };
    const priorIds = new Set([
      ...(current?.items.map((item) => item.itemId) ?? []),
      ...(current?.seeds.map((seed) => seed.seedItemId) ?? []),
    ]);
    const newItems = proposal?.items.filter((item) => !priorIds.has(item.itemId)) ?? [];
    const newSeeds = proposal?.seeds.filter((seed) => !priorIds.has(seed.seedItemId)) ?? [];
    const partlyAppliedAdd = (entry: unknown): boolean => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
      const fields = entry as Record<string, unknown>;
      const titles = [fields.appTitle, fields.title, fields.action]
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
      const kind = typeof fields.kind === 'string' ? fields.kind : 'commitment';
      const itemCandidates = newItems.filter((item) => titles.includes(item.title));
      const seedCandidates = newSeeds.filter((seed) => titles.some((title) => seed.summary === title || seed.summary.includes(title)));
      if (kind === 'commitment' ? itemCandidates.length === 0 : seedCandidates.length === 0) return true;
      if (kind !== 'commitment') return seedCandidates.some((seed) => seed.kind !== kind);
      const desired = modelClock(fields);
      const source = typeof fields.source === 'string' ? fields.source : '';
      const recurring = /\bevery\b|(?:كل|أيام|ايام)|(?:כל|בכל)/i.test(source);
      return itemCandidates.some((item) => {
        const local = item.resolvedTime ? localTimeSpecFor(new Date(item.resolvedTime), timezone) : null;
        if (desired.time !== (local?.time ?? null)) return true;
        return !recurring && desired.date !== (item.resolvedDate ?? local?.date ?? null);
      });
    };
    const partlyApplied = resolvedOpen.some(partlyAppliedUpdate) || answer.added.some(partlyAppliedAdd);
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
    const attemptedListChange = changesList || noOpRefs.size > 0
      || (answer.action === 'update' && (answer.ignoredRefOperations ?? 0) > 0);
    const changedOperations = resolvedOpen.filter((operation) => operation.op !== 'keep').length + addedItems.length
      + answer.locked.filter((operation) => operation.op === 'remove').length;
    const claimsSeveral = typeof answer.reply === 'string'
      && /\bboth\b|\b(?:the )?(?:two|three)\b|(?:التنين|الاثنين|الاتنين|كلاهما|שניהם)/i.test(answer.reply);
    const needsTruthTemplate = Boolean(current) && (
      partlyApplied || noOpRefs.size > 0 || (answer.ignoredRefOperations ?? 0) > 0
      || (claimsSeveral && changedOperations < 2)
    );
    const truthfulReply = attemptedListChange && (!listChanged || needsTruthTemplate)
      ? templateReply({
        language,
        proposal: listChanged ? proposal : current,
        updated: listChanged,
        editFailed: !listChanged,
      })
      : reply;
    // The list the boundary proposes may not be the model's (`proposalShape`:
    // a goal off the timed list, a repeat gone, a day added): the reply says
    // the list the person sees, not the one the model wrote.
    const shaped = changesList
      ? withShapeNoted(truthfulReply, { language, modelItems: deltaItems, proposal, previous: current, updated: answer.action === 'update' && Boolean(current) && listChanged })
      : truthfulReply;
    return finish(shaped, 'model', proposal, turns, {
      conflictsKnown: true,
      ...(typeof answer.reply === 'string' ? { weeklyEvidence: answer.reply } : {}),
    });
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
        const dayPart = item.clarification!.field === 'time_period' ? dayPartHour(message, { answer: true }) : null;
        const clarificationAnswer = dayPart === null
          ? { freeText: message }
          : { optionId: dayPart < 12 ? 'am' : 'pm' };
        const answered = shown(await clarifyMobileCapture(
          {
            proposalId: current.proposalId,
            itemId: item.itemId,
            questionId: item.clarification!.questionId,
            ...clarificationAnswer,
            revision: current.revision,
            timezone,
            referenceTime: now.toISOString(),
          },
          { participantId: uid },
        ));
        if (answered) return finish(templateReply({ language, proposal: answered }), 'rules', answered, turns);
      } catch {
        // Not an answer the question takes (a «الصبح ولا المسا؟» takes only
        // its buttons), or not understood: the list stays, below.
      }
      return finish(templateReply({ language, proposal: current, editFailed: true }), 'rules', current, turns);
    }
    if (timeOnly || editsCurrentList) {
      return finish(templateReply({ language, proposal: current, editFailed: true }), 'rules', current, turns);
    }
  }
  const built = await proposeMobileChatTurn(
    {
      text: message,
      userTurns: [message],
      items: null,
      now,
      timezone,
      ...(current ? { baseProposalId: current.proposalId } : {}),
      responseLocale: language,
      spoken: false,
      ...(appLanguage ? { locale: appLanguage } : {}),
    },
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
