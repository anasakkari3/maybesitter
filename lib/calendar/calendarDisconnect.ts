/**
 * «افصل وامسح» on the server (QA audit CA10.5, owner decision 2026-11-16,
 * option A): the copy says the busy times are gone "from this phone and from
 * your account", so they are.
 *
 * In this order, each step safe to run again:
 *  1. Calendar consent goes off. Every busy writer refuses without it, and the
 *     consent epoch moves, so an upload already on its way is refused too and
 *     nothing written after this point can bring busy time back.
 *  2. Every calendar busy source of this account is deleted: every phone's,
 *     Google's, every feed's, and the lecture times added by hand, whose count
 *     is reset. The person's own weekly blocks are not a calendar and stay.
 *     Other phones keep their registration: their busy time is gone, and when
 *     consent comes back they simply upload again, with nothing to rejoin.
 *  3. Feed subscriptions stay, paused, with their conditional-fetch state
 *     dropped, so the first refresh after consent returns is a full fetch.
 *
 * Reads are not gated on consent (option B was declined): after this there is
 * nothing left to read. Account-scoped and refused for an account that is not
 * live (#772).
 */
import { requireLiveAccount } from '../account/accountLiveness';
import { applyTrustAction } from '../pilot/pilotTrustStore';
import { getStorage, type StorageAdapter } from '../storage';
import { CALENDAR_SOURCES, userCol } from '../storage/paths';
import { deleteBusySource, type CalendarSource } from './busyBlocks';
import { pauseIcsFeedsForDisconnect } from './icsFeeds';
import { deleteManualBusySource, resetManualBusyCount } from './manualBusy';

export async function disconnectAccountCalendars(
  uid: string,
  deps: { readonly storage?: StorageAdapter; readonly now?: () => Date } = {},
): Promise<{ deleted: number }> {
  const storage = deps.storage ?? getStorage();
  await requireLiveAccount(storage, uid);
  const now = deps.now ?? (() => new Date());
  await applyTrustAction(uid, { type: 'set_calendar_consent', granted: false, at: now().toISOString() }, { stampAtApply: true, now });

  let deleted = await pauseIcsFeedsForDisconnect(uid);
  const sources = (await storage.list<CalendarSource>(userCol(uid, CALENDAR_SOURCES))).map((row) => row.data);
  for (const source of sources) {
    if (source.kind === 'weekly') continue;
    const result = source.kind === 'manual'
      ? await deleteManualBusySource(uid, source.sourceId, { storage })
      : await deleteBusySource(uid, source.sourceId, { storage });
    deleted += result.deleted;
  }
  await resetManualBusyCount(uid, storage);
  return { deleted };
}
