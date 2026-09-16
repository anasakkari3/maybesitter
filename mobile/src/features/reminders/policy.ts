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
 *  - the **strong** stage is not produced here. It is a Must reminder, it wants
 *    a channel at HIGH importance and an exact alarm, and both belong to
 *    UC-3.12a (#197). The stage stays in the enum so the identifiers and the
 *    awareness records this issue writes are the ones that issue will extend,
 *    rather than a second generation of them.
 *
 * Pure: no clock, no storage, no SDK. Everything about *when* comes in as an
 * argument, so the stage matrix is a table test rather than a wait.
 */

export const REMINDER_STAGES = ['soft', 'followUp', 'strong'] as const;
export type ReminderStage = (typeof REMINDER_STAGES)[number];

/** The Flutter follow-up lead, unchanged: half an hour before. */
export const FOLLOW_UP_LEAD_MINUTES = 30;
/** #197's, recorded here so the ladder is legible; never scheduled by this file. */
export const STRONG_LEAD_MINUTES = 10;

/** How far ahead the app is willing to hold pending requests (#196 step 8). */
export const HORIZON_DAYS = 7;
/**
 * iOS keeps at most 64 pending requests per app and silently discards the rest,
 * so the engine caps well below it and leaves room for UC-3.12a's.
 */
export const MAX_PENDING_REQUESTS = 50;

export type ReminderIntensity = 'none' | 'softAwareness' | 'followUp' | 'strongReminder';

export interface ReminderSettings {
  readonly softEnabled: boolean;
  /** 60, 30 or 15 — whichever the user chose. */
  readonly softLeadMinutes: number;
  /** From the routine survey. Decides how far up the ladder this account goes. */
  readonly intensity: ReminderIntensity;
}

/** What the engine needs about a commitment. Deliberately no title. */
export interface ReminderCommitment {
  readonly id: string;
  /** The instant it starts, ISO-8601, or null when it has no time. */
  readonly startsAt: string | null;
  readonly status: string;
}

export interface PlannedStage {
  readonly stage: ReminderStage;
  /** Epoch milliseconds the stage would fire at, before quiet hours are applied. */
  readonly at: number;
  readonly leadMinutes: number;
}

/**
 * Which stages this account gets, in ascending intensity.
 *
 * `none` is a real answer: somebody who chose it gets nothing, and the switch
 * on the settings screen is a second, independent way to say the same thing.
 */
export function stagesFor(settings: ReminderSettings): ReminderStage[] {
  if (!settings.softEnabled) return [];
  switch (settings.intensity) {
    case 'none':
      return [];
    case 'softAwareness':
      return ['soft'];
    case 'followUp':
    case 'strongReminder':
      // `strong` is #197's; see the header.
      return ['soft', 'followUp'];
  }
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
  for (const stage of stagesFor(settings)) {
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
