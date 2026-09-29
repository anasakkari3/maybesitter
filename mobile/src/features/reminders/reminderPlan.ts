/**
 * What should be pending — the reminder planning, and nothing else (UC-3.11, #196).
 *
 * Split out of `softAwarenessEngine.ts`, which diffs this against the OS and
 * does the scheduling, so the planning can be loaded without a native module
 * or a schema library in reach. The server's meeting-prep tests run this very
 * function to check that the reminder a proposal claims is the one the phone
 * rings (CL5a I-3), and the server's CI installs only the root packages. So
 * everything imported from here must stay pure and relative: a guard in
 * `tests/integrations/meetingPrepPipeline.test.ts` walks the imports and fails
 * on a package.
 */
import {
  HORIZON_DAYS,
  MAX_PENDING_REQUESTS,
  planFor,
  requestIdentifier,
  type ReminderCommitment,
  type ReminderSettings,
  type ReminderStage,
} from './policy';
import { deferOutOfQuietHours, keepHigherIntensity, type QuietWindow } from './quietHours';
import { isAware, type AwarenessCache } from '../../lib/deviceSettings/awareness';

export interface ReminderCopy {
  readonly title: string;
  readonly body: string;
}

export interface SyncInput {
  readonly commitments: readonly ReminderCommitment[];
  readonly now: Date;
  readonly settings: ReminderSettings;
  readonly quietHours: QuietWindow | null;
  readonly timeZone: string;
  readonly awareness: AwarenessCache;
  readonly copy: ReminderCopy;
  /** The Must reminder's sentence — also generic, also from the bundle. */
  readonly hardCopy: ReminderCopy;
  /**
   * Whether the OS will fire a pending request at its instant (UC-3.12a, #197).
   * Always true on iOS; on Android, whether "Alarms & reminders" is allowed.
   * Only recorded on the receipt — the request is scheduled either way, and
   * expo-notifications falls back to an inexact alarm when this is false.
   */
  readonly exactAlarms: boolean;
}

export interface DesiredRequest {
  readonly identifier: string;
  readonly commitmentId: string;
  readonly stage: ReminderStage;
  readonly at: number;
  /**
   * The instant the stage was *planned* for, before quiet hours moved it. For
   * the Must stage this is start − 10 minutes, which is the key the server
   * indexes the reminder under (#198) — the receipt names the reminder, not
   * wherever quiet hours happened to put it.
   */
  readonly plannedAt: number;
}

/**
 * Everything that should be pending, in fire order, already capped.
 *
 * Pure, and exported, because the cap and the quiet-hours deferral are the two
 * rules most worth testing without an OS anywhere near them.
 */
export function desiredRequests(input: SyncInput): {
  desired: DesiredRequest[];
  droppedForQuietHours: string[];
  overCap: string[];
} {
  const horizon = input.now.getTime() + HORIZON_DAYS * 86_400_000;
  const droppedForQuietHours: string[] = [];
  const candidates: DesiredRequest[] = [];

  for (const commitment of input.commitments) {
    // The gesture the user already made. Checked before anything is computed,
    // so an acknowledged commitment costs nothing and — the point of #196 —
    // survives the relaunch that reran this.
    if (isAware(input.awareness, commitment.id, commitment.startsAt)) continue;

    const startsAt = commitment.startsAt ? Date.parse(commitment.startsAt) : Number.NaN;
    if (Number.isNaN(startsAt) || startsAt > horizon) continue;

    const planned: { stage: ReminderStage; at: number; plannedAt: number }[] = [];
    for (const stage of planFor(commitment, input.settings)) {
      /*
       * "Let Must reminders through quiet hours" (#197 step 2) applies to the
       * strong stage and to nothing else. The soft and follow-up stages of the
       * same Must commitment still wait for the window to end; only the one the
       * user said may interrupt them does.
       */
      const window = stage.stage === 'strong' && input.settings.mustThroughQuietHours
        ? null
        : input.quietHours;
      const outcome = deferOutOfQuietHours(stage.at, window, input.timeZone, startsAt);
      if (outcome.kind === 'dropped') {
        droppedForQuietHours.push(requestIdentifier(commitment.id, stage.stage));
        continue;
      }
      // A stage whose moment has already passed is not scheduled: the OS would
      // fire it immediately, which is a notification about something the user
      // is already late for — and this product has no "overdue".
      if (outcome.at <= input.now.getTime()) continue;
      planned.push({ stage: stage.stage, at: outcome.at, plannedAt: stage.at });
    }

    // Two stages deferred out of one quiet window land on the same instant.
    for (const entry of keepHigherIntensity(planned)) {
      candidates.push({
        identifier: requestIdentifier(commitment.id, entry.stage),
        commitmentId: commitment.id,
        stage: entry.stage,
        at: entry.at,
        plannedAt: entry.plannedAt,
      });
    }
  }

  /*
   * Must stages first, then nearest first (#197 step 5).
   *
   * Nearest first is so the cap keeps what is about to happen and cuts what is
   * days away — which the next sync picks up again as it comes into range. The
   * Must stages go ahead of all of it because they are the reminders the user
   * said matter, and because a gentle heads-up that is cut costs a heads-up
   * while a Must reminder that is cut costs the thing itself. There are at most
   * seven days of them, so they cannot starve the rest in any week a person
   * actually has.
   */
  candidates.sort((left, right) =>
    (left.stage === 'strong' ? 0 : 1) - (right.stage === 'strong' ? 0 : 1)
    || left.at - right.at
    || left.identifier.localeCompare(right.identifier));
  return {
    desired: candidates.slice(0, MAX_PENDING_REQUESTS),
    droppedForQuietHours,
    overCap: candidates.slice(MAX_PENDING_REQUESTS).map((entry) => entry.identifier),
  };
}
