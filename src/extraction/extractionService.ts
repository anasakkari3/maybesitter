import { extractWithOllama, type LLMProvider } from './ollamaExtractor';
import { extract as ruleBasedExtract } from './ruleBasedExtractor';
import { decideExtractionDisposition } from './extractionPolicy';
import { mapExtractionToCommand } from './mapExtractionToCommand';
import type { Command } from '../domain/stateMachine';
import type { ExtractionContext, ExtractionDisposition, ExtractionResult } from './extractionTypes';

export type ExtractionEngine = 'ollama' | 'rule-based';

export interface ExtractAndMapOptions {
  llmProvider?: LLMProvider;
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
  let result: ExtractionResult;
  let engine: ExtractionEngine = 'ollama';
  let fallbackReason: string | null = null;

  try {
    result = await extractWithOllama(rawText, context, options.llmProvider);
  } catch (error) {
    fallbackReason = fallbackReasonFrom(error);
    result = ruleBasedExtract(rawText, context);
    engine = 'rule-based';
  }

  return {
    result,
    engine,
    fallbackReason,
  };
}
