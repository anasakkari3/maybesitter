/**
 * The Google connection's queries and actions (CL6a).
 *
 * Kept beside the feature rather than in `src/api/queries.ts` so the three
 * rows are one directory; the rules of `src/api/` still hold here — keys are
 * scoped by uid, nothing is persisted, nothing is logged, and no mutation is
 * retried (each one mints or spends something on the server).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTrust, useUid } from '../../api/queries';
import { useTimeZone } from '../../i18n/timezone';
import { apiLocale } from '../../i18n/locale';
import {
  beginDrivePick,
  completeGoogleConnect,
  disconnectGoogle,
  getGoogleStatus,
  importDriveFile,
  listGoogleBusy,
  scanGmail,
  startGoogleConnect,
  syncGoogleCalendar,
} from '../../api/endpoints/google';
import { GoogleRefusedError } from '../../api/errors';
import type { GoogleFeature, GoogleStatus } from '../../api/schemas/google';
import type { ShareProposal } from '../../api/schemas/share';
import type { DeviceBusyBlock } from '../calendar/busyBlocks';
import { openGoogleSession, readConnectReturn, readPickReturn } from './authSession';

export const googleQueryKeys = {
  status: (uid: string) => ['user', uid, 'google'] as const,
  busy: (uid: string) => ['user', uid, 'google', 'busy'] as const,
};

/** Refusals that mean the row itself is out of date. */
const STATUS_CHANGING: ReadonlySet<string> = new Set([
  'provider_not_configured',
  'google_not_connected',
  'google_reauth_required',
  'google_feature_not_granted',
  'google_picker_unavailable',
]);

function refreshStatusOn(error: unknown, client: QueryClient, uid: string): void {
  if (error instanceof GoogleRefusedError && STATUS_CHANGING.has(error.reason)) {
    // Exact: the busy query sits under the same prefix and reads from Google.
    void client.invalidateQueries({ queryKey: googleQueryKeys.status(uid), exact: true });
  }
}

export function useGoogleStatus() {
  const uid = useUid();
  return useQuery({
    queryKey: googleQueryKeys.status(uid),
    queryFn: async () => (await getGoogleStatus()).google,
    enabled: uid !== 'signed-out',
  });
}

/** Whether Google Calendar busy time is on for this account. */
export function googleCalendarOn(status: GoogleStatus | undefined): boolean {
  return status?.status === 'connected' && status.features.calendar;
}

/** The stored Google blocks, in the shape the phone's own blocks have. */
async function listGoogleBlocks(): Promise<DeviceBusyBlock[]> {
  const { blocks } = await listGoogleBusy();
  return blocks.map((block) => ({
    nativeId: block.blockId,
    startAt: block.startAt,
    endAt: block.endAt,
    allDay: block.allDay,
  }));
}

/**
 * Google busy time in the shape the Calendar tab and the conflict chips
 * already draw.
 *
 * A read of what the account holds, and nothing more: the refresh from Google
 * is `GoogleBusyHost`'s job, for the whole session, the way the phone's
 * calendar is `BusyCalendarHost`'s. It used to refresh here, which meant it
 * only ever happened while the Calendar tab was open (CL6a review I1).
 */
export function useGoogleBusyBlocks(): DeviceBusyBlock[] {
  const uid = useUid();
  const status = useGoogleStatus();
  const query = useQuery({
    queryKey: googleQueryKeys.busy(uid),
    queryFn: listGoogleBlocks,
    enabled: uid !== 'signed-out' && googleCalendarOn(status.data),
    staleTime: 15 * 60_000,
  });
  return googleCalendarOn(status.data) ? query.data ?? NO_BLOCKS : NO_BLOCKS;
}

/**
 * The phone's busy blocks and Google's, for the conflict chips on Today,
 * review and details (CL6a review I1).
 *
 * The server already dropped any Google interval the phone's own blocks
 * cover, so the two lists do not repeat a meeting; ids are prefixed by source
 * and never collide.
 */
export function useConflictBusyBlocks(device: DeviceBusyBlock[]): DeviceBusyBlock[] {
  const google = useGoogleBusyBlocks();
  return useMemo(() => (google.length === 0 ? device : [...device, ...google]), [device, google]);
}

