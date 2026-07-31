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
    'confidence',
    'missingFields',
    'ambiguityFlags',
    'explicitReminderRequest',
    'explicitPressureRequest',
  ],
} as const;
