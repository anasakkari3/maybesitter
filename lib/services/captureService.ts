import { randomUUID } from 'crypto';
import type { Command, DomainState } from '../../src/domain/stateMachine';
import { decideExtractionDisposition } from '../../src/extraction/extractionPolicy';
import {
  extractWithFallback,
  type ExtractAndMapOptions,
  type ExtractionEngine,
} from '../../src/extraction/extractionService';
import type { ExtractionContext, ExtractionDisposition, ExtractionResult } from '../../src/extraction/extractionTypes';
import { mapExtractionToCommand } from '../../src/extraction/mapExtractionToCommand';
import {
  createDefaultClarificationStore,
  scopeClarification,
  type ClarificationStore,
  type PendingClarification,
} from './clarificationStore';
import { mergeClarificationInput } from './clarificationMerge';
import { formatResponse, type FormattedResponse, type ResponseFormatterDisposition } from './responseFormatter';
import {
  recordBehaviorFeedback,
  type BehaviorFeedbackStore,
} from './behaviorFeedbackService';
import {
  type CommandServiceResult,
  getDeterministicStateGateway,
  type DeterministicStateGateway,
} from './deterministicStateGateway';

export type CaptureEngineUsed = ExtractionEngine | 'none';
export type CaptureDisposition = ExtractionDisposition | 'multi_commitment' | 'no_op';

export interface CaptureServiceOptions {
  now?: Date;
  timezone?: string;
  defaultReminderHour?: number;
  llmProvider?: ExtractAndMapOptions['llmProvider'];
  sessionId?: string;
  userId?: string;
  conversationId?: string;
  pendingClarificationId?: string;
  clarificationTtlMs?: number;
  clarificationStore?: ClarificationStore;
  behaviorFeedbackStore?: BehaviorFeedbackStore;
  deterministicStateGateway?: DeterministicStateGateway;
}

export interface CaptureServiceResult {
  success: boolean;
  response: FormattedResponse;
  meta: {
    engineUsed: CaptureEngineUsed;
    disposition: CaptureDisposition;
    pendingClarificationId?: string;
    clarificationExpiresAt?: string;
    clarificationScopeId?: string;
  };
}

export interface ClearClarificationOptions {
  sessionId?: string;
  userId?: string;
  conversationId?: string;
  pendingClarificationId?: string;
  clarificationStore?: ClarificationStore;
}

const VALID_EXTRACTION_TYPES = new Set(['task', 'follow_up', 'informational_context', 'unknown']);
const DEFAULT_CLARIFICATION_TTL_MS = 10 * 60 * 1000;
const REMINDER_REQUEST_PATTERN = /\b(remind me to|remember to|bug me)\b/i;
const PRIORITY_LABELS: Record<ExtractionResult['priority']['level'], string> = {
  high: 'Must',
  normal: 'Should',
  low: 'Nice',
};

function normalizeInput(rawText: unknown): string {
  return typeof rawText === 'string' ? rawText.trim() : '';
}

function splitMultiCommitmentInput(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const candidate = normalized
    .replace(/[;\n]+/g, '|')
    .replace(/,\s+(?=(?:and\s+)?(?:remind me to|remember to|i need to|need to|i have to|have to|follow up|call|email|text|pay|submit|read|pick up|renew|reply|send|buy|finish|review|urgent|important|must|maybe)\b)/gi, '|')
    .replace(/\s+(?:and|also|plus)\s+(?=(?:remind me to|remember to|i need to|need to|i have to|have to|follow up|call|email|text|pay|submit|read|pick up|renew|reply|send|buy|finish|review|urgent|important|must|maybe)\b)/gi, '|');
  const parts = candidate
    .split('|')
    .map((part) => part.replace(/^(?:and|also|plus)\s+/i, '').trim())
    .filter((part) => part.length >= 3);

  if (parts.length < 2) return [];
  const originalHasReminderRequest = REMINDER_REQUEST_PATTERN.test(text);
  return parts.map((part, index) => {
    if (index === 0 || !originalHasReminderRequest || REMINDER_REQUEST_PATTERN.test(part)) return part;
    return `Remind me to ${part}`;
  });
}

function priorityRank(level: ExtractionResult['priority']['level']): number {
  if (level === 'high') return 0;
  if (level === 'normal') return 1;
  return 2;
}