/* ── The session's Google busy sync (CL6a review I1) ───────────── */

/** How often coming back to the front may refresh from Google. The phone's own cadence. */
export const GOOGLE_BUSY_SYNC_MIN_INTERVAL_MS = 15 * 60_000;

/**
 * One pass at a time per account, and when each account's last one finished.
 *
 * Module-level for the reason `useBusyCalendar`'s flag is: the host is
 * mounted once, but a remount must not start a second pass beside the first.
 * Keyed by uid (CL6a round 2, N6): a pass still out for the account that just
 * signed out must not hold up the connect sync of the one that signed in, nor
 * stamp its throttle.
 */
const googlePasses = new Map<string, Promise<GoogleCalendarSynced>>();
const googleLastSyncedAt = new Map<string, number>();

type GoogleCalendarSynced = Awaited<ReturnType<typeof syncGoogleCalendar>>;

export function resetGoogleBusySyncForTests(lastSynced: { uid: string; at: number } | null = null): void {
  googlePasses.clear();
  googleLastSyncedAt.clear();
  if (lastSynced) googleLastSyncedAt.set(lastSynced.uid, lastSynced.at);
}

/**
 * One refresh from Google for `uid`, shared by whoever asks while it runs:
 * the session host and the Google page's button join the same pass instead
 * of asking Google twice.
 *
 * The blocks are fetched afterwards — so a chip on Today does not wait for
 * the network when it first renders — only while `uid` is still the signed-in
 * account: the request would otherwise carry the next account's token and
 * file its blocks under this one's key.
 */
function googlePass(uid: string, client: QueryClient, stillSignedIn: () => boolean): Promise<GoogleCalendarSynced> {
  const running = googlePasses.get(uid);
  if (running) return running;
  const pass = (async () => {
    try {
      const synced = await syncGoogleCalendar();
      googleLastSyncedAt.set(uid, Date.now());
      if (stillSignedIn()) {
        await client.fetchQuery({ queryKey: googleQueryKeys.busy(uid), queryFn: listGoogleBlocks, staleTime: 0 })
          .catch(() => undefined);
      }
      return synced;
    } finally {
      googlePasses.delete(uid);
    }
  })();
  googlePasses.set(uid, pass);
  return pass;
}

export type GoogleBusySyncTrigger = 'connect' | 'foreground';

/**
 * Refreshes Google busy time from Google for the whole signed-in session.
 *
 * When: as soon as Google Calendar is connected and the Trust Center's
 * calendar switch is on — which is also "the app started with both already
 * on" — and every time the app comes back to the front, at most every fifteen
 * minutes. The same two triggers and the same throttle as the phone's
 * calendar (`busySync.ts`): the connect is somebody asking now, the
 * foreground is the one that can fire ten times a minute.
 *
 * Without this the planner, Today's chips and the replan tick saw Google
 * meetings only after somebody opened the Calendar tab.
 *
 * The switch is checked here rather than left to the server's 403: asking a
 * question whose answer is known to be no, on every trip to the front, is a
 * request for nothing.
 */
export function useGoogleBusySync(): { syncNow(trigger: GoogleBusySyncTrigger): Promise<boolean> } {
  const uid = useUid();
  const client = useQueryClient();
  const status = useGoogleStatus();
  const trust = useTrust();
  const on = uid !== 'signed-out'
    && googleCalendarOn(status.data)
    && trust.data?.trust?.calendarConsent === true;

  const latest = useRef({ uid, on });
  useEffect(() => { latest.current = { uid, on }; });

  const syncNow = useCallback(async (trigger: GoogleBusySyncTrigger): Promise<boolean> => {
    const current = latest.current;
    if (!current.on || googlePasses.has(current.uid)) return false;
    const last = googleLastSyncedAt.get(current.uid);
    if (trigger === 'foreground' && last !== undefined) {
      const since = Date.now() - last;
      // A clock that went backwards costs one extra sync, not a stopped one.
      if (since >= 0 && since < GOOGLE_BUSY_SYNC_MIN_INTERVAL_MS) return false;
    }
    try {
      await googlePass(current.uid, client, () => latest.current.uid === current.uid);
      return true;
    } catch (error) {
      // A lapsed grant or a feature taken away: the row has to say so.
      refreshStatusOn(error, client, current.uid);
      return false;
    }
  }, [client]);

  // Connected (or reconnected), or already on when the app started.
  useEffect(() => {
    if (!on) return;
    void syncNow('connect');
  }, [on, syncNow]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncNow('foreground');
    });
    return () => subscription.remove();
  }, [syncNow]);

  return { syncNow };
}

