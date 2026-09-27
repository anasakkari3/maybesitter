/**
 * The Google connection's queries and actions (CL6a).
 *
 * Kept beside the feature rather than in `src/api/queries.ts` so the three
 * rows are one directory; the rules of `src/api/` still hold here — keys are
 * scoped by uid, nothing is persisted, nothing is logged, and no mutation is
 * retried (each one mints or spends something on the server).
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useUid } from '../../api/queries';
import { useTimeZone } from '../../i18n/timezone';
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

/**
 * Google busy time in the shape the Calendar tab already draws.
 *
 * The read first asks the server to refresh from Google (fourteen days,
 * through the same writer the phone's calendar uses), then lists what is
 * stored. A refresh the server refuses — the Trust Center's calendar switch is
 * off, Google is down — still shows what is stored: the list is the truth the
 * planner is using. Fifteen minutes fresh, like the phone's own sync.
 */
export function useGoogleBusyBlocks(): DeviceBusyBlock[] {
  const uid = useUid();
  const status = useGoogleStatus();
  const query = useQuery({
    queryKey: googleQueryKeys.busy(uid),
    queryFn: async () => {
      await syncGoogleCalendar().catch(() => undefined);
      const { blocks } = await listGoogleBusy();
      return blocks.map((block) => ({
        nativeId: block.blockId,
        startAt: block.startAt,
        endAt: block.endAt,
        allDay: block.allDay,
      }));
    },
    enabled: uid !== 'signed-out' && googleCalendarOn(status.data),
    staleTime: 15 * 60_000,
  });
  return googleCalendarOn(status.data) ? query.data ?? NO_BLOCKS : NO_BLOCKS;
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
  return useMutation({
    retry: false,
    mutationFn: syncGoogleCalendar,
    onSuccess: () => { void client.invalidateQueries({ queryKey: googleQueryKeys.busy(uid) }); },
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
    mutationFn: (): Promise<ShareProposal> => scanGmail({ timezone }),
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
      return { kind: 'proposal', proposal: await importDriveFile({ fileId: picked.fileId, timezone }) };
    },
    onError: (error) => refreshStatusOn(error, client, uid),
  });
}
