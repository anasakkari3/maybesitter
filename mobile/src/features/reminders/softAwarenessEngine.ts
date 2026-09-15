/**
 * What should be pending, diffed against what is (UC-3.11, #196).
 *
 * ── Why a diff and not a rebuild ─────────────────────────────────
 *
 * Cancelling everything and rescheduling would be three lines shorter and
 * would work — until the moment between the cancel and the reschedule, which
 * is where an app termination loses every pending reminder the user has. It
 * also churns the OS's own store on every commitment change, which on Android
 * means an `AlarmManager` round trip per request per keystroke-ish event.
 *
 * So the engine computes what *should* be pending, reads what *is* pending
 * from the OS — `getAllScheduledNotificationsAsync`, which is also the
 * instrument #196's acceptance criteria are phrased in — and moves only the
 * difference. A request already sitting at the right instant is left alone.
 *
 * ── It only ever touches its own requests ────────────────────────
 *
 * Every identifier it cancels has to parse as `${commitmentId}:${stage}`.
 * UC-3.12a (#197) and UC-3.13 (#199) will schedule their own, and an engine
 * that cancelled "everything that is not in my list" would silently delete
 * them on its next run. `cancelAll()` is used in exactly one place — the kill
 * switch — and that is deliberate and documented at its call site.
 *
 * ── Nothing here knows what a commitment says ────────────────────
 *
 * The title and body come from the locale bundle and are the same for every
 * commitment; `data` carries `{ commitmentId, stage, notificationId }` and
 * nothing else. A notification payload is written to the OS store, where it
 * outlives the app — the Flutter client had the same rule
 * (`notification_payload.dart:8-13`) and it is kept.
 */
import type { NotificationGateway, ScheduleRequest } from '../../notifications/gateway';
import { AWARENESS_CATEGORY_ID, AWARENESS_CHANNEL_ID } from '../../notifications/channels';
import {
  HORIZON_DAYS,
  MAX_PENDING_REQUESTS,
  parseRequestIdentifier,
  planFor,
  requestIdentifier,
  type ReminderCommitment,
  type ReminderSettings,
  type ReminderStage,
} from './policy';
import { deferOutOfQuietHours, keepHigherIntensity, type QuietWindow } from './quietHours';
import { isAware, type AwarenessCache } from '../../lib/deviceSettings/awarenessStore';

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
}

export interface SyncReport {
  readonly scheduled: string[];
  readonly cancelled: string[];
  readonly kept: string[];
  /** Dropped because the end of the quiet window is too close to the start. */
  readonly droppedForQuietHours: string[];
  /** Cut by the pending-request cap, furthest away first. */
  readonly overCap: string[];
}

interface DesiredRequest {
  readonly identifier: string;
  readonly commitmentId: string;
  readonly stage: ReminderStage;
  readonly at: number;
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

    const planned: Array<{ stage: ReminderStage; at: number }> = [];
    for (const stage of planFor(commitment, input.settings)) {
      const outcome = deferOutOfQuietHours(stage.at, input.quietHours, input.timeZone, startsAt);
      if (outcome.kind === 'dropped') {
        droppedForQuietHours.push(requestIdentifier(commitment.id, stage.stage));
        continue;
      }
      // A stage whose moment has already passed is not scheduled: the OS would
      // fire it immediately, which is a notification about something the user
      // is already late for — and this product has no "overdue".
      if (outcome.at <= input.now.getTime()) continue;
      planned.push({ stage: stage.stage, at: outcome.at });
    }

    // Two stages deferred out of one quiet window land on the same instant.
    for (const entry of keepHigherIntensity(planned)) {
      candidates.push({
        identifier: requestIdentifier(commitment.id, entry.stage),
        commitmentId: commitment.id,
        stage: entry.stage,
        at: entry.at,
      });
    }
  }

  // Nearest first, so the cap keeps what is about to happen and cuts what is
  // days away — which the next sync will pick up again as it comes into range.
  candidates.sort((left, right) => left.at - right.at || left.identifier.localeCompare(right.identifier));
  return {
    desired: candidates.slice(0, MAX_PENDING_REQUESTS),
    droppedForQuietHours,
    overCap: candidates.slice(MAX_PENDING_REQUESTS).map((entry) => entry.identifier),
  };
}

function contentFor(request: DesiredRequest, copy: ReminderCopy): ScheduleRequest {
  return {
    identifier: request.identifier,
    title: copy.title,
    body: copy.body,
    // Ids only. `notificationId` is the identifier itself, so a tap can be
    // matched to the request that produced it without a second lookup table.
    data: {
      commitmentId: request.commitmentId,
      stage: request.stage,
      notificationId: request.identifier,
    },
    categoryIdentifier: AWARENESS_CATEGORY_ID,
    channelId: AWARENESS_CHANNEL_ID,
    at: new Date(request.at),
  };
}

/**
 * Brings the OS's pending requests in line with what the account wants.
 *
 * Runs after every commitment change and once on cold start, which is what
 * makes "the app was closed for two days" the same case as "the user just
 * edited something".
 */
export async function syncCommitments(
  input: SyncInput,
  gateway: NotificationGateway,
): Promise<SyncReport> {
  const { desired, droppedForQuietHours, overCap } = desiredRequests(input);
  const desiredById = new Map(desired.map((request) => [request.identifier, request]));

  const pending = await gateway.getScheduled();
  const cancelled: string[] = [];
  const kept: string[] = [];

  for (const request of pending) {
    // Not ours: #197 and #199 schedule their own, and this engine is not
    // allowed to have an opinion about them.
    if (!parseRequestIdentifier(request.identifier)) continue;
    const wanted = desiredById.get(request.identifier);
    // A pending request whose instant could not be read counts as wrong rather
    // than as right: rescheduling it is harmless because the identifier is
    // deterministic, and leaving a reminder at an unknown time is not.
    if (wanted && request.at === wanted.at) {
      kept.push(request.identifier);
      desiredById.delete(request.identifier);
      continue;
    }
    await gateway.cancel(request.identifier);
    cancelled.push(request.identifier);
  }

  const scheduled: string[] = [];
  for (const request of desiredById.values()) {
    await gateway.schedule(contentFor(request, input.copy));
    scheduled.push(request.identifier);
  }

  return { scheduled, cancelled, kept, droppedForQuietHours, overCap };
}

/**
 * The kill switch: everything this app has pending, gone.
 *
 * The one place `cancelAll` is used. It is right here and wrong everywhere
 * else, because the switch means "this build schedules nothing", and leaving
 * another feature's requests behind would make the switch a half-measure the
 * user could still be interrupted by.
 */
export async function cancelEveryReminder(gateway: NotificationGateway): Promise<void> {
  await gateway.cancelAll();
}
