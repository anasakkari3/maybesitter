/**
 * Telling the phone its plan is ready, through the one push path (UC-3.10a #194, UC-3.0b #184).
 *
 * `dailyPlanService` declares what a finished plan announces (`PlanReadyNotice`)
 * and this turns it into a `PushMessage` for `sendToUser`. It was a no-op until
 * #184 existed; it is now the production default, so a plan the morning sweep
 * builds reaches the account's devices without any caller remembering to wire
 * it.
 *
 * ── What the payload carries ─────────────────────────────────────
 *
 * `data.kind` is `plan_ready` because that is what the phone routes on
 * (`mobile/src/notifications/routeFromNotification.ts`): without it the tap
 * opens Today instead of the plan, and nothing on the server would notice.
 * `data.planDate` is the date, which the phone re-validates.
 *
 * The title and body are generic and localised here, never built from the plan:
 * a notification's text passes through Google's and Apple's servers and sits in
 * the OS notification store, so a commitment title in it is a leak.
 *
 * ── Retries are not this module's ───────────────────────────────
 *
 * This sends one notice. Whether a notice is sent again — after quiet hours, a
 * throwing send or a crash — is `planPushRetry.ts` (#431). What this module
 * contributes is `collapseId`: every attempt for one date is shown under
 * `plan:{date}`, whatever its dedupe key, so a retry after an ambiguous FCM
 * failure replaces a notification that did arrive instead of standing beside
 * it.
 */
import { sendToUser, type MessagingClient, type PushMessage, type PushResult } from '../../push/pushService';
import type { StorageAdapter } from '../../storage';
import type { UserLocale } from '../../storage/userDocument';
import type { PlanReadyNotice } from './dailyPlanService';

export interface PlanReadyCopy {
  readonly title: string;
  readonly body: string;
}

/** Levantine Arabic and plain Hebrew, like the explanation template. */
export const PLAN_READY_COPY: Readonly<Record<UserLocale, PlanReadyCopy>> = Object.freeze({
  en: Object.freeze({ title: 'Your plan for today is ready', body: 'Open MaybeSitter when you have a minute.' }),
  ar: Object.freeze({ title: 'خطة اليوم جاهزة', body: 'افتح MaybeSitter لما يكون عندك دقيقة.' }),
  he: Object.freeze({ title: 'התוכנית להיום מוכנה', body: 'אפשר לפתוח את MaybeSitter כשיש לך רגע.' }),
});

export function planReadyMessage(notice: PlanReadyNotice): PushMessage {
  const copy = PLAN_READY_COPY[notice.locale] ?? PLAN_READY_COPY.en;
  return {
    kind: notice.kind,
    uid: notice.uid,
    dedupeKey: notice.dedupeKey,
    collapseId: `plan:${notice.data.planDate}`,
    data: { kind: notice.kind, planDate: notice.data.planDate },
    title: copy.title,
    body: copy.body,
    urgency: notice.urgency,
    respectQuietHours: notice.respectQuietHours,
  };
}

export interface PlanReadyPushDeps {
  readonly storage: StorageAdapter;
  readonly messaging?: MessagingClient;
  readonly now: () => Date;
}

/** The production `PlanPushSender`. */
export function planReadyPushSender(deps: PlanReadyPushDeps) {
  return (notice: PlanReadyNotice): Promise<PushResult> => sendToUser(planReadyMessage(notice), deps.now(), {
    storage: deps.storage,
    ...(deps.messaging ? { messaging: deps.messaging } : {}),
  });
}
