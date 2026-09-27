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
import {
  AWARENESS_CATEGORY_ID,
  AWARENESS_CHANNEL_ID,
  HARD_CATEGORY_ID,
  HARD_CHANNEL_ID,
  HARD_SOUND,
} from '../../notifications/channels';
import { parseRequestIdentifier } from './policy';
import type { HardReceipt } from '../../lib/deviceSettings/hardReceiptQueue';
import { desiredRequests, type DesiredRequest, type SyncInput } from './reminderPlan';

// The planning is `reminderPlan.ts`; it is re-exported so every caller keeps
// one import, and so the function the server's tests run is the one below.
export { desiredRequests, type ReminderCopy, type SyncInput } from './reminderPlan';

export interface SyncReport {
  readonly scheduled: string[];
  readonly cancelled: string[];
  readonly kept: string[];
  /** Dropped because the end of the quiet window is too close to the start. */
  readonly droppedForQuietHours: string[];
  /** Cut by the pending-request cap, furthest away first. */
  readonly overCap: string[];
  /**
   * One receipt per Must stage that is pending on this device after the sync —
   * newly scheduled or already there (UC-3.12a, #197). Ids and instants only.
   * UC-3.12b (#198) uploads them so the server knows not to send a backup;
   * `hardReceiptQueue` is what stops an unchanged one being uploaded twice.
   */
  readonly hardReceipts: HardReceipt[];
}

function contentFor(request: DesiredRequest, input: SyncInput): ScheduleRequest {
  if (request.stage === 'strong') {
    /*
     * The Must reminder (UC-3.12a, #197): its own channel at HIGH importance
     * with alarm audio on Android, and on iOS the bundled sound at the
     * Time Sensitive interruption level, which is what lets it through a Focus
     * the user has allowed the app to break. Not `critical`: that entitlement
     * is not available to this kind of app and is not requested.
     */
    return {
      identifier: request.identifier,
      title: input.hardCopy.title,
      body: input.hardCopy.body,
      data: {
        commitmentId: request.commitmentId,
        stage: request.stage,
        notificationId: request.identifier,
      },
      categoryIdentifier: HARD_CATEGORY_ID,
      channelId: HARD_CHANNEL_ID,
      sound: HARD_SOUND,
      interruptionLevel: 'timeSensitive',
      at: new Date(request.at),
    };
  }
  const copy = input.copy;
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
    await gateway.schedule(contentFor(request, input));
    scheduled.push(request.identifier);
  }

  /*
   * A receipt for every Must stage now pending — including the ones that were
   * already there. A kept request's receipt is what tells the server about a
   * permission that changed since it was scheduled (exact alarms granted
   * later), and the queue drops one that is identical to what was last
   * uploaded, so re-reporting it costs nothing.
   *
   * Built from `desired`, which is exactly what this run left pending: every
   * entry in it was either kept at its instant or scheduled above, and nothing
   * cut by the cap or dropped for quiet hours is in it. A receipt is a claim
   * that the phone *will* ring, and it is what makes the server stand down.
   * (A second filter against `scheduled`/`kept` used to sit here; no input
   * could make it remove anything, so it was a guard that could not fail.)
   */
  const hardReceipts: HardReceipt[] = desired
    .filter(request => request.stage === 'strong')
    .map(request => ({
      commitmentId: request.commitmentId,
      notificationId: request.identifier,
      fireAt: new Date(request.plannedAt).toISOString(),
      exact: input.exactAlarms,
    }));

  return { scheduled, cancelled, kept, droppedForQuietHours, overCap, hardReceipts };
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
