export type ExtractionType = 'task' | 'follow_up' | 'informational_context' | 'unknown';

export type MissingField = 'action' | 'time' | 'person' | 'commitment_strength';

export type AmbiguityFlag =
  | 'multiple_commitments'
  | 'vague_time'
  | 'vague_action'
  | 'weak_commitment_language'
  | 'informational_without_action'
  | 'contradictory_time'
  | 'negated_request';

export interface ExtractionResult {
  type: ExtractionType;
  action: string | null;
  title: string | null;
  person: string | null;
  dueAt: string | null;
  remindAt: string | null;
  priority: {
    level: 'low' | 'normal' | 'high';
    source: 'default' | 'inferred' | 'user_explicit';
    pressureAllowed: boolean;
    pressureImplied: boolean;
  };
  flexibility: 'movable' | 'soft';
  confidence: {
    overall: number;
    type: number;
    action: number;
    time: number;
    priority: number;
  };
  missingFields: MissingField[];
  ambiguityFlags: AmbiguityFlag[];
  explicitReminderRequest: boolean;
  explicitPressureRequest: boolean;
  rawText: string;
  parserVersion: string;
}

export interface ExtractionContext {
  now: Date;
  timezone?: string;
  defaultReminderHour?: number;
}

export type ExtractionDisposition = 'auto_confirm' | 'pending_confirmation' | 'needs_clarification' | 'store_note';
