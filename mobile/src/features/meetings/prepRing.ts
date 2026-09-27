/**
 * What rings for a prep step after the person changed it in Review
 * (post-UAT FX1, re-review Minor 5).
 *
 * Review's line about the prep step's reminder came from the prepare
 * response, which knows only the time the server proposed. Moved to another
 * time, made a Must, or left with no time, the step rings — or does not — at
 * a moment that response never described, and the line kept describing the
 * old one. This answers again for the step as it will be confirmed, with the
 * phone's own planning (`desiredRequests`) and the server's edit rule: before
 * the meeting's start it stays a window and rings its opening; at or after
 * it, it is an ordinary step (`windowEndAfterMove`); with no time, nothing.
 *
 * Pure, like `reminderPlan.ts`.
 */
import { desiredRequests } from '../reminders/reminderPlan';
import type { ReminderCommitment, ReminderPriority, ReminderSettings } from '../reminders/policy';
import type { QuietWindow } from '../reminders/quietHours';
import { EMPTY_AWARENESS } from '../../lib/deviceSettings/awareness';

export type PrepSilenceAfterEdit = 'no_time' | 'reminders_off' | 'silent_choice' | 'quiet_hours' | 'too_close';

export type PrepRingAfterEdit =
  | { readonly kind: 'rings'; readonly at: number }
  | { readonly kind: 'silent'; readonly because: PrepSilenceAfterEdit };

export interface PrepRingInput {
  /** The time the step will be confirmed at, or null for «بلا وقت». */
  readonly at: string | null;
  /** The meeting's start: the window's deadline. */
  readonly meetingStart: string;
  readonly priority: ReminderPriority;
  readonly settings: ReminderSettings;
  readonly quietHours: QuietWindow | null;
  readonly timeZone: string;
  readonly now: Date;
}

const COPY = { title: '', body: '' };

function firstRing(commitment: ReminderCommitment, input: PrepRingInput, quietHours: QuietWindow | null): number | null {
  const { desired } = desiredRequests({
    commitments: [commitment],
    now: input.now,
    settings: input.settings,
    quietHours,
    timeZone: input.timeZone,
    awareness: EMPTY_AWARENESS,
    copy: COPY,
    hardCopy: COPY,
    exactAlarms: true,
  });
  return desired.length === 0 ? null : Math.min(...desired.map((request) => request.at));
}

export function prepRingAfterEdit(input: PrepRingInput): PrepRingAfterEdit {
  if (!input.at) return { kind: 'silent', because: 'no_time' };
  const window = Date.parse(input.at) < Date.parse(input.meetingStart);
  const commitment: ReminderCommitment = {
    id: 'prep',
    startsAt: window ? input.meetingStart : input.at,
    ...(window ? { opensAt: input.at } : {}),
    status: 'active',
    priority: input.priority,
    allDay: false,
    postponedUntil: null,
  };
  const ring = firstRing(commitment, input, input.quietHours);
  if (ring !== null) return { kind: 'rings', at: ring };
  if (!input.settings.softEnabled) return { kind: 'silent', because: 'reminders_off' };
  if (input.settings.intensity === 'none') return { kind: 'silent', because: 'silent_choice' };
  return { kind: 'silent', because: firstRing(commitment, input, null) !== null ? 'quiet_hours' : 'too_close' };
}
