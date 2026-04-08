import type { SemanticEvent } from './assistantTurn';

type FormatterExtractionResult = {
  type?: string | null;
  action?: string | null;
  title?: string | null;
  dueAt?: string | null;
  remindAt?: string | null;
  missingFields?: readonly string[];
  ambiguityFlags?: readonly string[];
};

type FormatterCommand = {
  type?: string;
  postponedUntil?: string | null;
  commitment?: { title?: string | null };
  updates?: {
    title?: string | null;
    timeSpec?: { dueAt?: string | null; remindAt?: string | null };
  };
  reminders?: readonly unknown[];
};

type FormatterCommandResult = {
  result?: string;
  status?: string;
  didChange?: boolean;
};

export type FormatterEventInput = {
  result?: FormatterExtractionResult | null;
  extractionResult?: FormatterExtractionResult | null;
  disposition: string;
  commands?: readonly FormatterCommand[];
  commandResults?: readonly FormatterCommandResult[];
  executionNotes?: readonly string[];
};

function textOrNull(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (/```|^\s*[{[]|"\s*type\s*"\s*:|"\s*confidence\s*"\s*:|\brawText\b/i.test(text)) return undefined;
  return text.length > 90 ? `${text.slice(0, 87).trim()}...` : text;
}

function resultFrom(input: FormatterEventInput): FormatterExtractionResult | null | undefined {
  return input.result || input.extractionResult;
}

function isExecuted(result: FormatterCommandResult | undefined): boolean {
  if (!result) return false;
  return result.result === 'applied' || result.status === 'applied' || result.didChange === true;
}

function executedCommands(input: FormatterEventInput): FormatterCommand[] {
  const commands = input.commands || [];
  const commandResults = input.commandResults || [];
  return commands.filter((_command, index) => isExecuted(commandResults[index]));
}

function primaryExecutedCommand(commands: readonly FormatterCommand[]): FormatterCommand | null {
  const priority = ['Drop', 'Complete', 'Postpone', 'MarkAware', 'UpdateCommitment', 'ConfirmCommitment', 'CreateDraft'];
  for (const type of priority) {
    const command = [...commands].reverse().find((item) => item.type === type);
    if (command) return command;
  }
  return commands[commands.length - 1] || null;
}

function commandTitle(command: FormatterCommand | null | undefined, result: FormatterExtractionResult | null | undefined): string | undefined {
  return textOrNull(command?.commitment?.title) ||
    textOrNull(command?.updates?.title) ||
    textOrNull(result?.title) ||
    textOrNull(result?.action);
}

function missingDetail(result: FormatterExtractionResult | null | undefined): Extract<SemanticEvent, { type: 'needs_clarification' }>['missing'] {
  const fields = result?.missingFields || [];
  const flags = result?.ambiguityFlags || [];
  if (fields.includes('time') || flags.includes('vague_time') || flags.includes('contradictory_time')) return 'time';
  if (fields.includes('action') || flags.includes('vague_action')) return 'action';
  if (fields.includes('person')) return 'person';
  return 'unknown';
}

export function semanticEventFromFormatterInput(input: FormatterEventInput): SemanticEvent {
  const result = resultFrom(input);
  const executed = executedCommands(input);
  const primary = primaryExecutedCommand(executed);
  const title = commandTitle(primary, result);
  const confirmedInSameFlow = executed.some((item) => item.type === 'ConfirmCommitment');
  const notes = (input.executionNotes || []).join(' ');

  if ((input.commandResults || []).some((item) => item?.result === 'rejected' || item?.status === 'rejected')) {
    return { type: 'informational_no_change', title, reason: 'unsafe' };
  }

  if (/expired|could not be found/i.test(notes)) {
    return { type: 'informational_no_change', title, reason: 'expired' };
  }

  if (input.disposition === 'needs_clarification' || input.disposition === 'clarification_unresolved') {
    return { type: 'needs_clarification', missing: missingDetail(result), title, remindAt: result?.remindAt, dueAt: result?.dueAt };
  }

  if (/safe|safely/i.test(notes)) {
    return { type: 'informational_no_change', title, reason: 'unsafe' };
  }

  if (input.disposition === 'store_note' || input.disposition === 'informational' || result?.type === 'informational_context') {
    return { type: 'informational_no_change', title, reason: 'informational' };
  }

  if (input.disposition === 'no_op' || input.disposition === 'command_error') {
    return { type: 'informational_no_change', title, reason: input.disposition === 'command_error' ? 'unsafe' : 'ambiguous' };
  }

  switch (primary?.type) {
    case 'Drop':
      return { type: 'commitment_cancelled', title };
    case 'Complete':
      return { type: 'commitment_completed', title, confirmedInSameFlow };
    case 'Postpone':
      return { type: 'commitment_moved', title, movedTo: primary.postponedUntil, confirmedInSameFlow };
    case 'MarkAware':
      return { type: 'commitment_acknowledged', title };
    case 'UpdateCommitment':
      return { type: 'commitment_updated', title, time: primary.updates?.timeSpec?.remindAt || primary.updates?.timeSpec?.dueAt || null };
    case 'ConfirmCommitment':
      return { type: 'reminder_created', title, remindAt: result?.remindAt, dueAt: result?.dueAt };
    case 'CreateDraft':
      return { type: 'confirmation_needed', title };
    default:
      if (input.disposition === 'pending_confirmation') return { type: 'confirmation_needed', title };
      if (input.disposition === 'auto_confirm' && executed.length > 0) {
        return { type: 'reminder_created', title, remindAt: result?.remindAt, dueAt: result?.dueAt };
      }
      return { type: 'informational_no_change', title, reason: 'ambiguous' };
  }
}
