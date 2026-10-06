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
    kind: {
      type: 'string',
      enum: ['commitment', 'possible_goal', 'consideration', 'idea', 'waiting_for'],
      description: 'What the person expressed. Only commitment is a proposed commitment item.',
    },
    type: {
      type: 'string',
      enum: ['task', 'follow_up', 'informational_context', 'unknown'],
    },
    action: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    /*
     * The title in the app's language (owner request 2026-09-30). Optional:
     * asked for only when the request named the app's language, and a model
     * that leaves it out loses nothing but the translation — `title`, in the
     * person's own words, is what every check reads.
     */
    appTitle: {
      type: ['string', 'null'],
      description: 'The same title in the app language named by the rules; null when title is null or no app language is named.',
    },
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
    'kind',
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

/**
 * `{"items":[…]}`: one extraction object per clause of a capture (CL1, I4),
 * each echoing the 0-based position of the clause it reads (CL1 round 4, N2)
 * — the boundary pairs an object with a clause only when the two agree.
 */
export const GEMINI_BATCH_EXTRACTION_SCHEMA = toVertexSchema({
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          clauseIndex: { type: 'integer', minimum: 0, description: 'The 0-based position, in the array of clauses, of the clause this object reads.' },
          ...OLLAMA_EXTRACTION_SCHEMA.properties,
        },
        required: ['clauseIndex', ...OLLAMA_EXTRACTION_SCHEMA.required],
      },
    },
  },
  required: ['items'],
});

/** What one capture-chat turn asks the model to do (owner decision 2026-09-30). */
export const CAPTURE_CHAT_ACTIONS = ['propose', 'update', 'ask', 'chat'] as const;
export type CaptureChatAction = (typeof CAPTURE_CHAT_ACTIONS)[number];

/**
 * The ref-constrained capture-chat response schema for one turn (M2b v9).
 * Empty ref sets use an impossible sentinel because Vertex does not accept an
 * empty enum; the parser still rejects the sentinel if a model invents it.
 */
export function geminiChatSchemaFor(lockedRefs: readonly string[], openRefs: readonly string[]): Record<string, unknown> {
  const refs = (values: readonly string[]) => values.length > 0 ? values : ['__no_ref__'];
  const citedExtraction = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...OLLAMA_EXTRACTION_SCHEMA.properties,
      source: {
        type: 'string',
        description: 'Exact words from the newest user message that support this new point.',
      },
    },
    required: [...OLLAMA_EXTRACTION_SCHEMA.required],
  } as const;
  return toVertexSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      reply: { type: 'string', description: 'One short message to the person, in the reply language the rules name. Never says anything was saved.' },
      action: { type: 'string', enum: CAPTURE_CHAT_ACTIONS },
      locked: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref: { type: 'string', enum: refs(lockedRefs) },
            op: { type: 'string', enum: ['keep', 'remove'] },
            source: {
              type: 'string',
              description: 'Optional exact words from the newest user message that support removing this point.',
            },
          },
          required: ['ref', 'op'],
        },
      },
      open: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref: { type: 'string', enum: refs(openRefs) },
            op: { type: 'string', enum: ['keep', 'update', 'remove'] },
            fields: OLLAMA_EXTRACTION_SCHEMA,
            source: {
              type: 'string',
              description: 'Exact words from the newest user message that support this update, or optional support for a removal.',
            },
          },
          required: ['ref', 'op'],
        },
      },
      added: { type: 'array', items: citedExtraction },
    },
    required: ['reply', 'action', 'locked', 'open', 'added'],
  });
}

/** Initial-turn/default schema retained for callers that do not yet have refs. */
export const GEMINI_CHAT_SCHEMA = geminiChatSchemaFor([], []);
