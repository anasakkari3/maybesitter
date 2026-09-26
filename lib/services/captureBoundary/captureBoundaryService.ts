import { createHash, randomUUID } from 'crypto';
import { extractWithFallback, type ExtractAndMapOptions } from '../../../src/extraction/extractionService';
import { decideExtractionDisposition } from '../../../src/extraction/extractionPolicy';
import { mapExtractionToCommand } from '../../../src/extraction/mapExtractionToCommand';
import { countTimeExpressions } from '../../../src/extraction/ruleBasedExtractor';
import { classifyMessageKind } from '../../../src/extraction/messageKind';
import { localTimeSpecFor } from '../../../src/extraction/timeLexicon';
import type { ExtractionContext, ExtractionResult } from '../../../src/extraction/extractionTypes';
import { resolveModuleRuntime, type AuditEventEnvelope, createAuditEvent, type RuntimeControlSnapshot } from '../../../src/contracts/v1/runtimeControls';
import {
  CAPTURE_CONTRACT_VERSION,
  CAPTURE_INPUT_MAX_CHARACTERS,
  CAPTURE_PROPOSAL_TTL_MS,
  type CaptureConfirmationResultContract,
  type CaptureItemEditContract,
  type CaptureProposalContract,
  type NoCommitmentReason,
} from '../../../src/contracts/v1/captureContracts';
import { detectUnresolvedIntent } from '../../../src/extraction/unresolvedIntent';
import type { CaptureSeedProposalContract } from '../../../src/contracts/v1/intentContracts';
import { applyEditToCommands, InvalidEditError, validateEdit } from './applyEdits';
import { buildClarification } from './clarificationBuilder';
import { isPastCommitmentTime } from '../commitments/timeRules';
import { NegatedRequestError, PastCommitmentTimeError } from '../mobile/safety';
import { readCategoryPreferences } from '../categories/categoryPreferences';
import type { Command } from '../../../src/domain/stateMachine';
import type { CapturePersistenceAdapter } from './persistenceAdapter';
import type { CaptureProposalStore, StoredCaptureProposal } from './proposalStore';
import { storageFailureCause } from '../../storage/storageAdapter';

/**
 * Persists a confirmation's commands and records its result on the proposal in
 * one transaction (UC-1.4, #148).
 *
 * Without it, confirming is read-then-write across two calls: two confirms of
 * the same proposal arriving together both see "not confirmed", both persist,
 * and one tap becomes two sets of commitments. The committer closes that by
 * making the claim part of the same write.
 *
 * Optional only for callers with no participant-scoped storage — the in-process
 * development path. Every authenticated request supplies one.
 */
export type CaptureConfirmationCommitter = (input: {
  scopeId: string;
  proposalId: string;
  idempotencyKey: string;
  commands: readonly Command[];
  /**
   * The commands this confirm committed, per item — what the proposal must
   * hold afterwards so the commitment can still be found (#480). Written in
   * the same transaction as the result, because a confirm that recorded one
   * without the other is the split this exists to prevent.
   */
  commandsByItemId: ReadonlyMap<string, readonly Command[]>;
  result: CaptureConfirmationResultContract;
}) => Promise<{ replayed: boolean; result: CaptureConfirmationResultContract }>;

export interface CaptureBoundaryDependencies {
  store: CaptureProposalStore;
  persistence: CapturePersistenceAdapter;
  commitConfirmation?: CaptureConfirmationCommitter;
  audit?: (event: AuditEventEnvelope) => void;
  controls?: RuntimeControlSnapshot;
  llmProvider?: ExtractAndMapOptions['llmProvider'];
  /** Which engine `llmProvider` is, so provenance names it (UC-2.0, #160). */
  llmEngine?: ExtractAndMapOptions['llmEngine'];
  extractor?: typeof extractWithFallback;
}

export interface ProposeCaptureOptions {
  now: Date;
  timezone: string;
  scopeId: string;
  requestedEngine?: 'model' | 'rules';
}

const INJECTION = /(?:ignore|disregard|override).{0,40}(?:instruction|system|policy)|(?:system|developer)\s*:/i;

/**
 * How many segments of one capture may reach the model.
 *
 * Eight. Beyond that the marginal segment is almost always a list item the rule
 * based extractor reads just as well, and the cost is per call — still under
 * the per-user daily call cap (`usageGuard.ts`), which is what bounds spend.
 *
 * It was five, and the first phone run's capture named six commitments once
 * its sentences were split (CL1): the sixth went to the rules, which titled it
 * «أخلص تقرير الشغل قبل», and relabelled the whole proposal `rule-based` with
 * `fallbackUsed` — a spoken day's list is routinely six.
 */
