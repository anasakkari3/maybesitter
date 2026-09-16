/**
 * Which reminders a commitment earns, and when (UC-3.11, #196).
 *
 * Ported from the Flutter `ReminderPolicy.planFor`
 * (`archive/flutter-final`, `lib/models/pilot_presence.dart:401-436`), with
 * its stage ladder kept and two of its choices changed:
 *
 *  - the **soft** stage's lead is the user's, not a constant. #196 puts 60/30/15
 *    on the settings screen, and a policy that ignored the control would make
 *    the control a lie.
 *  - the **strong** stage is produced only for a Must commitment, only when the
 *    user turned hard reminders on, and only when their ceiling is `hard`
 *    (UC-3.12a, #197). Flutter reached it from the survey answer alone and
 *    never asked; here all three have to hold at once, and each one is a
 *    separate test that goes red when it is removed.
 *
 * Pure: no clock, no storage, no SDK. Everything about *when* comes in as an
 * argument, so the stage matrix is a table test rather than a wait.
 */

export const REMINDER_STAGES = ['soft', 'followUp', 'strong'] as const;
export type ReminderStage = (typeof REMINDER_STAGES)[number];

/** The Flutter follow-up lead, unchanged: half an hour before. */
export const FOLLOW_UP_LEAD_MINUTES = 30;
/** The Must reminder: ten minutes before, as #197 specifies. */
export const STRONG_LEAD_MINUTES = 10;

/** How far ahead the app is willing to hold pending requests (#196 step 8). */
export const HORIZON_DAYS = 7;
/**
 * iOS keeps at most 64 pending requests per app and silently discards the rest,
 * so the engine caps well below it. The Must stage (UC-3.12a, #197) counts
 * against the same cap and is placed first under it — see `desiredRequests`.
 */
export const MAX_PENDING_REQUESTS = 50;

export type ReminderIntensity = 'none' | 'softAwareness' | 'followUp' | 'strongReminder';

/** The strongest stage an account agreed to — the #199 ceiling, by the server's name. */
export type EscalationCeiling = 'soft' | 'followUp' | 'hard';

export type ReminderPriority = 'must' | 'should' | 'nice';

export interface ReminderSettings {
  readonly softEnabled: boolean;
  /** 60, 30 or 15 — whichever the user chose. */
  readonly softLeadMinutes: number;
  /**
   * From the routine survey. Only `none` still decides anything here — it is a
   * real answer, and it means nothing at all. How far up the ladder an account
   * goes is `escalationCeiling`'s; see `legacyEscalation` for how the survey
   * answer becomes a ceiling for an account that never set one.
   */
  readonly intensity: ReminderIntensity;
  readonly escalationCeiling: EscalationCeiling;
  /** The explicit opt-in to ringing. Off unless the user turned it on. */
  readonly hardEnabled: boolean;
  /** Whether the strong stage — and no other — may ring inside quiet hours. */
  readonly mustThroughQuietHours: boolean;
}

/** What the engine needs about a commitment. Deliberately no title. */
export interface ReminderCommitment {
  readonly id: string;
  /** The instant it starts, ISO-8601, or null when it has no time. */
  readonly startsAt: string | null;
  readonly status: string;
  readonly priority: ReminderPriority;
  /**
   * The commitment names a day and nobody chose the hour (`TimeSpec.allDay`).
   * Its `startsAt` is that day's local midnight, so a ring "ten minutes before"
   * would be ten to midnight the night before. The Must stage is never planned
   * for one; see `planFor`.
   */
  readonly allDay: boolean;
}

/**
 * The ceiling and opt-in an account had before #197 gave it controls for them.
 *
 * The Flutter client had no switch for the strong stage: answering the routine
 * survey with `strongReminder` was the opt-in (`routine_profile_notifier.dart:
 * 95-96` on `archive/flutter-final`). #197 step 1 maps that answer to hard
 * reminders on with a hard ceiling; `followUp` keeps exactly the follow-up
 * #196 gave it; anything else is the gentlest ceiling.
 *
 * The server applies the same mapping (`legacyHardSettings` in
 * `lib/services/mobile/reminderSettingsService.ts`) and sends the result, so
 * this is only consulted when a response predates the fields — an older
 * server, never a newer choice.
 */
