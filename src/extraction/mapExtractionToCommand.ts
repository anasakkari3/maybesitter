import { randomUUID } from 'crypto';
import type { Command, CommitmentKind, ReminderType } from '../domain/stateMachine';
import { decideExtractionDisposition } from './extractionPolicy';
import type { ExtractionResult } from './extractionTypes';
import {
  DEFAULT_CATEGORY_PREFERENCES,
  resolveCategory,
  type CommitmentCategoryPreferences,
} from '../contracts/v1/categoryContracts';

function kindFromExtraction(result: ExtractionResult): CommitmentKind {
  return result.type === 'follow_up' ? 'follow_up' : 'task';
}

function reminderTypeFromExtraction(result: ExtractionResult): ReminderType {
  return result.priority.level === 'high' ? 'due_soon' : 'check_in';
}

/**
 * Turns what was read into commands, against what this user uses (#415).
 *
 * `categoryPreferences` defaults to the whole catalog, which is the most
 * permissive reading and therefore the one that is wrong in the least harmful
 * direction: a caller that forgets to pass the user's preference files a
 * commitment under a category the user had turned off, and the only visible
 * consequence is that the commitment shows up under "All" and nowhere else —
 * which is where it would have been anyway. The alternative default, an empty
 * set, would silently stop categorising for every caller that forgot, and that
 * failure looks exactly like a model that never answers.
 */
export function mapExtractionToCommand(
  result: ExtractionResult,
  now: string = new Date().toISOString(),
  categoryPreferences: CommitmentCategoryPreferences = DEFAULT_CATEGORY_PREFERENCES,
): Command[] {
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
    category: resolveCategory(result.category, result.categoryConfidence, categoryPreferences),
    timeSpec: {
      // «أشتري دوا … الساعة 5» is to be done at 17:00, not by it (CL1, D2).
      // Written as a `due_by`, the planner floated it ahead as a deadline and
      // placed it at 15:30; a `scheduled_event` is one it keeps where it is.
      kind: !result.dueAt
        ? 'unscheduled' as const
        : result.timeAnchor === 'event' ? 'scheduled_event' as const : 'due_by' as const,
      dueAt: result.dueAt,
      remindAt: result.remindAt,
      // The zone the extractor resolved the instant in (#501). When there was
      // no time to resolve there is no zone to record either, and 'UTC' is the
      // only honest label for a commitment that names no instant.
      timezone: result.localTimeSpec?.timezone || 'UTC',
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
