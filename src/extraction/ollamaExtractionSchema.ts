import { toVertexSchema } from './llm/vertexSchema';
import { COMMITMENT_CATEGORIES } from '../contracts/v1/categoryContracts';

/**
 * Native Ollama structured-output schema for the production ExtractionResult.
 * Keep this aligned with schemaValidator.ts.
 */
export const OLLAMA_EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: {
      type: 'string',
      enum: ['task', 'follow_up', 'informational_context', 'unknown'],
    },
    action: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    person: { type: ['string', 'null'] },
    dueAt: {
      type: ['string', 'null'],
      description: 'ISO 8601 datetime including timezone, or null when absent.',
    },
    remindAt: {
      type: ['string', 'null'],
      description: 'ISO 8601 datetime including timezone, or null when absent.',
    },
    localTimeSpec: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        date: { type: 'string' },
        time: { type: 'string' },
        timezone: { type: 'string' },
      },
      required: ['date', 'time', 'timezone'],
    },
    priority: {
      type: 'object',
      additionalProperties: false,
      properties: {
        level: { type: 'string', enum: ['low', 'normal', 'high'] },
        source: { type: 'string', enum: ['default', 'inferred', 'user_explicit'] },
        pressureAllowed: { const: false },
        pressureImplied: { type: 'boolean' },
      },
      required: ['level', 'source', 'pressureAllowed', 'pressureImplied'],
    },
    flexibility: { type: 'string', enum: ['movable', 'soft'] },
    category: {
      type: ['string', 'null'],
      enum: COMMITMENT_CATEGORIES,
      description:
        'Which part of the user\'s life this belongs to, or null when the text does not say. Guessing from the topic alone is worse than null.',
    },
    categoryConfidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'How sure the category is. The app drops anything it is not sure enough about.',
    },
    confidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        overall: { type: 'number', minimum: 0, maximum: 1 },
        type: { type: 'number', minimum: 0, maximum: 1 },
        action: { type: 'number', minimum: 0, maximum: 1 },
        time: { type: 'number', minimum: 0, maximum: 1 },
        priority: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['overall', 'type', 'action', 'time', 'priority'],
    },
    missingFields: {
      type: 'array',
      items: { type: 'string', enum: ['action', 'time', 'person', 'commitment_strength'] },
    },
    ambiguityFlags: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'multiple_commitments',
          'vague_time',
          'vague_action',
          'weak_commitment_language',
          'informational_without_action',
          'contradictory_time',
          'negated_request',
          'no_action_verb',
        ],
      },
    },
    explicitReminderRequest: { type: 'boolean' },
    explicitPressureRequest: { type: 'boolean' },
  },
  required: [
    'type',
    'action',
    'title',
    'person',
    'dueAt',
    'remindAt',
    'localTimeSpec',
    'priority',
    'flexibility',
    'category',
    'categoryConfidence',
    'confidence',
    'missingFields',
    'ambiguityFlags',
    'explicitReminderRequest',
    'explicitPressureRequest',
  ],
} as const;

/**
 * The same schema in the dialect Vertex accepts (UC-2.0, #160).
 *
 * Derived, not written out again: two hand-kept copies drift the first time a
 * field is added, and the drift is silent — the model would be asked for a
 * shape the validator does not expect, and every capture would fall back to
 * rules while looking configured.
 */
export const GEMINI_EXTRACTION_SCHEMA = toVertexSchema(OLLAMA_EXTRACTION_SCHEMA);

/** `{"items":[…]}`: one extraction object per clause of a capture (CL1, I4). */
export const GEMINI_BATCH_EXTRACTION_SCHEMA = toVertexSchema({
  type: 'object',
  properties: { items: { type: 'array', items: OLLAMA_EXTRACTION_SCHEMA } },
  required: ['items'],
});
