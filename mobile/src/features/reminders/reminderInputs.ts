/**
 * Turning what the API returns into what the engine takes (UC-3.11, #196).
 *
 * The narrowing is the point. `Commitment` carries a title, a description and
 * a person; `ReminderCommitment` carries an id, an instant and a status. The
 * engine is therefore structurally incapable of putting a commitment's words
 * into a notification payload, which is the rule the Flutter client kept by
 * convention (`notification_payload.dart:8-13`) and this keeps by type.
 *
 * Pure, like `reminderPlan.ts`: the server's meeting-prep tests load both where
 * only the root packages are installed, so a schema is imported as a type only.
 */
import type { Commitment } from '../../api/schemas/common';
import { importanceOf } from '../../api/schemas/importance';
import type { ReminderSettingsDto } from '../../api/schemas/reminders';
import {
  legacyEscalation,
  type ReminderIntensity,
  type ReminderCommitment,
  type ReminderSettings,
} from './policy';
import type { QuietWindow } from './quietHours';

/**
 * The instant a commitment happens at, or null.
 *
 * `timeSpec.dueAt` and not `remindAt`: `remindAt` is a reminder the server
 * already derived, and scheduling a stage relative to it would apply the lead
 * twice.
 *
 * One exception, the server's `isTimedWindow` / `deadlineOfTimeSpec` line for
 * line: a timed `due_by` with an end is a window, done *by* its end. A
 * meeting's prep step is shown at 14:00 and done by the 15:00 start, so its
 * start here is 15:00 and it opens at 14:00 (`opensAtOf`), where the gentle
 * stage rings whatever the lead (post-UAT FX1, ruling R1).
 */
export function startOf(commitment: Commitment): string | null {
  return isWindow(commitment) ? commitment.timeSpec.endAt : commitment.timeSpec.dueAt;
}

/** When a window opens — the time every screen shows — or null for anything else. */
export function opensAtOf(commitment: Commitment): string | null {
  return isWindow(commitment) ? commitment.timeSpec.dueAt : null;
}

function isWindow(commitment: Commitment): boolean {
  const { kind, dueAt, endAt, allDay } = commitment.timeSpec;
  return kind === 'due_by' && !allDay && !!dueAt && !!endAt;
}

export function toReminderCommitments(items: readonly Commitment[]): ReminderCommitment[] {
  return items.map((commitment) => ({
    id: commitment.id,
    startsAt: startOf(commitment),
    status: commitment.status,
    // The design's Must / Should / Nice, from the server's priority level — the
    // same mapping the cards use, so "Must" means one thing on screen and in a
    // reminder that rings (#197).
    priority: importanceOf(commitment),
    allDay: commitment.timeSpec.allDay,
    postponedUntil: commitment.postponedUntil,
    // Only on a window, so every other commitment reaches the engine unchanged.
    ...(opensAtOf(commitment) ? { opensAt: opensAtOf(commitment) } : {}),
  }));
}

/**
 * The same commitment can be in both Today and Upcoming around midnight.
 * Scheduling it twice would be two identical requests under one identifier,
 * which the OS resolves by replacing — but the cap would still have counted it
 * twice, and the 50 nearest would be 49.
 */
export function mergeById(...lists: readonly (readonly Commitment[])[]): Commitment[] {
  const byId = new Map<string, Commitment>();
  for (const list of lists) for (const commitment of list) byId.set(commitment.id, commitment);
  return [...byId.values()];
}

export function toEngineSettings(
  dto: ReminderSettingsDto,
  intensity: ReminderIntensity,
): ReminderSettings {
  // Field by field: a server that sent the ceiling but not the opt-in is not a
  // shape anybody wrote, and each half falls back on its own rather than the
  // presence of one vouching for the other.
  const legacy = legacyEscalation(intensity);
  return {
    softEnabled: dto.softEnabled,
    softLeadMinutes: dto.softLeadMinutes,
    intensity,
    escalationCeiling: dto.escalationCeiling ?? legacy.escalationCeiling,
    hardEnabled: dto.hardEnabled ?? legacy.hardEnabled,
    mustThroughQuietHours: dto.mustThroughQuietHours ?? false,
  };
}

export function quietWindowOf(dto: ReminderSettingsDto): QuietWindow | null {
  return dto.quietHours ? { start: dto.quietHours.start, end: dto.quietHours.end } : null;
}

/**
 * The zone the window is wall-clock in.
 *
 * The *profile's* zone, which the server sends back, rather than the device's.
 * A user who set quiet hours in Tel Aviv and opened the app in Berlin still
 * means 22:00 Tel Aviv until they change it, and reading the phone's zone here
 * would move their quiet hours by the flight without telling them.
 */
export function quietTimeZone(dto: ReminderSettingsDto): string {
  return dto.quietHours?.timezone ?? dto.timezone;
}