function actionSummaryFor(result: ExtractionResult, commandResults: readonly CommandServiceResult[]): string {
  const title = result.title || result.action || result.rawText;
  const label = PRIORITY_LABELS[result.priority.level];
  const appliedCount = commandResults.filter((item) => item.result === 'applied').length;
  const status = appliedCount > 1
    ? 'saved and scheduled'
    : appliedCount === 1
      ? 'saved for review'
      : 'needs a clearer detail';
  return `${label}: ${title} - ${status}`;
}

function listTitles(titles: readonly string[]): string {
  if (titles.length === 0) return '';
  if (titles.length === 1) return titles[0];
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles.slice(0, -1).join(', ')}, and ${titles[titles.length - 1]}`;
}

function multiCommitmentMessage(
  ordered: readonly {
    result: ExtractionResult;
    disposition: ExtractionDisposition;
    commandResults: CommandServiceResult[];
  }[],
  savedCount: number,
  needsClarification: number,
  executionNotes: readonly string[]
): string {
  if (savedCount === 0) {
    return needsClarification > 0
      ? `I split that into ${ordered.length} items, but I need more detail before saving them.`
      : "I couldn't save those safely.";
  }

  const scheduled = ordered
    .filter((item) => item.commandResults.filter((result) => result.result === 'applied').length > 1)
    .map((item) => item.result.title || item.result.action || item.result.rawText);
  const review = ordered
    .filter((item) => item.commandResults.filter((result) => result.result === 'applied').length === 1)
    .map((item) => item.result.title || item.result.action || item.result.rawText);
  const lead = savedCount === 1 ? 'Saved one item.' : `Saved ${savedCount} items.`;
  const details: string[] = [];

  if (scheduled.length > 0) details.push(`Scheduled ${listTitles(scheduled)}.`);
  if (review.length > 0) details.push(`Saved ${listTitles(review)} for review.`);
  if (needsClarification > 0) {
    details.push(needsClarification === 1
      ? 'One item needs more detail.'
      : `${needsClarification} items need more detail.`);
  }
  if (executionNotes.length > 0) details.push('Some parts need another pass.');

  return [lead, ...details].join(' ');
}

function fallbackCommandResult(snapshot: DomainState): CommandServiceResult {
  return {
    result: 'rejected',
    newState: snapshot,
    events: [],
  };
}

function responseScopeId(options: Pick<CaptureServiceOptions, 'conversationId' | 'sessionId' | 'userId'>): string | undefined {
  return options.conversationId || options.sessionId || options.userId;
}

function validateExtraction(result: ExtractionResult): ExtractionResult {
  if (!result || !VALID_EXTRACTION_TYPES.has(result.type)) {
    throw new Error('Extraction returned an unsupported type');
  }
  if (!Array.isArray(result.missingFields) || !Array.isArray(result.ambiguityFlags)) {
    throw new Error('Extraction returned malformed metadata');
  }
  if (!result.confidence || typeof result.confidence.overall !== 'number') {
    throw new Error('Extraction returned malformed confidence');
  }
  return result;
}

function shouldExecuteCommands(disposition: ExtractionDisposition): boolean {
  return disposition !== 'needs_clarification' && disposition !== 'store_note';
}

function executeCommands(
  commands: readonly Command[],
  deterministicStateGateway: DeterministicStateGateway,
): CommandServiceResult[] {
  return commands.map((command) => {
    try {
      return deterministicStateGateway.apply(command);
    } catch {
      return fallbackCommandResult(deterministicStateGateway.snapshot());
    }
  });
}

function hasRejectedCommand(commandResults: readonly CommandServiceResult[]): boolean {
  return commandResults.some((result) => result.result === 'rejected');
}

function safeNoOpResponse(message: string): CaptureServiceResult {
  return {
    success: false,
    response: formatResponse({
      disposition: 'no_op',
      result: { type: 'unknown', title: 'your message' },
      commands: [],
      commandResults: [],
      executionNotes: [message],
    }),
    meta: {
      engineUsed: 'none',
      disposition: 'no_op',
    },
  };
}

async function captureMultipleCommitments(
  segments: readonly string[],
  context: ExtractionContext,
  options: CaptureServiceOptions
): Promise<CaptureServiceResult> {
  const deterministicStateGateway = options.deterministicStateGateway || getDeterministicStateGateway();
  const executionNotes: string[] = [];
  const captured: {
    index: number;
    result: ExtractionResult;
    disposition: ExtractionDisposition;
    commandResults: CommandServiceResult[];
  }[] = [];
  let engineUsed: CaptureEngineUsed = 'ollama';

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    let extracted: Awaited<ReturnType<typeof extractWithFallback>>;
    try {
      extracted = await extractWithFallback(segment, context, { llmProvider: options.llmProvider });
    } catch {
      executionNotes.push(`I could not process "${segment}" safely.`);
      continue;
    }

    let result: ExtractionResult;
    try {
      result = validateExtraction(extracted.result);
    } catch {
      executionNotes.push(`I could not validate "${segment}" safely.`);
      continue;
    }

    if (extracted.engine === 'rule-based') engineUsed = 'rule-based';
    const disposition = decideExtractionDisposition(result);
    let commands: Command[] = [];
    try {
      commands = mapExtractionToCommand(result, context.now.toISOString());
    } catch {
      executionNotes.push(`I could not convert "${result.title || segment}" safely.`);
    }

    const commandsToExecute = shouldExecuteCommands(disposition) ? commands : [];
    const commandResults = executeCommands(commandsToExecute, deterministicStateGateway);
    if (hasRejectedCommand(commandResults)) {
      executionNotes.push(`I skipped part of "${result.title || segment}" because it could not be applied safely.`);
    }
    captured.push({ index, result, disposition, commandResults });
  }

  if (captured.length === 0) {
    return safeNoOpResponse('I could not split that safely, so I did not make changes.');
  }

  const ordered = [...captured].sort((a, b) => {
    const byPriority = priorityRank(a.result.priority.level) - priorityRank(b.result.priority.level);
    if (byPriority !== 0) return byPriority;
    return a.index - b.index;
  });
  const savedCount = ordered.filter((item) => item.commandResults.some((result) => result.result === 'applied')).length;
  const needsClarification = ordered.filter((item) => item.disposition === 'needs_clarification').length;
  const actions = ordered.map((item) => actionSummaryFor(item.result, item.commandResults));
  if (executionNotes.length > 0) actions.push(...executionNotes);

  return {
    success: savedCount > 0 && executionNotes.length === 0,
    response: {
      message: multiCommitmentMessage(ordered, savedCount, needsClarification, executionNotes),
      interpretation: '',
      actions: [],
      nextStep: needsClarification > 0
        ? { type: 'clarify', message: 'Send the missing details for the items that need them.' }
        : { type: 'none', message: '' },
    },
    meta: {
      engineUsed,
      disposition: 'multi_commitment',
    },
  };
}

function recordClarificationFeedback(
  outcome: 'clarification_succeeded' | 'clarification_failed',
  options: CaptureServiceOptions,
  now: Date
): void {
  const hasScope = Boolean(options.conversationId || options.sessionId || options.userId);
  if (!hasScope && !options.pendingClarificationId) return;
  recordBehaviorFeedback(outcome, {
    now,
    feedbackStore: options.behaviorFeedbackStore,
    conversationId: options.conversationId,
    sessionId: options.sessionId,
    userId: options.userId,
  });
}

function safeExpiredClarificationResponse(): CaptureServiceResult {
  return safeNoOpResponse('That clarification expired or could not be found, so I did not make changes. Please send the full request again.');
}

function captureMeta(
  engineUsed: CaptureEngineUsed,
  disposition: CaptureDisposition,
  pending: PendingClarification | null = null
): CaptureServiceResult['meta'] {
  const meta: CaptureServiceResult['meta'] = { engineUsed, disposition };
  if (pending) {
    meta.pendingClarificationId = pending.id;
    meta.clarificationExpiresAt = pending.expiresAt;
    meta.clarificationScopeId = pending.scopeId;
  }
  return meta;
}

export function getPendingClarification(): PendingClarification | null {
  return null;
}

export function clearPendingClarification(): void {
  // Backward-compatible no-op. Clarifications are now scoped by token and store.
}

export function clearClarification(options: ClearClarificationOptions): void {
  const scopeId = scopeClarification(options);
  if (!scopeId) return;
  const store = options.clarificationStore || createDefaultClarificationStore();
  if (options.pendingClarificationId) {
    store.clear(scopeId, options.pendingClarificationId);
    return;
  }
  store.clearScope(scopeId);
}

export async function captureText(
  rawText: unknown,
  options: CaptureServiceOptions = {}
): Promise<CaptureServiceResult> {
  const text = normalizeInput(rawText);
  const now = options.now || new Date();
  const store = options.clarificationStore || createDefaultClarificationStore();
  const providedScopeId = scopeClarification(options);
  const ttlMs = options.clarificationTtlMs || DEFAULT_CLARIFICATION_TTL_MS;
  const context: ExtractionContext = {
    now,
    timezone: options.timezone || 'UTC',
    defaultReminderHour: options.defaultReminderHour,
  };
  const deterministicStateGateway = options.deterministicStateGateway || getDeterministicStateGateway();

  if (!text) {
    return {
      success: false,
      response: formatResponse({
        disposition: 'needs_clarification',
        result: { type: 'unknown', title: 'your message', missingFields: ['action'] },
        commands: [],
        commandResults: [],
        scopeId: responseScopeId(options),
        now,
      }),
      meta: {
        engineUsed: 'none',
        disposition: 'needs_clarification',
      },
    };
  }

  store.pruneExpired(now);

  let pending: PendingClarification | null = null;
  if (!options.pendingClarificationId) {
    const segments = splitMultiCommitmentInput(text);
    if (segments.length > 1) {
      return captureMultipleCommitments(segments, context, options);
    }
  }

  if (options.pendingClarificationId) {
    if (!providedScopeId) {
      recordClarificationFeedback('clarification_failed', options, now);
      return safeExpiredClarificationResponse();
    }
    pending = store.getAndClear(providedScopeId, options.pendingClarificationId, now);
    if (!pending) {
      recordClarificationFeedback('clarification_failed', options, now);
      return safeExpiredClarificationResponse();
    }
  }
  const isContinuation = Boolean(pending);
  let inputText = text;
  if (pending) {
    const merged = mergeClarificationInput(pending, text, context);
    if (merged.status === 'ambiguous') {
      recordClarificationFeedback('clarification_failed', options, now);
      const nextPending = store.create({
        scopeId: pending.scopeId,
        originalInput: pending.originalInput,
        partialExtraction: merged.result,
        now,
        ttlMs,
      });
      return {
        success: false,
        response: formatResponse({
          disposition: 'needs_clarification',
          result: merged.result,
          commands: [],
          commandResults: [],
          executionNotes: [`I could not apply that clarification safely. ${merged.reason}`],
          scopeId: responseScopeId(options),
          now,
        }),
        meta: captureMeta('none', 'needs_clarification', nextPending),
      };
    }
    inputText = merged.inputText;
  }

  let extracted: Awaited<ReturnType<typeof extractWithFallback>>;
  try {
    extracted = await extractWithFallback(inputText, context, { llmProvider: options.llmProvider });
  } catch {
    return safeNoOpResponse('I could not process this safely, so I did not make changes.');
  }

  let result: ExtractionResult;
  try {
    result = validateExtraction(extracted.result);
  } catch {
    return safeNoOpResponse('I could not validate the extracted request, so I did not make changes.');
  }

  const disposition = decideExtractionDisposition(result);
  let pendingClarification: PendingClarification | null = null;
  if (!pending && disposition === 'needs_clarification') {
    const scopeId = providedScopeId || `capture-${randomUUID()}`;
    pendingClarification = store.create({
      scopeId,
      originalInput: text,
      partialExtraction: result,
      now,
      ttlMs,
    });
  }

  const executionNotes: string[] = [];
  let commands: Command[] = [];

  try {
    commands = mapExtractionToCommand(result, context.now.toISOString());
  } catch {
    executionNotes.push('I skipped command execution because the request could not be converted safely.');
  }

  const unresolvedContinuation = isContinuation && disposition === 'needs_clarification';
  if (unresolvedContinuation) {
    recordClarificationFeedback('clarification_failed', options, now);
    executionNotes.push('I could not resolve the clarification safely, so I did not make changes.');
  }

  const commandsToExecute = shouldExecuteCommands(disposition) && !unresolvedContinuation ? commands : [];
  const commandResults = executeCommands(commandsToExecute, deterministicStateGateway);
  const hasExecutionProblem = executionNotes.length > 0 || hasRejectedCommand(commandResults);
  if (isContinuation && !unresolvedContinuation && !hasExecutionProblem) {
    recordClarificationFeedback('clarification_succeeded', options, now);
  }
  const formatDisposition: ResponseFormatterDisposition = unresolvedContinuation
    ? 'clarification_unresolved'
    : hasExecutionProblem
      ? 'command_error'
      : disposition;

  return {
    success: !hasExecutionProblem,
    response: formatResponse({
      result,
      disposition: formatDisposition,
      commands: commandsToExecute,
      commandResults,
      engine: extracted.engine,
      executionNotes,
      scopeId: responseScopeId(options),
      now,
    }),
    meta: captureMeta(extracted.engine, disposition, pendingClarification),
  };
}