/**
 * Mounted in `Root` beside `BusyCalendarHost`, and drawing nothing. Google
 * busy time then reaches the planner, the replan tick and the chips on every
 * screen, not only while the Calendar tab is open.
 */
export function GoogleBusyHost(): null {
  useGoogleBusySync();
  return null;
}

const NO_BLOCKS: DeviceBusyBlock[] = [];

export type ConnectOutcome = 'connected' | 'cancelled';

/**
 * Connect (or reconnect) one feature: the server builds the URL, Google's
 * consent screen runs in an auth session, and what it hands back is posted
 * signed in. A refusal throws `GoogleRefusedError` with the reason the row
 * shows; closing the session is not a failure.
 */
export function useGoogleConnect() {
  const uid = useUid();
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (feature: GoogleFeature): Promise<ConnectOutcome> => {
      const started = await startGoogleConnect(feature);
      const returned = readConnectReturn(await openGoogleSession(started.authorizationUrl, started.returnUrl));
      if (returned.kind === 'cancelled') return 'cancelled';
      const done = returned.kind === 'code'
        ? await completeGoogleConnect({ code: returned.code, state: returned.state })
        : await completeGoogleConnect({ error: returned.error });
      client.setQueryData(googleQueryKeys.status(uid), done.google);
      if (done.google.features.calendar) void client.invalidateQueries({ queryKey: googleQueryKeys.busy(uid) });
      return 'connected';
    },
    onError: (error) => refreshStatusOn(error, client, uid),
  });
}

export function useGoogleDisconnect() {
  const uid = useUid();
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: disconnectGoogle,
    onSuccess: (result) => {
      client.setQueryData(googleQueryKeys.status(uid), result.google);
      client.removeQueries({ queryKey: googleQueryKeys.busy(uid) });
    },
    onError: (error) => refreshStatusOn(error, client, uid),
  });
}

export function useGoogleCalendarSync() {
  const uid = useUid();
  const client = useQueryClient();
  const signedIn = useRef(uid);
  useEffect(() => { signedIn.current = uid; });
  return useMutation({
    retry: false,
    // Joins the session host's pass when one is out (CL6a round 2, N6), and
    // stamps the throttle so the host need not repeat what was just asked for.
    mutationFn: () => googlePass(uid, client, () => signedIn.current === uid),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: googleQueryKeys.busy(uid) });
    },
    onError: (error) => refreshStatusOn(error, client, uid),
  });
}

/** «جيب التزامات من إيميلي». Resolves with the proposal the review screen opens on. */
export function useGmailScan() {
  const uid = useUid();
  const client = useQueryClient();
  const timezone = useTimeZone();
  return useMutation({
    retry: false,
    // The app's language: the proposed titles are in it (owner request 2026-09-30).
    mutationFn: (): Promise<ShareProposal> => scanGmail({ timezone, locale: apiLocale() }),
    onError: (error) => refreshStatusOn(error, client, uid),
  });
}

export type DrivePickOutcome =
  | { kind: 'proposal'; proposal: ShareProposal }
  | { kind: 'cancelled' }
  | { kind: 'expired' }
  | { kind: 'failed' };

/** «اختار ملف من Drive»: a one-time Picker page, then the one file picked. */
export function useDrivePick() {
  const uid = useUid();
  const client = useQueryClient();
  const timezone = useTimeZone();
  return useMutation({
    retry: false,
    mutationFn: async (): Promise<DrivePickOutcome> => {
      const ticket = await beginDrivePick();
      const picked = readPickReturn(await openGoogleSession(ticket.pickerUrl, ticket.returnUrl));
      if (picked.kind !== 'file') return picked;
      return { kind: 'proposal', proposal: await importDriveFile({ fileId: picked.fileId, timezone, locale: apiLocale() }) };
    },
    onError: (error) => refreshStatusOn(error, client, uid),
  });
}
