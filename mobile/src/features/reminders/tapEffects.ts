/**
 * The real effects behind a notification-button press, and the background task
 * that carries one when the app is not running (UC-3.14, #200).
 *
 * ── The background task ──────────────────────────────────────────
 *
 * Android runs `NOTIFICATION_RESPONSE_TASK` when Done or Later is pressed on a
 * backgrounded or killed app; no React tree exists then. It must be *defined*
 * at module scope of the entry file (`index.ts`), before the app registers, and
 * *registered* once from the running app. iOS launches the app in the
 * background for a button that does not open it, and the response reaches the
 * live listener or `getLastNotificationResponseAsync` instead. Both paths meet
 * in the outbox, whose dedupe key makes a press delivered to both count once.
 *
 * What runs in the task is the smallest safe thing: write the tap, cancel that
 * commitment's stages, dismiss, and try one flush with the Firebase session the
 * device already holds. With no session yet (the SDK restores it
 * asynchronously), the tap stays queued and the next app start sends it.
 */
import * as Crypto from 'expo-crypto';
import { getAuthRepository, setAuthRepository } from '../../api/auth';
import { createFirebaseAuthRepository } from '../../auth/firebaseAuthRepository';
import { notificationsModule } from '../../notifications/nativeModules';
import { flushOutbox, UNBOUND_ACCOUNT } from '../../lib/deviceSettings/actionOutbox';
import { applyTap, decideResponse, type TapEffects } from './notificationResponses';
import { sendOutboxItem } from './outboxSender';

export const NOTIFICATION_RESPONSE_TASK = 'maybesitter-notification-response';

/** Lower case: the server accepts nothing else as a `clientActionId`. */
export function newClientActionId(): string {
  return Crypto.randomUUID().toLowerCase();
}

export function flushFor(accountId: string): Promise<unknown> {
  if (accountId === UNBOUND_ACCOUNT) return Promise.resolve({ sent: 0, dropped: 0, retrying: 0 });
  // The API client sends with whoever is signed in now; stop if that is not the
  // account these taps were queued under.
  return flushOutbox(accountId, sendOutboxItem, () => Date.now(), () => getAuthRepository()?.currentUser()?.uid === accountId);
}

export function tapEffectsFor(accountId: string): TapEffects {
  return {
    accountId,
    newId: newClientActionId,
    now: () => new Date(),
    async cancelScheduled(identifier) {
      await notificationsModule()?.cancelScheduledNotificationAsync(identifier);
    },
    async dismiss(identifier) {
      await notificationsModule()?.dismissNotificationAsync(identifier);
    },
    flush: () => flushFor(accountId),
  };
}

type TaskManagerModule = typeof import('expo-task-manager');

function taskManagerModule(): TaskManagerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-task-manager') as TaskManagerModule;
  } catch {
    return null;
  }
}

/** The response as the task hands it over, or null when it is not a response. */
export function responseOfTaskPayload(
  payload: unknown,
): { actionIdentifier: unknown; data: unknown; identifier: unknown; deliveredAt: unknown } | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as { actionIdentifier?: unknown; notification?: unknown };
  if (typeof raw.actionIdentifier !== 'string') return null;
  const notification = raw.notification as { date?: unknown; request?: { identifier?: unknown; content?: { data?: unknown } } } | null;
  const request = notification?.request;
  return {
    actionIdentifier: raw.actionIdentifier, data: request?.content?.data, identifier: request?.identifier,
    deliveredAt: notification?.date,
  };
}

/** The headless half. Exported for tests; the task calls it. */
export async function handleBackgroundResponse(
  payload: unknown,
  signedInAccount: () => Promise<string | null>,
  effectsFor: (accountId: string) => TapEffects = tapEffectsFor,
): Promise<boolean> {
  const response = responseOfTaskPayload(payload);
  if (!response) return false;
  const decision = decideResponse(
    response.actionIdentifier, response.data, response.identifier, Date.now(), undefined, response.deliveredAt,
  );
  // The drop button and the body open the app; the foreground listener has them.
  if (decision.kind !== 'enqueue' || decision.action === 'aware') return false;
  // No session restored yet: the tap is still kept, unbound, and the next
  // account to mount adopts it (`adoptUnboundTaps`). Nothing is sent meanwhile.
  const accountId = (await signedInAccount()) ?? UNBOUND_ACCOUNT;
  return applyTap(decision, effectsFor(accountId));
}

/** How long the headless task waits for Firebase to restore the session. */
export const HEADLESS_AUTH_WAIT_MS = 5_000;

async function headlessAccount(): Promise<string | null> {
  try {
    let repository = getAuthRepository();
    if (!repository) {
      repository = createFirebaseAuthRepository();
      setAuthRepository(repository);
    }
    const now = repository.currentUser()?.uid;
    if (now) return now;
    const restoring = repository;
    return await new Promise<string | null>(resolve => {
      let unsubscribe: (() => void) | undefined;
      const timer = setTimeout(() => {
        unsubscribe?.();
        resolve(null);
      }, HEADLESS_AUTH_WAIT_MS);
      unsubscribe = restoring.onChange(user => {
        if (!user) return;
        clearTimeout(timer);
        unsubscribe?.();
        resolve(user.uid);
      });
    });
  } catch {
    return null;
  }
}

/** From `index.ts`, at module scope. Never throws. */
export function defineNotificationResponseTask(): void {
  try {
    taskManagerModule()?.defineTask(NOTIFICATION_RESPONSE_TASK, async ({ data, error }) => {
      if (error) return;
      await handleBackgroundResponse(data, headlessAccount);
    });
  } catch {
    // No native module.
  }
}

/** From the running app, once. Never throws. */
export async function registerNotificationResponseTask(): Promise<void> {
  try {
    await notificationsModule()?.registerTaskAsync(NOTIFICATION_RESPONSE_TASK);
  } catch {
    // No native module, or already registered.
  }
}
