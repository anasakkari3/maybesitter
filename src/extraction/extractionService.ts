import { detectPromptInjection, extractWithOllama, type LLMProviderFunction } from './ollamaExtractor';
import { extract as ruleBasedExtract } from './ruleBasedExtractor';
import { decideExtractionDisposition } from './extractionPolicy';
import { mapExtractionToCommand } from './mapExtractionToCommand';
import type { Command } from '../domain/stateMachine';
import type { ExtractionContext, ExtractionDisposition, ExtractionResult } from './extractionTypes';

export type ExtractionEngine = 'ollama' | 'rule-based';

export interface ExtractAndMapOptions {
  llmProvider?: LLMProviderFunction;
}

export interface ExtractAndMapResult {
  result: ExtractionResult;
  disposition: ExtractionDisposition;
  commands: Command[];
  engine: ExtractionEngine;
  fallbackReason: string | null;
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

export async function extractAndMap(
  rawText: string,
  context: ExtractionContext,
  options: ExtractAndMapOptions = {}
): Promise<ExtractAndMapResult> {
  const extracted = await extractWithFallback(rawText, context, options);
  const disposition = decideExtractionDisposition(extracted.result);
  const commands = mapExtractionToCommand(extracted.result, context.now.toISOString());

  return {
    ...extracted,
    disposition,
    commands,
  };
}

export async function extractWithFallback(
  rawText: string,
  context: ExtractionContext,
  options: ExtractAndMapOptions = {}
): Promise<ExtractWithFallbackResult> {
  const injection = detectPromptInjection(rawText);
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
