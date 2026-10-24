import { toVertexSchema } from '../../src/extraction/llm';
import { detectPromptInjection } from '../../src/extraction/ollamaExtractor';
import { shareLlmProvider, type ShareStructuredGenerator } from '../llm/shareProvider';
import { wrapUntrustedShared } from '../services/share/shareTypes';
import { putObservations, type ObservationSource, type StoredObservation } from './observationStore';
import type { StorageAdapter } from '../storage';
import { semanticFallback, semanticPrompt, validateSemanticObservations, type SemanticObservation } from './semantic';

const SCHEMA = {
  type: 'object',
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['goal', 'intention', 'request', 'event', 'commitment', 'preference', 'constraint', 'opportunity', 'outcome'] },
          evidence: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['kind', 'evidence', 'confidence'],
      },
    },
  },
  required: ['observations'],
} as const;

/**
 * Room for the answer. At 1,024 a long e-mail's answer was cut mid-JSON
 * (1,012 output tokens, staging 2026-10-24): the parse failed, the scan
 * stopped, and every resume retried the same message the same way.
 */
export const SEMANTIC_MAX_OUTPUT_TOKENS = 2_048;

/**
 * The model's answer, read as far as it is whole. A reply cut at the output
 * cap (a MAX_TOKENS finish) still holds every observation before the cut:
 * those are kept, the half-written one is not, and each still has to quote
 * the source verbatim in `validateSemanticObservations`. Nothing whole → the
 * same failure as before.
 */
export function parseObservationsAnswer(text: string): unknown {
  try { return JSON.parse(text); } catch { /* cut short: salvage below */ }
  const start = text.indexOf('[', text.indexOf('"observations"'));
  if (start < 0) throw new Error('source_answer_unreadable');
  const whole: unknown[] = [];
  let depth = 0; let inString = false; let escaped = false; let objectStart = -1;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') { if (depth === 0) objectStart = index; depth += 1; }
    else if (char === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        try { whole.push(JSON.parse(text.slice(objectStart, index + 1))); } catch { /* skip a malformed one */ }
        objectStart = -1;
      }
    } else if (char === ']' && depth === 0) break;
  }
  if (whole.length === 0) throw new Error('source_answer_unreadable');
  return { observations: whole };
}

/** A bounded read. The source text itself is never persisted or logged. */
export async function analyzeSource(
  uid: string,
  source: ObservationSource,
  sourceRef: string,
  text: string,
  observedAt: string,
  options: { generate?: ShareStructuredGenerator; fallbackForManual?: boolean; storage?: StorageAdapter;
    monitorGuard?: { path: string; generation: string } } = {},
): Promise<StoredObservation[]> {
  const content = text.trim();
  if (!content || content.length > 12_000) throw new Error('source_text_invalid');
  let observations: SemanticObservation[] = [];
  try {
    const generate = options.generate ?? shareLlmProvider(uid, { purpose: 'semantic_observation' });
    const response = await generate({
      system: semanticPrompt(),
      parts: [wrapUntrustedShared(content)],
      responseSchema: toVertexSchema(SCHEMA),
      maxOutputTokens: SEMANTIC_MAX_OUTPUT_TOKENS,
      timeoutMs: 8_000,
      retry: false,
    });
    observations = validateSemanticObservations(parseObservationsAnswer(response.text), content);
  } catch {
    // Consent, cost cap and provider failures do not authorize guessing from
    // somebody else's mailbox. Their own sentence can be retained as a draft.
    if (source !== 'manual') throw new Error('source_analysis_failed');
  }
  if (observations.length === 0 && source === 'manual' && options.fallbackForManual !== false) {
    observations = semanticFallback(content);
  }
  return putObservations(uid, source, sourceRef, observedAt,
    observations.filter(item => detectPromptInjection(item.evidence) === null), options.storage, options.monitorGuard);
}

/** The M5a unit keeps validated observations in memory until its fenced commit. */
export async function analyzeSourceStaged(
  uid: string,
  source: ObservationSource,
  text: string,
  options: { generate?: ShareStructuredGenerator } = {},
): Promise<SemanticObservation[]> {
  const content = text.trim();
  if (!content || content.length > 12_000) throw new Error('source_text_invalid');
  try {
    const generate = options.generate ?? shareLlmProvider(uid, { purpose: 'semantic_observation' });
    const response = await generate({
      system: semanticPrompt(),
      parts: [wrapUntrustedShared(content)],
      responseSchema: toVertexSchema(SCHEMA),
      maxOutputTokens: SEMANTIC_MAX_OUTPUT_TOKENS,
      timeoutMs: 8_000,
      retry: false,
    });
    return validateSemanticObservations(parseObservationsAnswer(response.text), content)
      .filter(item => detectPromptInjection(item.evidence) === null);
  } catch {
    if (source !== 'manual') throw new Error('source_analysis_failed');
    return [];
  }
}
