/**
 * What a press on a reminder does (UC-3.14, #200).
 *
 * Three callers — the live listener, the cold-start response, and the
 * background task that runs when the app is killed — and one decision, made
 * here. Nothing in the response is trusted: the action has to be one of ours
 * and the commitment id has to be in the shape the backend mints
 * (`routeFromNotification`), or the press does nothing.
 *
 * ── Order of effects for Done and Later ──────────────────────────
 *
 * 1. The tap is written to the outbox. Before anything else, so a process
 *    killed in the next millisecond has still kept it.
 * 2. That commitment's remaining stages are cancelled and the notification is
 *    dismissed, so nothing else rings for something already answered.
 * 3. One flush is tried. Offline, it stays queued for the next trigger.
 *
 * A duplicate delivery of the same press (listener *and* cold start) stops at
 * step 1: the outbox reports it was not new.
 */
import { DEFAULT_ACTION_IDENTIFIER } from 'expo-notifications';
import { ACTION_DONE, ACTION_DROP, ACTION_LATER, DEFAULT_DEFER_MS } from '../../notifications/actions';
import { commitmentIdOf } from '../../notifications/routeFromNotification';
import { REMINDER_STAGES, requestIdentifier } from './policy';
import { enqueueTap, type OutboxAction } from '../../lib/deviceSettings/actionOutbox';

export type ResponseDecision =
  | {
    readonly kind: 'enqueue';
    readonly commitmentId: string;
    readonly action: OutboxAction;
    readonly notificationId: string;
    readonly postponedUntil?: string;
    /** The OS's delivery instant, which tells one ring from a re-ring under the same identifier. */
    readonly deliveredAt?: number;
  }
  | { readonly kind: 'confirmDrop'; readonly commitmentId: string }
  | { readonly kind: 'ignore' };

/** The default action id, spelled out so a mock of the module cannot erase it. */
const DEFAULT_TAP = DEFAULT_ACTION_IDENTIFIER ?? 'expo.modules.notifications.actions.DEFAULT';

export function isBodyTap(actionIdentifier: unknown): boolean {
  return actionIdentifier === DEFAULT_TAP;
}

/**
 * Pure. `identifier` is the OS request's identifier, which is what makes the
 * same press delivered twice recognisable.
 */
export function decideResponse(
  actionIdentifier: unknown,
  data: unknown,
  identifier: unknown,
  now: number,
  deferMs: number = DEFAULT_DEFER_MS,
  deliveredAt?: unknown,
): ResponseDecision {
  const commitmentId = commitmentIdOf(data);
  if (!commitmentId) return { kind: 'ignore' };
  const notificationId = typeof identifier === 'string' && identifier !== '' ? identifier : commitmentId;
  const delivery = typeof deliveredAt === 'number' && Number.isFinite(deliveredAt) ? { deliveredAt } : {};
  switch (actionIdentifier) {
    case ACTION_DONE:
      return { kind: 'enqueue', commitmentId, action: 'complete', notificationId, ...delivery };
    case ACTION_LATER:
      return {
        kind: 'enqueue', commitmentId, action: 'postpone', notificationId,
        postponedUntil: new Date(now + deferMs).toISOString(), ...delivery,
      };
    case ACTION_DROP:
      return { kind: 'confirmDrop', commitmentId };
    case DEFAULT_TAP:
      // The body: "I know". Recorded on the server as `reminder_acknowledged`.
      return { kind: 'enqueue', commitmentId, action: 'aware', notificationId, ...delivery };
    default:
      return { kind: 'ignore' };
  }
}

export interface TapEffects {
  readonly accountId: string;
  readonly newId: () => string;
  readonly now: () => Date;
  cancelScheduled(identifier: string): Promise<void>;
  dismiss(identifier: string): Promise<void>;
  flush(): Promise<unknown>;
}

/**
 * Carries out an `enqueue` decision. Returns whether the press was new.
 *
 * `aware` cancels nothing here: the body tap's silencing is the awareness
 * record `RemindersMount` already writes (#196).
 */
export async function applyTap(
  decision: Extract<ResponseDecision, { kind: 'enqueue' }>,
  effects: TapEffects,
): Promise<boolean> {
  const fresh = await enqueueTap(effects.accountId, {
    commitmentId: decision.commitmentId,
    action: decision.action,
    notificationId: decision.notificationId,
    ...(decision.postponedUntil ? { postponedUntil: decision.postponedUntil } : {}),
    ...(decision.deliveredAt !== undefined ? { deliveredAt: decision.deliveredAt } : {}),
  }, effects.newId, effects.now());
  if (!fresh) return false;
  if (decision.action !== 'aware') {
    for (const stage of REMINDER_STAGES) {
      try {
        await effects.cancelScheduled(requestIdentifier(decision.commitmentId, stage));
      } catch {
        // Already fired or never scheduled.
      }
    }
    try {
      await effects.dismiss(decision.notificationId);
    } catch {
      // Already gone from the tray.
    }
  }
  try {
    await effects.flush();
  } catch {
    // Stays queued.
  }
  return true;
}
