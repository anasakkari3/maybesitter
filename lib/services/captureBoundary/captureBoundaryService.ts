import { createHash, randomUUID } from 'crypto';
import { extractWithFallback, type ExtractAndMapOptions } from '../../../src/extraction/extractionService';
import { decideExtractionDisposition } from '../../../src/extraction/extractionPolicy';
import { mapExtractionToCommand } from '../../../src/extraction/mapExtractionToCommand';
import { countTimeExpressions } from '../../../src/extraction/ruleBasedExtractor';
import { classifyMessageKind } from '../../../src/extraction/messageKind';
import type { ExtractionContext, ExtractionResult } from '../../../src/extraction/extractionTypes';
import { resolveModuleRuntime, type AuditEventEnvelope, createAuditEvent, type RuntimeControlSnapshot } from '../../../src/contracts/v1/runtimeControls';
import {
  CAPTURE_CONTRACT_VERSION,
  type CaptureConfirmationResultContract,
  type CaptureProposalContract,
  type NoCommitmentReason,
} from '../../../src/contracts/v1/captureContracts';
import { NegatedRequestError } from '../mobile/safety';
import type { Command } from '../../../src/domain/stateMachine';
import type { CapturePersistenceAdapter } from './persistenceAdapter';
import type { CaptureProposalStore, StoredCaptureProposal } from './proposalStore';

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
 * Five. Beyond that the marginal segment is almost always a list item the rule
 * based extractor reads just as well, and the cost is per call.
 */
const MAX_MODEL_SEGMENTS = 5;

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
    .replace(/[;\n]+/g, '|')
    .replace(/\s+(?:and then|then|also)\s+/gi, '|')
    // «وبعدين»/«وبعدها»/«وكمان» (and then / and after / and also), and Hebrew
    // «ואז»/«וגם». Each is a whole word, so «وكمانك» is untouched.
    .replace(/\s*(?:وبعدين|وبعدها|وبعدين|وكمان|ثم|بعدين)\s+/g, '|')
    .replace(/\s*(?:ואז|וגם|אחר כך)\s+/g, '|')
    .replace(/،+/g, '|')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
  return segments.length > 0 ? segments : [raw];
}

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
  if (resolved && Date.parse(resolved) < now.getTime()) return 'past_time';
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
  const requestedEngine = options.requestedEngine ?? 'model';
  const runtime = resolveModuleRuntime('capture', dependencies.controls);
  const forceRules = requestedEngine === 'rules' || runtime.mode === 'rules_only';
  const extractor = dependencies.extractor ?? extractWithFallback;
  const context: ExtractionContext = { now: options.now, timezone: options.timezone };
  const proposalId = randomUUID();
  const commandsByItemId = new Map<string, readonly ReturnType<typeof mapExtractionToCommand>[number][]>();
  const items: CaptureProposalContract['items'] = [];
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
    try {
      const extracted = await extractor(segment, context, {
        llmProvider: rulesOnly ? async () => { throw new Error('rules-only runtime'); } : dependencies.llmProvider,
        llmEngine: dependencies.llmEngine,
      });
      // Whatever actually answered, named. It used to be flattened to 'ollama'
      // because that was the only model there was.
      executedEngine = extracted.engine;
      fallbackUsed ||= Boolean(extracted.fallbackReason);
      const failure = semanticFailure(extracted.result, options.now);
      if (failure === 'no_commitment') {
        noCommitmentReason ??= noCommitmentReasonFrom(segment, extracted.result, extracted.fallbackReason);
        continue;
      }
      if (failure) {
        rejected = true;
        continue;
      }
      const disposition = decideExtractionDisposition(extracted.result);
      const needsClarification = disposition === 'needs_clarification';
      const itemId = randomUUID();
      items.push({
        itemId,
        title: (extracted.result.title || extracted.result.action || '').trim(),
        resolvedTime: needsClarification ? null : extracted.result.remindAt || extracted.result.dueAt,
        needsClarification,
      });
      commandsByItemId.set(itemId, needsClarification ? [] : mapExtractionToCommand(extracted.result, options.now.toISOString()));
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
      ? 'no_commitment'
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
    provenance: { requestedEngine, executedEngine, fallbackUsed },
  };
  await dependencies.store.put({ contract, scopeId: options.scopeId, commandsByItemId });
  dependencies.audit?.(auditEvent(fallbackUsed ? 'fell_back' : status === 'rejected' ? 'rejected' : 'succeeded', raw, options.now, status, items.length));
  return contract;
}

export async function confirmCapture(input: { proposalId: string; scopeId: string; selectedItemIds: string[]; idempotencyKey: string }, dependencies: CaptureBoundaryDependencies): Promise<CaptureConfirmationResultContract> {
  const stored = await dependencies.store.get(input.proposalId);
  const failure = (failureCode: CaptureConfirmationResultContract['failureCode']): CaptureConfirmationResultContract => ({
    version: CAPTURE_CONTRACT_VERSION,
    success: false,
    replayed: false,
    persistedItemIds: [],
    failureCode,
  });
  if (!stored || stored.scopeId !== input.scopeId) return failure('proposal_not_found');
  if (stored.confirmedResult) {
    if (stored.idempotencyKey !== input.idempotencyKey) return failure('invalid_selection');
    return { ...(stored.confirmedResult as CaptureConfirmationResultContract), replayed: true };
  }
  if (stored.contract.status !== 'proposed') return failure('proposal_rejected');
  const selected = new Set(input.selectedItemIds);
  if (selected.size === 0 || Array.from(selected).some((id) => !stored.commandsByItemId.has(id))) return failure('invalid_selection');
  const commands = stored.contract.items
    .filter((item) => selected.has(item.itemId))
    .flatMap((item) => stored.commandsByItemId.get(item.itemId) ?? []);
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
        result,
      });
      return committed.replayed ? { ...committed.result, replayed: true } : committed.result;
    } catch {
      return failure('persistence_failed');
    }
  }

  // No participant-scoped storage: the in-process development path. It persists
  // and then records, which is exactly the window the committer above closes —
  // acceptable only because this path serves one process and no real account.
  try {
    await dependencies.persistence.persistAtomically(commands);
  } catch {
    return failure('persistence_failed');
  }
  // The Map-backed store persisted this by mutation. A durable store does
  // not, and without the write-back a replayed confirm would find no recorded
  // result and persist the commitments a second time.
  await dependencies.store.put({ ...stored, confirmedResult: result, idempotencyKey: input.idempotencyKey });
  return result;
}
