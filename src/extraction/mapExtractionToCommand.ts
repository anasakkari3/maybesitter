import { randomUUID } from 'crypto';
import type { Command, CommitmentKind, ReminderType } from '../domain/stateMachine';
import { decideExtractionDisposition } from './extractionPolicy';
import type { ExtractionResult } from './extractionTypes';

function kindFromExtraction(result: ExtractionResult): CommitmentKind {
  return result.type === 'follow_up' ? 'follow_up' : 'task';
}

function reminderTypeFromExtraction(result: ExtractionResult): ReminderType {
  return result.priority.level === 'high' ? 'due_soon' : 'check_in';
}

export function mapExtractionToCommand(result: ExtractionResult, now: string = new Date().toISOString()): Command[] {
  const disposition = decideExtractionDisposition(result);
  if (disposition === 'store_note') {
    return [];
  }

  const commitmentId = randomUUID();
  const title = result.title || result.action || result.rawText;
  const commitment = {
    id: commitmentId,
    kind: kindFromExtraction(result),
    title,
    description: null,
    person: result.person,
    priority: {
      level: result.priority.level,
      source: result.priority.source,
      pressureAllowed: false,
      pressureLevel: 'none' as const,
    },
    timeSpec: {
      kind: result.dueAt ? 'due_by' as const : 'unscheduled' as const,
      dueAt: result.dueAt,
      remindAt: result.remindAt,
      timezone: 'UTC',
    },
  };

  if (disposition === 'auto_confirm') {
    const reminderAt = result.remindAt || result.dueAt;
    if (!reminderAt) throw new Error('auto_confirm requires a reminder time');
    return [
      { type: 'CreateDraft', now, commitment, draftStatus: 'pending_confirmation' },
      {
        type: 'ConfirmCommitment',
        commitmentId,
        now,
        reminders: [{
          id: randomUUID(),
          reminderType: reminderTypeFromExtraction(result),
          scheduledFor: reminderAt,
          requiresAction: true,
        }],
      },
    ];
  }

  return [{
    type: 'CreateDraft',
    now,
    commitment,
    draftStatus:
      disposition === 'pending_confirmation'
        ? 'pending_confirmation'
        : disposition === 'needs_clarification'
          ? 'needs_clarification'
          : 'draft',
  }];
}