const MAX_MODEL_SEGMENTS = 8;

/** Refuses at once, so the extraction service answers with the rules. */
const RULES_ONLY_PROVIDER = async (): Promise<string> => { throw new Error('rules-only runtime'); };

/**
 * The capture is longer than the server will read (#508).
 *
 * Refused, never truncated. Truncating would drop the end of somebody's
 * sentence and then answer as though it had read the whole thing — and the end
 * of a capture is where the time usually is.
 *
 * `maxCharacters` is on the error because the route puts it in the 413 body,
 * which is the shape `mobile/src/api/client.ts` already parses into
 * `InputTooLargeError`.
 */
export class CaptureInputTooLargeError extends Error {
  constructor(readonly maxCharacters: number = CAPTURE_INPUT_MAX_CHARACTERS) {
    super(`a capture may be at most ${maxCharacters} characters`);
    this.name = 'CaptureInputTooLargeError';
  }
}

/**
 * One capture, split into the commitments it actually names.
 *
 * English connectors were the only ones here, so «بكرة الساعة 9 دكتور وبعدين
 * الساعة 3 الجامعة» — two appointments — arrived as one segment, and the second
 * time was dropped by the extractor's non-global match. The multi-time safety
 * valve then caught it and asked for clarification, which is safe but is the
 * product failing to read a perfectly ordinary sentence (#162 step 3).
 *
 * The Arabic comma «،» and the Hebrew connectors are here for the same reason.
 * A bare «و» (and) is deliberately *not* a connector: it joins words far more
 * often than clauses — «أحمد وسامي» is one errand, not two.
 */
function splitInput(raw: string): string[] {
  const segments = raw
    // A sentence end is a clause boundary (CL1, D1). It was not, so «…يوم
    // الأحد. وبدي أدفع فاتورة الكهربا…» reached the model as one clause, a
    // model asked for one object answered with the doctor, and the bill was
    // gone with nothing to say so. The mark stays on its clause — a question
    // is read as one by `classifyMessageKind`, and a seed keeps the sentence
    // as typed — and an abbreviation or an initial ("Dr. Haddad", "a.m.") is
    // not a sentence end.
    .replace(/(\S*?)([.!?؟]+)(\s+)/g, (match, word: string, stop: string) =>
      (stop === '.' && ABBREVIATION.test(word) ? match : `${word}${stop}|`))
    // «و» is not a connector (below), but «و» straight onto «بدي / لازم /
    // ذكرني / عندي» opens a new commitment — how an unpunctuated, dictated
    // list runs on — and so does "and I need to" / «וצריך». The «و» goes; the
    // word after it stays, because «ذكرني» is what makes a clause a reminder.
    .replace(CLAUSE_OPENER, '|')
    .replace(/[;\n]+/g, '|')
    .replace(/\s+(?:and then|then|also)\s+/gi, '|')
    // «وبعدين»/«وبعدها»/«وكمان» (and then / and after / and also), and Hebrew
    // «ואז»/«וגם». Each is a whole word, so «وكمانك» is untouched.
    .replace(/\s*(?:وبعدين|وبعدها|وبعدين|وكمان|ثم|بعدين)\s+/g, '|')
    .replace(/\s*(?:ואז|וגם|אחר כך)\s+/g, '|')
    .replace(/،+/g, '|')
    .split('|')
    .map((part) => part.trim())
    .map((part) => part.replace(/^[\s,;،]+|[\s,;،]+$/g, '').replace(/^(?:and\b|ثم(?![؀-ۿ])|ו)\s*/i, '').trim())
    .filter(Boolean);
  return segments.length > 0 ? segments : [raw];
}

/**
 * The word before a «.» that is not a sentence end: a title, a Latin
 * abbreviation, or a single letter (an initial, «م.»). Only ever consulted for
 * «.» — `?` and `!` always end a sentence.
 */
// Built from a string: the root `tsconfig.json` targets ES5, which refuses the
// `u` flag on a literal (the runtime is Node 24).
const ABBREVIATION = new RegExp('^(?:[("\'«]*)(?:dr|mr|mrs|ms|prof|st|jr|sr|vs|etc|no|approx|[ap]\\.m|e\\.g|i\\.e|\\p{L})$', 'iu');

