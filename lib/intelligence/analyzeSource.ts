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
      maxOutputTokens: 1_024,
      timeoutMs: 8_000,
      retry: false,
    });
    observations = validateSemanticObservations(JSON.parse(response.text), content);
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
