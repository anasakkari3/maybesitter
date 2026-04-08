import { callOllama } from './localLLMProvider';
import { validateExtractionResult } from './schemaValidator';
import type { ExtractionContext, ExtractionResult } from './extractionTypes';

export type LLMProvider = (prompt: string) => Promise<string>;

function buildPrompt(rawText: string, context: ExtractionContext): string {
  return [
    'You are Maybesitter local extraction engine.',
    'Return only one JSON object. No markdown. No prose.',
    'Allowed type values: task, follow_up, informational_context, unknown.',
    'Allowed missingFields values: action, time, person, commitment_strength.',
    'Allowed ambiguityFlags values: multiple_commitments, vague_time, vague_action, weak_commitment_language, informational_without_action, contradictory_time, negated_request.',
    'pressureAllowed must always be false.',
    'If the user says do not remind, don\'t remind, not remind, or remind me not, set explicitReminderRequest false and include negated_request.',
    'For informational context with no direct action, use type informational_context.',
    'Use ISO strings for dueAt and remindAt, or null.',
    `Current time: ${context.now.toISOString()}`,
    `Timezone: ${context.timezone || 'UTC'}`,
    'Schema:',
    JSON.stringify({
      type: 'task',
      action: 'string|null',
      title: 'string|null',
      person: 'string|null',
      dueAt: 'ISO|null',
      remindAt: 'ISO|null',
      priority: {
        level: 'low|normal|high',
        source: 'default|inferred|user_explicit',
        pressureAllowed: false,
        pressureImplied: false,
      },
      flexibility: 'movable|soft',
      confidence: {
        overall: 0,
        type: 0,
        action: 0,
        time: 0,
        priority: 0,
      },
      missingFields: [],
      ambiguityFlags: [],
      explicitReminderRequest: false,
      explicitPressureRequest: false,
    }),
    `User input: ${JSON.stringify(rawText)}`,
  ].join('\n');
}

function parseJsonObject(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new Error('LLM output is not valid JSON');
    return JSON.parse(raw.slice(start, end + 1));
  }
}

export async function extractWithOllama(
  rawText: string,
  context: ExtractionContext,
  provider: LLMProvider = callOllama
): Promise<ExtractionResult> {
  const prompt = buildPrompt(rawText, context);
  const response = await provider(prompt);
  const parsed = parseJsonObject(response);
  return validateExtractionResult(parsed, rawText);
}