export function legacyEscalation(intensity: ReminderIntensity): {
  escalationCeiling: EscalationCeiling;
  hardEnabled: boolean;
} {
  if (intensity === 'strongReminder') return { escalationCeiling: 'hard', hardEnabled: true };
  if (intensity === 'followUp') return { escalationCeiling: 'followUp', hardEnabled: false };
  return { escalationCeiling: 'soft', hardEnabled: false };
}

export interface PlannedStage {
  readonly stage: ReminderStage;
  /** Epoch milliseconds the stage would fire at, before quiet hours are applied. */
  readonly at: number;
  readonly leadMinutes: number;
}

/**
 * Which stages this account gets for a commitment of this priority, in
 * ascending intensity.
 *
 * `none` is a real answer: somebody who chose it gets nothing, and the switch
 * on the settings screen is a second, independent way to say the same thing.
 * The switch also governs the strong stage — it is the reminders switch, and a
 * Must reminder that rang with it off would make it half a switch.
 *
 * The strong stage needs all three of: a Must commitment, the opt-in, and the
 * `hard` ceiling. The opt-in and the ceiling are set together by the screen,
 * and required separately here, so a document that holds one without the
 * other — a hand edit, a half-applied write — stays silent.
 */
export function stagesFor(settings: ReminderSettings, priority: ReminderPriority): ReminderStage[] {
  if (!settings.softEnabled) return [];
  if (settings.intensity === 'none') return [];
  const stages: ReminderStage[] = ['soft'];
  if (settings.escalationCeiling === 'followUp' || settings.escalationCeiling === 'hard') {
    stages.push('followUp');
  }
  if (priority === 'must' && settings.hardEnabled && settings.escalationCeiling === 'hard') {
    stages.push('strong');
  }
  return stages;
}

export function leadMinutesFor(stage: ReminderStage, settings: ReminderSettings): number {
  if (stage === 'soft') return settings.softLeadMinutes;
  if (stage === 'followUp') return FOLLOW_UP_LEAD_MINUTES;
  return STRONG_LEAD_MINUTES;
}

/**
 * The stages for one commitment, in fire order, or none.
 *
 * A stage whose lead is at or beyond the soft stage's is dropped rather than
 * scheduled on top of it: with a 15-minute soft lead the follow-up's 30 minutes
 * would fire *first*, so the gentle reminder would arrive after the firmer one
 * and the ladder would read backwards.
 */
export function planFor(
  commitment: ReminderCommitment,
  settings: ReminderSettings,
): PlannedStage[] {
  if (commitment.status !== 'active') return [];
  if (!commitment.startsAt) return [];
  const startsAt = Date.parse(commitment.startsAt);
  if (Number.isNaN(startsAt)) return [];

  const planned: PlannedStage[] = [];
  for (const stage of stagesFor(settings, commitment.priority)) {
    if (stage === 'strong' && commitment.allDay) continue;
    const leadMinutes = leadMinutesFor(stage, settings);
    if (stage !== 'soft' && leadMinutes >= settings.softLeadMinutes) continue;
    planned.push({ stage, at: startsAt - leadMinutes * 60_000, leadMinutes });
  }
  return planned.sort((left, right) => left.at - right.at);
}

/** `${commitmentId}:${stage}` — the identifier the OS holds the request under. */
export function requestIdentifier(commitmentId: string, stage: ReminderStage): string {
  return `${commitmentId}:${stage}`;
}

/** The commitment and stage an identifier names, or null when it is not ours. */
export function parseRequestIdentifier(
  identifier: string,
): { commitmentId: string; stage: ReminderStage } | null {
  const separator = identifier.lastIndexOf(':');
  if (separator < 1) return null;
  const stage = identifier.slice(separator + 1) as ReminderStage;
  if (!REMINDER_STAGES.includes(stage)) return null;
  return { commitmentId: identifier.slice(0, separator), stage };
}
