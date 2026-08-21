import { extractWithOllama, type LLMProviderFunction } from './ollamaExtractor';
import { screenForInjection } from './injectionBoundary';
import { extract as ruleBasedExtract } from './ruleBasedExtractor';
import { decideExtractionDisposition } from './extractionPolicy';
import { decideEscalation, type EscalationReason } from './escalationGate';
import { ARBITRATION_UNAVAILABLE, type ArbiterFunction, type ArbitrationVerdict } from './arbiter';
import { mapExtractionToCommand } from './mapExtractionToCommand';
import type { Command } from '../domain/stateMachine';
import type { ExtractionContext, ExtractionDisposition, ExtractionResult } from './extractionTypes';

export type ExtractionEngine = 'ollama' | 'rule-based';

export interface ExtractAndMapOptions {
  llmProvider?: LLMProviderFunction;
  /** Absent means never escalate -- the local model's answer stands. */
  arbiter?: ArbiterFunction;
}

export interface ExtractionEscalation {
  /**
   * True only when a second opinion was actually obtained. A gate that fired
   * without an arbiter configured, and a call that timed out or threw, both
   * leave this false while `reasons` still records the doubt.
   */
  escalated: boolean;
  reasons: EscalationReason[];
  verdict: ArbitrationVerdict | null;
}

export interface ExtractAndMapResult {
  result: ExtractionResult;
  disposition: ExtractionDisposition;
  commands: Command[];
  engine: ExtractionEngine;
  fallbackReason: string | null;
  escalation: ExtractionEscalation;
}

export interface ExtractWithFallbackResult {
  result: ExtractionResult;
  engine: ExtractionEngine;
  fallbackReason: string | null;
}

function fallbackReasonFrom(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function safeNegativeResult(rawText: string, type: 'unknown' | 'informational_context'): ExtractionResult {
  return {
    type,
    action: null,
    title: null,
    person: null,
    dueAt: null,
    remindAt: null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    confidence: { overall: 0.99, type: 0.99, action: 0.8, time: 0.9, priority: 0.92 },
    missingFields: ['action'],
    ambiguityFlags: type === 'informational_context' ? ['informational_without_action'] : ['vague_action'],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
    rawText,
    parserVersion: 'semantic-safety-v1',
  };
}

/**
 * Decide whether this capture deserves a second opinion, and get one if so.
 *
 * The local model handles the volume; the frontier model is asked only about
 * the captures the gate says are doubtful. Its answer is recorded, never
 * applied -- a correction the user has not seen must not silently replace
 * what they said.
 */
async function arbitrate(
  rawText: string,
  extracted: ExtractWithFallbackResult,
  arbiter: ArbiterFunction | undefined
): Promise<ExtractionEscalation> {
  // A capture the screen already refused must not become a second model call.
  // The arbiter screens too, but a caller-supplied one is not obliged to.
  if (extracted.fallbackReason?.startsWith('prompt_injection:')) {
    return { escalated: false, reasons: [], verdict: null };
  }

  const gate = decideEscalation(extracted.result, rawText);
  if (!gate.escalate || !arbiter) {
    return { escalated: false, reasons: gate.reasons, verdict: null };
  }

  let verdict: ArbitrationVerdict;
  try {
    verdict = await arbiter(rawText, extracted.result);
  } catch {
    // The remote model is an improvement, never a dependency.
    verdict = ARBITRATION_UNAVAILABLE;
  }

  return {
    // A refusal, a timeout or a throw yields a verdict object but no second
    // opinion. Counting those as escalated would report a capture as checked
    // when nothing checked it.
    escalated: verdict.outcome !== 'unavailable',
    reasons: gate.reasons,
    verdict,
  };
}

export async function extractAndMap(
  rawText: string,
  context: ExtractionContext,
  options: ExtractAndMapOptions = {}
): Promise<ExtractAndMapResult> {
  const extracted = await extractWithFallback(rawText, context, options);
  const escalation = await arbitrate(rawText, extracted, options.arbiter);
  const disposition = decideExtractionDisposition(extracted.result);
  const commands = mapExtractionToCommand(extracted.result, context.now.toISOString());

  return {
    ...extracted,
    disposition,
    commands,
    escalation,
  };
}

export async function extractWithFallback(
  rawText: string,
  context: ExtractionContext,
  options: ExtractAndMapOptions = {}
): Promise<ExtractWithFallbackResult> {
  const injection = screenForInjection(rawText);
  if (injection) {
    return { result: safeNegativeResult(rawText, 'unknown'), engine: 'rule-based', fallbackReason: `prompt_injection:${injection}` };
  }
  const past = /\b(yesterday|last night|last week|earlier)\b|مبارح|أمس|امبارح|אתמול|בשבוע שעבר/i.test(rawText);
  const request = /\b(remind|add|create|schedule|please|need to|must|tomorrow)\b|ذكرني|ضيف|أضف|لازم|بكرا|תזכיר|תוסיף|צריך|מחר/i.test(rawText);
  if (past && !request) {
    return { result: safeNegativeResult(rawText, 'informational_context'), engine: 'rule-based', fallbackReason: 'semantic_safety:past_no_action' };
  }
  let result: ExtractionResult;
  let engine: ExtractionEngine = 'ollama';
  let fallbackReason: string | null = null;

  try {
    result = await extractWithOllama(rawText, context, { provider: options.llmProvider });
  } catch (error) {
    fallbackReason = fallbackReasonFrom(error);
    result = ruleBasedExtract(rawText, context);
    engine = 'rule-based';
  }
  if (/תזכיר\s+לי/.test(rawText) && result.type === 'task') {
    result = { ...result, explicitReminderRequest: true };
  }

  return {
    result,
    engine,
    fallbackReason,
  };
}