/**
 * «و» onto a word that opens a commitment, in the three languages (CL1, D1).
 *
 * Arabic: «وبدي / ولازم / وذكرني / وعندي» and their forms. English: "and I
 * need to / have to / must / and remind me". Hebrew: «וצריך / ותזכיר / ויש
 * לי». The opener word itself is left in the next clause by the lookahead.
 * A bare «و» joining two nouns — «خبز وحليب», «أحمد وسامي» — never matches:
 * the word after it has to be one of these.
 */
const CLAUSE_OPENER = new RegExp(
  [
    '(?:^|[\\s,،|]+)و(?=(?:بدي|بدّي|بدنا|بدّنا|لازم|لازمني|ذكرني|ذكّرني|ذكريني|ذكّريني|عندي|عندنا)(?![\\p{L}\\p{M}]))',
    '\\s+and\\s+(?=(?:remind\\s+me|i\\s+(?:need|have)\\s+to|i\\s+must|i\'ve\\s+got\\s+to)\\b)',
    '\\s+ו(?=(?:צריך|צריכה|תזכיר|תזכירי|יש\\s+לי)(?![\\p{L}\\p{M}]))',
  ].join('|'),
  'giu',
);

/**
 * Why this segment produced nothing, or why it is being refused (UC-2.6, #166).
 *
 * `no_commitment` is not a failure. It means the message asked for nothing, and
 * the right answer is to say so and create nothing — which is a different thing
 * from `rejected`, and used to be flattened into it.
 *
 * `store_note` is included here because a capture the policy would only file as
 * a note is, from the user's side, a capture that created no commitment. Leaving
 * it out was Gap A: a low-confidence greeting became a proposed item with the
 * greeting as its title.
 *
 * An injection and a past time stay `rejected`. Those are unsafe rather than
 * empty, and telling somebody "nothing to save here" about a prompt injection
 * would be the wrong answer to the wrong question.
 */
function semanticFailure(result: ExtractionResult, now: Date): string | null {
  if (result.type === 'unknown' || result.type === 'informational_context') return 'no_commitment';
  // Gap A: the disposition policy would only file this as a note, so there is no
  // commitment in it however confident the extractor was about the sentence.
  if (decideExtractionDisposition(result) === 'store_note') return 'no_commitment';
  const title = (result.title || result.action || '').trim();
  if (title.length < 3) return 'missing_title';
  if (INJECTION.test(result.rawText)) return 'prompt_injection';
  const resolved = result.remindAt || result.dueAt;
  // Same rule as the capture edits and the mobile PATCH, asked in one place
  // (#352); only the answer differs, because a refusal here is a reason code
  // on a proposal rather than an error.
  if (resolved && isPastCommitmentTime(Date.parse(resolved), now)) return 'past_time';
  return null;
}

/**
 * The reason code a no-commitment proposal carries.
 *
 * Taken from `classifyMessageKind` on the same text the extractor read, rather
 * than re-derived from the ambiguity flags. The flags cannot carry this: a
 * question and a greeting both arrive with `no_action_verb`, so deriving from
 * them told somebody who asked «شو الطقس بكرا؟» that their question was small
 * talk.
 *
 * The flags are still the fallback, for the cases the classifier calls a request
 * and the extractor then declined for its own reasons — a real ask it could not
 * read well enough to propose anything for. `low_confidence` is the honest answer
 * there.
 */
/**
 * The same reading with the hour that has already gone taken off (CL1, round
 * 1). The day is kept when it is today or later — «اليوم» is still what the
 * user said — so the clarification asks "what time today?".
 */
function withoutPastTime(result: ExtractionResult, now: Date, timezone: string): ExtractionResult {
  const today = localTimeSpecFor(now, timezone)?.date ?? null;
  const date = result.localTimeSpec?.date ?? null;
  return {
    ...result,
    dueAt: null,
    remindAt: null,
    localTimeSpec: date && today && date >= today ? { date, time: null, timezone } : null,
    timeAnchor: null,
    missingFields: result.missingFields.includes('time') ? result.missingFields : [...result.missingFields, 'time'],
  };
}

