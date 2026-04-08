import { createAssistantTurn, type AssistantTurn } from './responseEngine/assistantTurn';
import { semanticEventFromFormatterInput } from './responseEngine/semanticEvent';

export type ResponseFormatterDisposition =
  | 'auto_confirm'
  | 'pending_confirmation'
  | 'needs_clarification'
  | 'store_note'
  | 'no_op'
  | 'informational'
  | string;

export type ResponseFormatterNextStepType = 'none' | 'confirm' | 'clarify' | 'review';

export interface ResponseFormatterNextStep {
  type: ResponseFormatterNextStepType;
  message: string;
}

export interface FormattedResponse {
  message: string;
  interpretation: string;
  actions: string[];
  nextStep: ResponseFormatterNextStep;
  assistantTurn?: AssistantTurn;
}

export interface ResponseFormatterExtractionResult {
  type?: string | null;
  action?: string | null;
  title?: string | null;
  person?: string | null;
  dueAt?: string | null;
  remindAt?: string | null;
  missingFields?: readonly string[];
  ambiguityFlags?: readonly string[];
}

export interface ResponseFormatterCommand {
  type?: string;
  postponedUntil?: string | null;
  commitment?: {
    title?: string | null;
  };
  updates?: {
    title?: string | null;
    timeSpec?: {
      dueAt?: string | null;
      remindAt?: string | null;
    };
  };
  reminders?: readonly unknown[];
}

export interface ResponseFormatterCommandResult {
  result?: string;
  status?: string;
  didChange?: boolean;
}

export interface FormatResponseInput {
  result?: ResponseFormatterExtractionResult | null;
  extractionResult?: ResponseFormatterExtractionResult | null;
  disposition: ResponseFormatterDisposition;
  commands?: readonly ResponseFormatterCommand[];
  commandResults?: readonly ResponseFormatterCommandResult[];
  engine?: string;
  executionNotes?: readonly string[];
  scopeId?: string;
  now?: Date;
}

function nextStepTypeFor(turn: AssistantTurn): ResponseFormatterNextStepType {
  if (turn.ui.expectedUserAction === 'clarify') return 'clarify';
  if (turn.ui.expectedUserAction === 'confirm') return 'confirm';
  if (turn.ui.expectedUserAction === 'choose') return 'review';
  return 'none';
}

export function formatResponse(input: FormatResponseInput): FormattedResponse {
  const turn = createAssistantTurn({
    event: semanticEventFromFormatterInput(input),
    scopeId: input.scopeId,
    now: input.now,
  });

  return {
    message: turn.message,
    interpretation: '',
    actions: [],
    nextStep: {
      type: nextStepTypeFor(turn),
      message: turn.ui.expectedUserAction === 'none' ? '' : turn.message,
    },
    assistantTurn: turn,
  };
}
