/**
 * The notification prompt at the first moment it means something (first
 * iPhone run, L7).
 *
 * ── Why the settings switch was not enough ───────────────────────
 *
 * The prompt was asked from exactly one place: turning gentle reminders on in
 * Settings. But gentle reminders default *on* at the server, so the switch
 * already showed on, nobody touched it, and the iOS prompt never appeared —
 * reminders were scheduled for a phone that had never been allowed to show
 * one. Cold start is the wrong moment; onboarding's reminders step asks on
 * «يلا نبلّش», but «بعدين» and an account that skips onboarding never see
 * it. This is the other right moment: somebody has just confirmed a
 * commitment *with a time*, there is now a specific thing to be reminded
 * about, and the question answers itself.
 *
 * ── Listening, not wiring into the capture flow ──────────────────
 *
 * The confirm already announces success: `useConfirmCapture` is a TanStack
 * mutation, and the mutation cache reports every mutation that succeeds. This
 * subscribes to that and recognises a confirm by its answer — parsed with the
 * same schema the app ships — so the review screen, the capture machine and
 * the share flow need no change and cannot forget to call it.
 *
 * ── Once ─────────────────────────────────────────────────────────
 *
 * `requestNotificationPermission` only prompts while the phone would still
 * show its prompt (`canPromptFrom` — on Android 13+ that includes a
 * never-asked permission the OS reports as `denied`, review of #7), so after
 * a final answer this is a status read. The session flag
 * stops even that read from repeating on every later confirm, and an account
 * that turned reminders off is not asked at all.
 */
import { useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { captureConfirmationSchema } from '../api/schemas/capture';
import { getNotificationPermission, requestNotificationPermission } from './permission';
import { refreshPushAfterPrompt } from './pushRegistration';

/** True for a confirm that saved at least one commitment with a time. */
export function isTimedConfirmation(data: unknown): boolean {
  const parsed = captureConfirmationSchema.safeParse(data);
  if (!parsed.success || parsed.data.success !== true) return false;
  return parsed.data.persisted.some(item => item.resolvedTime !== null);
}

let askedThisSession = false;

export function resetFirstMomentPromptForTests(): void {
  askedThisSession = false;
}

/**
 * Asks, if this is the moment and nobody has asked yet. Resolves when done.
 * Exported for the listener below and for a test to drive directly.
 */
export async function askAtFirstMoment(remindersWanted: boolean): Promise<void> {
  if (askedThisSession || !remindersWanted) return;
  askedThisSession = true;
  // `undetermined` here includes Android 13+'s never-asked `denied`
  // (`getNotificationPermission`); a final no stays `denied` and is not asked.
  if ((await getNotificationPermission()) !== 'undetermined') return;
  // A yes goes to the server now, not at the next cold launch.
  await refreshPushAfterPrompt('undetermined', await requestNotificationPermission());
}

/**
 * Subscribes to the mutation cache for the signed-in session.
 *
 * `remindersWanted` is read at the moment of the confirm, not at mount:
 * somebody may turn reminders off in Settings and confirm a commitment after.
 * An unknown setting counts as wanted, because the server's default is on.
 */
export function useNotificationPromptAtFirstMoment(client: QueryClient, remindersWanted: boolean): void {
  const wanted = useRef(remindersWanted);
  useEffect(() => { wanted.current = remindersWanted; });
  useEffect(() => client.getMutationCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (!isTimedConfirmation(event.action.data)) return;
    void askAtFirstMoment(wanted.current);
  }), [client]);
}