function noCommitmentReasonFrom(
  segment: string,
  result: ExtractionResult,
  fallbackReason: string | null,
): NoCommitmentReason {
  const kind = classifyMessageKind(segment);
  if (kind !== 'request') return kind;
  if (result.ambiguityFlags.includes('negated_request')) return 'negated_request';
  if (fallbackReason?.startsWith('semantic_safety:past_no_action')) return 'past_event';
  if (result.ambiguityFlags.includes('informational_without_action')) return 'informational';
  return 'low_confidence';
}

function auditEvent(outcome: 'succeeded' | 'rejected' | 'failed' | 'fell_back', raw: string, now: Date, reasonCode?: string, itemCount?: number): AuditEventEnvelope {
  return createAuditEvent({
    eventId: randomUUID(),
    eventType: 'module_execution',
    occurredAt: now.toISOString(),
    correlationId: randomUUID(),
    module: 'capture',
    fields: {
      outcome,
      reasonCode,
      itemCount,
      inputHash: createHash('sha256').update(raw).digest('hex'),
      inputLength: raw.length,
    },
  });
}

export async function proposeCapture(rawInput: unknown, options: ProposeCaptureOptions, dependencies: CaptureBoundaryDependencies): Promise<CaptureProposalContract> {
  const raw = typeof rawInput === 'string' ? rawInput.trim() : '';
  /*
   * The server's length boundary, and the only one (#508).
   *
   * Here rather than in a route because this is the lowest point every way in
   * shares: the typed capture reaches it through `proposeMobileCapture`, and so
   * does a share (lib/services/share/shareIntakeService.ts:398). A route-level
   * check would be one more thing the next route has to remember.
   *
   * First statement in the function, before `readCategoryPreferences` reads
   * storage, before `splitInput` runs its regexes, and before a single segment
   * is offered to the extractor or to a model.
   */
  if (raw.length > CAPTURE_INPUT_MAX_CHARACTERS) throw new CaptureInputTooLargeError();
  const requestedEngine = options.requestedEngine ?? 'model';
  const runtime = resolveModuleRuntime('capture', dependencies.controls);
  const forceRules = requestedEngine === 'rules' || runtime.mode === 'rules_only';
  const extractor = dependencies.extractor ?? extractWithFallback;
  // The scope *is* the authenticated uid, so the categories this account uses
  // are readable here. Read once for the whole capture rather than per segment:
  // a paste that splits into five segments must not file its five commitments
  // against five different reads of the same preference (#415).
  const categoryPreferences = await readCategoryPreferences(options.scopeId);
  // The same list reaches the prompt and the gate. Two lists would let the
  // model be asked for a category the gate then silently discards.
  const context: ExtractionContext = {
    now: options.now,
    timezone: options.timezone,
    categories: categoryPreferences.enabled,
  };
  const proposalId = randomUUID();
  const commandsByItemId = new Map<string, readonly ReturnType<typeof mapExtractionToCommand>[number][]>();
  // Kept so one clarification can be answered against the extraction the item
  // came from, rather than by patching its contract (#165).
  const resultsByItemId = new Map<string, ExtractionResult>();
  const items: CaptureProposalContract['items'] = [];
  /**
   * What the user may merely be considering or waiting on (#519).
   *
   * Nothing here is persisted by this call, and nothing here holds a command:
   * a seed proposal is a segment and a kind, and it becomes a stored Seed only
   * when the user picks it in Review and the app posts it to
   * `/api/mobile/seeds`.
   */
  const seeds: CaptureSeedProposalContract[] = [];
  let executedEngine: CaptureProposalContract['provenance']['executedEngine'] = 'rule-based';
  let fallbackUsed = forceRules;
  let rejected = !raw;
  // The reason the first empty segment gave, so a no-commitment proposal can say
  // which kind of message this was (#166). First rather than last: the opening of
  // a message is what it is about.
  let noCommitmentReason: NoCommitmentReason | null = null;

  const segments = raw ? splitInput(raw) : [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    // One paste can split into many segments, and each would otherwise be its
    // own model call — so a single capture could cost a dozen (#160 step 7).
    // Past the cap the remaining segments go through the rule-based extractor
    // rather than being dropped: the user still gets their commitments, they
    // are just read without the model.
    const rulesOnly = forceRules || index >= MAX_MODEL_SEGMENTS;
    /*
     * Unresolved intent is read before the extractor, not after it (#519).
     *
     * After would be the tidier place — "whatever produced no commitment, look
     * at again" — and it is where three of the issue's six example sentences
     * would in fact land. The other three do not. «אולי אני אגיש מועמדות» and
     * "I'm waiting for the doctor to reply" are read by the rule-based
     * extractor as tasks whose time is missing, so they arrive as items
     * *needing clarification*: the product would answer somebody's "maybe" by
     * asking them what time their maybe is. That is the failure this issue
     * exists to remove, and it happens upstream of any no-commitment branch.
     *
     * The narrowing that makes this safe is in `detectUnresolvedIntent`: an
     * explicit scheduling verb anywhere in the segment means it is a request
     * and the detector declines, so «ممكن تذكرني بكرة الساعة ٩؟» stays the
     * reminder it obviously is.
     */
    const intent = detectUnresolvedIntent(segment);
    if (intent) {
      seeds.push({ seedItemId: randomUUID(), kind: intent.kind, summary: segment });
      continue;
    }
    try {
      const several = segments.length > 1;
      let extracted: Awaited<ReturnType<typeof extractor>>;
      try {
        extracted = await extractor(segment, context, {
          llmProvider: rulesOnly ? RULES_ONLY_PROVIDER : dependencies.llmProvider,
          llmEngine: dependencies.llmEngine,
        });
      } catch (error) {
        // The guarded extractor refuses a time that has gone by throwing, and
        // keeps nothing it read. In a capture of several clauses the clause is
        // read again by the rules — no second model call — so it can be
        // offered without its hour, below. Alone, the refusal stands.
        if (!(error instanceof PastCommitmentTimeError) || !several) throw error;
        extracted = await extractWithFallback(segment, context, { llmProvider: RULES_ONLY_PROVIDER, llmEngine: dependencies.llmEngine });
      }
      let failure = semanticFailure(extracted.result, options.now);
      /*
       * One clause must not sink the others (CL1, round 1). «بدي أشتري خبز
       * بكرا، وذكرني أتصل بأمي اليوم الساعة 9 الصبح» sent at 10:00 was
       * `rejected` whole — the route answered 400 and the bread went with the
       * call. In a capture of several clauses:
       *
       *   past_time      the clause is kept without the hour that has gone,
       *                  as an item needing clarification, so the user picks
       *                  a new time rather than losing the commitment;
       *   missing_title  there is nothing to name, so only that clause is
       *                  skipped.
       *
       * A prompt injection still rejects the whole capture: that is unsafe,
       * not merely unreadable. A capture of one clause is unchanged.
       */
      let clearedPastTime = false;
      if (several && failure === 'past_time') {
        extracted = { ...extracted, result: withoutPastTime(extracted.result, options.now, options.timezone) };
        failure = semanticFailure(extracted.result, options.now);
        clearedPastTime = failure === null;
      }
      if (several && failure === 'missing_title') continue;
      /*
       * The model found nothing in a clause that asks for something, beside
       * clauses that did produce items (CL1, D1). Left alone, the proposal
       * shows the others and this one is gone with nothing to say so — the
       * silent half of a dropped commitment. The rules read the same clause
       * instead; if they also find nothing, nothing is invented.
       *
       * Only in a capture of several clauses: alone, a no-commitment answer
       * is shown to the user as one, which is not silent.
       */
      if (
        failure === 'no_commitment'
        && segments.length > 1
        && extracted.engine !== 'rule-based'
        && classifyMessageKind(segment) === 'request'
      ) {
        const recovered = await extractor(segment, context, { llmProvider: RULES_ONLY_PROVIDER, llmEngine: dependencies.llmEngine });
        if (semanticFailure(recovered.result, options.now) === null) {
          extracted = recovered;
          failure = null;
        }
      }
      // Whatever actually answered, named. It used to be flattened to 'ollama'
      // because that was the only model there was.
      executedEngine = extracted.engine;
      fallbackUsed ||= Boolean(extracted.fallbackReason);
      if (failure === 'no_commitment') {
        noCommitmentReason ??= noCommitmentReasonFrom(segment, extracted.result, extracted.fallbackReason);
        continue;
      }
      if (failure) {
        rejected = true;
        continue;
      }
      const disposition = decideExtractionDisposition(extracted.result);
      const needsClarification = clearedPastTime || disposition === 'needs_clarification';
      const itemId = randomUUID();
      items.push({
        itemId,
        title: (extracted.result.title || extracted.result.action || '').trim(),
        resolvedTime: needsClarification ? null : extracted.result.remindAt || extracted.result.dueAt,
        needsClarification,
        // Sent so the review screen can show Must/Should/Nice without a second
        // call — and so the user can see which of the two it is (#164).
        priority: extracted.result.priority.level,
        // `user_explicit` means the person said so; anything else is ours. A
        // guess presented as a fact is how a product loses the right to guess.
        priorityEstimated: extracted.result.priority.source !== 'user_explicit',
        // The day, even while the hour is still being asked for, and whether we
        // picked it — the same "said vs guessed" split as the priority (L4).
        ...(/^\d{4}-\d{2}-\d{2}$/.test(extracted.result.localTimeSpec?.date ?? '')
          ? { resolvedDate: extracted.result.localTimeSpec!.date, dateEstimated: extracted.result.dateInferred === true }
          : {}),
        // The one question worth asking, chosen deterministically (#165). Null
        // when there is nothing worth asking, or when every sensible option has
        // fallen into the past — in which case the app falls back to #164's edit
        // sheet rather than asking something unanswerable.
        ...(needsClarification
          ? { clarification: buildClarification(extracted.result, { now: options.now, timezone: options.timezone }) }
          : {}),
      });
      commandsByItemId.set(itemId, needsClarification ? [] : mapExtractionToCommand(extracted.result, options.now.toISOString(), categoryPreferences));
      resultsByItemId.set(itemId, extracted.result);
    } catch (error) {
      // Gap B: a negated request is understood, not malformed. It produces no
      // commitment and says so, rather than an error the user has to interpret.
      if (error instanceof NegatedRequestError) {
        noCommitmentReason ??= 'negated_request';
        continue;
      }
      rejected = true;
    }
  }

  // A sentence naming more clock times than the proposal accounts for lost
  // one. The extractor reads a time with a non-global `String.match`, so a
  // segment carrying two times yields one commitment that looks complete, and
  // the confidence policy — which only sees that one result — reports nothing
  // to clarify. Asking is the safe direction: the alternative is silently
  // dropping an appointment while telling the user everything was understood.
  //
  // This only ever moves an item to needing clarification, never away from it,
  // and input naming no clock time cannot trigger it.
  const timesInInput = countTimeExpressions(raw);
  if (timesInInput > 0 && items.length > 0) {
    const timesAccountedFor = new Set(
      items.map((item) => item.resolvedTime).filter(Boolean),
    ).size;
    if (timesAccountedFor < timesInInput) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].needsClarification) continue;
        items[i] = { ...items[i], resolvedTime: null, needsClarification: true };
        commandsByItemId.set(items[i].itemId, []);
      }
    }
  }

  const status: CaptureProposalContract['status'] = rejected
    ? 'rejected'
    : items.length === 0
      // A capture that named only things the user is turning over is not
      // "nothing" — there is something to offer, and only they can say whether
      // it is worth keeping (#519). With no seeds either, it is the ordinary
      // no-commitment answer and the reason code goes with it.
      ? (seeds.length > 0 ? 'unresolved_intent' : 'no_commitment')
      : items.every((item) => item.needsClarification)
        ? 'needs_clarification'
        : 'proposed';
  const contract: CaptureProposalContract = {
    version: CAPTURE_CONTRACT_VERSION,
    proposalId,
    status,
    // Only on a no-commitment proposal. A `rejected` one is refusing something
    // unsafe, and a reason code there would invite the client to explain it.
    ...(status === 'no_commitment' ? { noCommitmentReason: noCommitmentReason ?? 'low_confidence' } : {}),
    items,
    seeds,
    provenance: { requestedEngine, executedEngine, fallbackUsed },
  };
  await dependencies.store.put({
    contract,
    scopeId: options.scopeId,
    commandsByItemId,
    resultsByItemId,
    /*
     * When it was made, by the server's clock — not `options.now`.
     *
     * `options.now` is the *client's* `referenceTime`, the instant "tomorrow at
     * 9" is resolved against. Using it here conflated two different things and
     * handed the TTL to the caller: a `referenceTime` in the future would keep
     * a proposal confirmable indefinitely, and one in the past would kill it on
     * arrival. The staleness guard exists to catch a proposal resolved against
     * a stale clock, so it has to be measured by a clock the client does not
     * choose (#164 step 7).
     */
    proposedAt: new Date().toISOString(),
  });
  dependencies.audit?.(auditEvent(fallbackUsed ? 'fell_back' : status === 'rejected' ? 'rejected' : 'succeeded', raw, options.now, status, items.length));
  return contract;
}


