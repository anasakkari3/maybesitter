/**
 * The seam between the reminder engine and expo-notifications (UC-3.11, #196).
 *
 * ── Why the engine does not call the SDK ─────────────────────────
 *
 * `syncCommitments` is the part with the rules in it — the stages, the quiet
 * hours, the 50-request cap, the diff against what is already pending. Every
 * one of those is a decision about somebody's evening, and a test of them
 * should read like a test of them rather than like a page of
 * `jest.mock('expo-notifications')`. So the engine takes this interface and
 * the tests hand it a list.
 *
 * It is also what makes the *diff* testable at all: the acceptance criterion
 * for "no follow-up after a relaunch" is phrased in terms of
 * `getAllScheduledNotificationsAsync`, and that is exactly `getScheduled()`
 * here.
 */
import { notificationsModule } from './nativeModules';
import type { ScheduledNotificationRequest } from './types';

export interface ScheduleRequest {
  /** `${commitmentId}:${stage}` — deterministic, so a resync replaces rather than duplicates. */
  readonly identifier: string;
  readonly title: string;
  readonly body: string;
  /** Identifiers only. Never a commitment title — see `notificationPayload.ts`. */
  readonly data: Record<string, string>;
  readonly categoryIdentifier: string;
  readonly channelId: string;
  readonly at: Date;
}

export interface NotificationGateway {
  /** What the OS is currently holding, which is the only honest source. */
  getScheduled(): Promise<ScheduledNotificationRequest[]>;
  schedule(request: ScheduleRequest): Promise<void>;
  cancel(identifier: string): Promise<void>;
  cancelAll(): Promise<void>;
}

/**
 * The real gateway, over expo-notifications.
 *
 * The module is resolved at each call rather than imported at the top, for one
 * reason: this module is imported by the engine, the engine is imported by a
 * screen, and a screen is rendered by a unit test that has no native
 * notification module. A static import would make every one of those tests
 * fail on the import alone. `nativeModules.ts` says why that resolution is a
 * `require`.
 *
 * A build without the module schedules nothing rather than throwing. Its
 * caller is a `useEffect`, where a rejected promise is an unhandled rejection
 * and not an error anybody sees.
 */
export function createExpoGateway(): NotificationGateway {
  return {
    async getScheduled() {
      const Notifications = notificationsModule();
      if (!Notifications) return [];
      const requests = await Notifications.getAllScheduledNotificationsAsync();
      return requests.map((request) => ({
        identifier: request.identifier,
        at: triggerInstantOf(request.trigger),
      }));
    },
    async schedule(request: ScheduleRequest) {
      const Notifications = notificationsModule();
      if (!Notifications) return;
      await Notifications.scheduleNotificationAsync({
        identifier: request.identifier,
        content: {
          title: request.title,
          body: request.body,
          data: request.data,
          categoryIdentifier: request.categoryIdentifier,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: request.at,
          channelId: request.channelId,
        },
      });
    },
    async cancel(identifier: string) {
      const Notifications = notificationsModule();
      if (!Notifications) return;
      await Notifications.cancelScheduledNotificationAsync(identifier);
    },
    async cancelAll() {
      const Notifications = notificationsModule();
      if (!Notifications) return;
      await Notifications.cancelAllScheduledNotificationsAsync();
    },
  };
}

/**
 * When a pending request will fire, in epoch milliseconds, or null.
 *
 * The two platforms report a date trigger differently — iOS as `date`,
 * Android as `value` — and a request whose instant cannot be read is treated
 * as "unknown" rather than as "correct": the engine then reschedules it, which
 * is safe because the identifier is deterministic and scheduling replaces.
 */
export function triggerInstantOf(trigger: unknown): number | null {
  if (!trigger || typeof trigger !== 'object') return null;
  const raw = trigger as { date?: unknown; value?: unknown };
  for (const candidate of [raw.date, raw.value]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (candidate instanceof Date) return candidate.getTime();
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}
