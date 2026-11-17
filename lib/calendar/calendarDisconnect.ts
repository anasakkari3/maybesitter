/**
 * «افصل وامسح» on the server (QA audit CA10.5, owner decision 2026-11-16,
 * option A): the copy says the busy times are gone "from this phone and from
 * your account", so they are.
 *
 * In this order, each step safe to run again:
 *  1. Calendar consent goes off, with a content-free audit line in the same
 *     transaction. That moves the account's consent epoch. Every route that
 *     writes calendar busy time (`POST /calendar/busy`, `POST /calendar/manual`)
 *     re-checks consent and that epoch inside each of its write transactions
 *     (`calendarConsentFence.ts`), so a request that read consent before this
 *     step and writes after it is refused and writes nothing. A chunk that
 *     committed before this step is deleted by step 2, which runs after it.
 *  2. Every calendar busy source of this account is deleted: every phone's,
 *     Google's, every feed's, and the lecture times added by hand, whose count
 *     is reset -- found both by source record and by the blocks themselves,
 *     so a half-written upload goes too. The person's own weekly blocks are
 *     not a calendar and stay. Other phones keep their registration: their
 *     busy time is gone, and when consent comes back they upload again, with
 *     nothing to rejoin.
 *  3. Feed subscriptions stay, paused, with their conditional-fetch state
 *     dropped, so the first refresh after consent returns is a full fetch.
 *
 * Reads are not gated on consent (option B was declined): after this there is
 * nothing left to read. Account-scoped and refused for an account that is not
 * live (#772).
 */
import { requireLiveAccount } from '../account/accountLiveness';
import { createPilotAuditEvent } from '../pilot/closedPilotControls';
import { applyTrustAction } from '../pilot/pilotTrustStore';
import { getStorage, type StorageAdapter } from '../storage';
import { CALENDAR_SOURCES, userCol } from '../storage/paths';
import { deleteBusySource, listBusyBlockSourceIds, sourceKindOf, type CalendarSource } from './busyBlocks';
import { pauseIcsFeedsForDisconnect } from './icsFeeds';
import { deleteManualBusySource, resetManualBusyCount } from './manualBusy';

export async function disconnectAccountCalendars(
  uid: string,
  deps: { readonly storage?: StorageAdapter; readonly now?: () => Date } = {},
): Promise<{ deleted: number }> {
  const storage = deps.storage ?? getStorage();
  await requireLiveAccount(storage, uid);
  const now = deps.now ?? (() => new Date());
  const at = now().toISOString();
  await applyTrustAction(uid, { type: 'set_calendar_consent', granted: false, at }, {
    stampAtApply: true,
    now,
    audit: createPilotAuditEvent({
      version: 'v1', eventType: 'consent_changed', participantId: uid, occurredAt: at,
      outcome: 'recorded', reasonCode: 'calendar_disconnect',
    }),
  });

  let deleted = await pauseIcsFeedsForDisconnect(uid);
  const recorded = (await storage.list<CalendarSource>(userCol(uid, CALENDAR_SOURCES))).map((row) => row.data.sourceId);
  const holding = await listBusyBlockSourceIds(uid, { storage });
  for (const sourceId of Array.from(new Set([...recorded, ...holding]))) {
    const kind = sourceKindOf(sourceId);
    if (kind === 'weekly') continue;
    const result = kind === 'manual'
      ? await deleteManualBusySource(uid, sourceId, { storage })
      : await deleteBusySource(uid, sourceId, { storage });
    deleted += result.deleted;
  }
  await resetManualBusyCount(uid, storage);
  return { deleted };
}