/**
 * An extraction result standing for what a user typed by hand (UC-2.4, #164).
 *
 * Used only when an item needed clarification and the person answered it in the
 * review screen by supplying a title and a time themselves. Confidence is 1 and
 * the priority is `user_explicit` because none of it is inferred — they said it.
 *
 * It goes through `mapExtractionToCommand` rather than building a command here,
 * so a manually completed item is constructed by exactly the same code as every
 * other commitment and cannot drift from it.
 */
function manuallyCompleted(
  title: string,
  resolvedTime: string,
  priority: 'low' | 'normal' | 'high',
): ExtractionResult {
  return {
    type: 'task',
    action: title,
    title,
    person: null,
    dueAt: resolvedTime,
    remindAt: resolvedTime,
    localTimeSpec: null,
    timeEvidence: 'hhmm',
    priority: { level: priority, source: 'user_explicit', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    // This path runs only when the extraction produced no command at all, so
    // the user built the item themselves from a title and a time. Nothing was
    // read about which part of life it belongs to and the review screen does
    // not ask, so it starts uncategorised — which is the ordinary case anyway
    // (#415).
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 1, type: 1, action: 1, time: 1, priority: 1 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: true,
    explicitPressureRequest: false,
    rawText: title,
    parserVersion: 'user-edit-v1',
  };
}

export async function confirmCapture(
  input: {
    proposalId: string;
    scopeId: string;
    selectedItemIds: string[];
    idempotencyKey: string;
    /** Applied atomically with the confirm, never afterwards (#164). */
    edits?: CaptureItemEditContract[];
    /** For the TTL check. Injected so the rule is testable without waiting. */
    now?: Date;
  },
  dependencies: CaptureBoundaryDependencies,
): Promise<CaptureConfirmationResultContract> {
  const stored = await dependencies.store.get(input.proposalId);
  const failure = (
    failureCode: CaptureConfirmationResultContract['failureCode'],
    cause?: unknown,
  ): CaptureConfirmationResultContract => ({
    version: CAPTURE_CONTRACT_VERSION,
    success: false,
    replayed: false,
    persistedItemIds: [],
    failureCode,
    ...(cause === undefined ? {} : { failureCause: storageFailureCause(cause) }),
  });
  if (!stored || stored.scopeId !== input.scopeId) return failure('proposal_not_found');
  if (stored.confirmedResult) {
    if (stored.idempotencyKey !== input.idempotencyKey) return failure('invalid_selection');
    return { ...(stored.confirmedResult as CaptureConfirmationResultContract), replayed: true };
  }
  // `needs_clarification` is confirmable, `rejected` and `no_commitment` are not
  // (UC-2.4, #164 step 3).
  //
  // An item awaiting a question has no commands, so confirming it without
  // answering the question still fails below on `commands.length === 0`. What
  // this allows is the case the issue asks for: a user who supplied the missing
  // title and time themselves in review has answered it by hand, and refusing
  // the whole proposal because the *extractor* had a question would make that
  // impossible.
  if (stored.contract.status !== 'proposed' && stored.contract.status !== 'needs_clarification') {
    return failure('proposal_rejected');
  }

  // A proposal older than the TTL resolved "tomorrow at 9" against a `now` that
  // is no longer close enough to now, and the user cannot see that from the
  // screen. `proposal_not_found` rather than a new code: from the client's side
  // an expired proposal and a swept one are the same thing, and the app offers
  // to analyze the text again for both (#164 step 7).
  const now = input.now ?? new Date();
  if (stored.proposedAt) {
    /*
     * Both ends of this are the server's clock, deliberately.
     *
     * `proposedAt` is when the server made the proposal and `Date.now()` is
     * when it is being confirmed. `input.now` is the caller's `referenceTime` —
     * the instant relative phrases were resolved against — and measuring the
     * age against that would let a caller send a `referenceTime` of its own
     * choosing to keep a stale proposal alive, which is the one thing this
     * guard exists to prevent.
     */
    const age = Date.now() - Date.parse(stored.proposedAt);
    if (Number.isFinite(age) && age > CAPTURE_PROPOSAL_TTL_MS) return failure('proposal_not_found');
  }

  const selected = new Set(input.selectedItemIds);
  if (selected.size === 0) return failure('invalid_selection');

  // Every edit is validated before any of them is applied, and a single
  // violation fails the whole confirm. Applying the valid ones and dropping the
  // rest would leave some commitments as the user wanted them and others as the
  // extractor guessed, with nothing on screen to say which.
  const knownItemIds = new Set(stored.contract.items.map((item) => item.itemId));
  const editsByItem = new Map<string, ReturnType<typeof validateEdit>>();
  try {
    for (const edit of input.edits ?? []) {
      const normalised = validateEdit(edit, knownItemIds, now);
      // An edit for something the user chose not to save is dropped rather than
      // applied: it would ask the server to validate a change to a commitment
      // that is not being written.
      if (selected.has(edit.itemId)) editsByItem.set(edit.itemId, normalised);
    }
  } catch (error) {
    if (error instanceof InvalidEditError) return failure('invalid_edit');
    throw error;
  }

  // An item that needed clarification has no commands. A user who supplied both
  // a title and a time for it in review has answered the question by hand, so it
  // becomes confirmable — that is what "manual completion" means (#164 step 3).
  const commandsFor = (itemId: string): readonly Command[] => {
    const stored_ = stored.commandsByItemId.get(itemId) ?? [];
    const edit = editsByItem.get(itemId);
    if (stored_.length > 0) return edit ? applyEditToCommands(stored_, edit) : stored_;
    if (!edit?.title || !edit?.resolvedTime) return [];
    const item = stored.contract.items.find((candidate) => candidate.itemId === itemId);
    return mapExtractionToCommand(
      manuallyCompleted(edit.title, edit.resolvedTime, edit.priority ?? item?.priority ?? 'normal'),
      now.toISOString(),
    );
  };

  if (Array.from(selected).some((id) => !knownItemIds.has(id))) return failure('invalid_selection');
  /**
   * What this confirm is about to commit, kept per item and recorded with it.
   *
   * A clarification item is stored with no commands and gets them here, at
   * confirm time. Everything downstream — `persisted`, the collision warning,
   * Undo, the activation — looks the commitment up through the commands the
   * proposal holds for the item, so without this write-back the confirm
   * reports success and leaves behind a commitment nothing can name (#480).
   * Edited commands are recorded as edited, for the same reason: the proposal
   * should say what was written, not what was proposed.
   */
  const committedByItemId = new Map(stored.commandsByItemId);
  for (const item of stored.contract.items) {
    if (selected.has(item.itemId)) committedByItemId.set(item.itemId, commandsFor(item.itemId));
  }
  const commands = stored.contract.items
    .filter((item) => selected.has(item.itemId))
    .flatMap((item) => committedByItemId.get(item.itemId) ?? []);
  if (commands.length === 0) return failure('invalid_selection');
  const result: CaptureConfirmationResultContract = {
    version: CAPTURE_CONTRACT_VERSION,
    success: true,
    replayed: false,
    persistedItemIds: stored.contract.items.filter((item) => selected.has(item.itemId)).map((item) => item.itemId),
  };

  if (dependencies.commitConfirmation) {
    // The commitments and the claim commit together, so a confirm that races
    // another one for the same proposal replays it rather than persisting a
    // second set (#148).
    try {
      const committed = await dependencies.commitConfirmation({
        scopeId: input.scopeId,
        proposalId: input.proposalId,
        idempotencyKey: input.idempotencyKey,
        commands,
        commandsByItemId: committedByItemId,
        result,
      });
      return committed.replayed ? { ...committed.result, replayed: true } : committed.result;
    } catch (error) {
      // The message goes to the operator log, where paths and uids are already
      // permitted; only the cause's name travels on the contract (#419).
      console.error('[capture/confirm] the confirmation transaction failed', error);
      return failure('persistence_failed', error);
    }
  }

  // No participant-scoped storage: the in-process development path. It persists
  // and then records, which is exactly the window the committer above closes —
  // acceptable only because this path serves one process and no real account.
  try {
    await dependencies.persistence.persistAtomically(commands);
  } catch (error) {
    console.error('[capture/confirm] the in-process persist failed', error);
    return failure('persistence_failed', error);
  }
  // The Map-backed store persisted this by mutation. A durable store does
  // not, and without the write-back a replayed confirm would find no recorded
  // result and persist the commitments a second time.
  await dependencies.store.put({
    ...stored,
    commandsByItemId: committedByItemId,
    confirmedResult: result,
    idempotencyKey: input.idempotencyKey,
  });
  return result;
}
