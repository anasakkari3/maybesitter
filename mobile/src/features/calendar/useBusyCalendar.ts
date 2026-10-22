/**
 * Where the busy-time sync is actually run (UC-3.2, #186).
 *
 * The same shape as `useDeviceCalendarSync` for UC-3.1, and for the same
 * reasons: one module-level in-flight flag for the whole process, a host
 * component mounted in `Root` so the feature works on every screen rather than
 * only the one that configures it, and every decision pushed down into pure
 * functions (`busySyncDecision`, `toBusyBlocks`) that a test can reach without a
 * device.
 *
 * ── The cache is a query, and the chips read it ──────────────────
 *
 * `useBusyBlocks` is a TanStack query over AsyncStorage rather than over the
 * network. That is deliberate: the chip has to render on a train, the value is
 * shared by three screens, and a query key means a finished sync invalidates
 * every one of them at once instead of each screen holding its own copy.
 *
 * `src/api/`'s rule that nothing is persisted still stands — this is not in
 * `src/api/`, and what is kept is four fields per block with no commitment text
 * and nothing naming what any of the time is for. See `lib/deviceSettings/
 * calendarBusy.ts`.
 *
 * ── Disconnect clears the phone first, and turns the switch off ──
 *
 * `disconnect` empties the local cache before it calls the server, and reports
 * the server half separately. Somebody who pressed "disconnect and delete" on a
 * train must not be left with their busy times still on the screen because a
 * request timed out; and the copy tells them plainly which half did not happen.
 *
 * It also turns the Trust Center's calendar consent off, and that part is here
 * rather than on the settings screen because forgetting it would undo the whole
 * button. Clearing the cache clears the last sync time with it, so the
 * throttle no longer holds anything back — the very next time the app came to
 * the front it would read the calendar again and upload everything that had
 * just been deleted. A disconnect that reconnects itself within the minute is
 * worse than no button at all.
 */
import { useCallback, useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { beginCalendarConsentOperation, calendarConsentEffective, queryKeys, useTrust, useTrustAction, useUid } from '../../api/queries';
import { getAuthRepository } from '../../api/auth';
import { deleteCalendarBusy, postCalendarBusy } from '../../api/endpoints/calendar';
import { calendarReadEnabled } from '../../config/env';
import {
  loadBusySyncedAt,
  loadDeviceBusy,
  saveBusySyncedAt,
  saveCachedBusyBlocks,
  uncoverCachedBusyBlocks,
  type DeviceBusyCache,
} from '../../lib/deviceSettings/calendarBusy';
import { loadExcludedCalendarIds, loadWrittenEventIds, resolveWriterId } from '../../lib/deviceSettings/calendarDevice';
import { invalidateDeviceBusyCache, loadChoiceEnrolledAt, loadSourceStrict } from '../../lib/deviceSettings/calendarChoice';
import { readSourceCredential, resetSourceCredentialForTests } from '../../lib/deviceSettings/sourceCredential';
import { clearCalendarBusyM5, postBusyIntent } from '../../api/endpoints/m5a';
import { fetchM5aCapabilities } from '../m5a/capabilities';
import {
  refreshM5aView,
  rejoinPhone,
  resetM5aCalendarForTests,
  resolveCalendarMode,
  runM5aPass,
  startSelection,
  useM5aCalendarView,
} from './m5aCalendar';
import { deviceCalendar, BUSY_LOOK_AHEAD_DAYS } from './deviceCalendar';
import type { DeviceBusyBlock } from './busyBlocks';
import {
  busySyncDecision,
  deviceSourceId,
  runBusySync,
  type BusySyncOutcome,
  type BusySyncPorts,
  type BusySyncTrigger,
} from './busySync';

export const busyQueryKeys = {
  blocks: (uid: string) => ['user', uid, 'calendarBusy'] as const,
};

/**
 * Whether a pass is running, for the process rather than for one hook.
 *
 * Module-level for the reason UC-3.1's flag is: the hook is mounted by the host
 * in `Root` and again by the settings screen, and two passes would read the
 * same calendar twice and upload the same window twice within a second of each
 * other.
 */
let passInFlight = false;
/** The pass running now, so a disconnect can wait for an upload already sent. */
let activePass: Promise<unknown> | null = null;
/**
 * Moved on by every disconnect. A pass begun before it caches, uploads and
 * records nothing more, even for the same account (M4a, M4A-R4-REV-001).
 */
let passGeneration = 0;
/**
 * The account whose calendar was disconnected, until the hooks hold a trust
 * answer fetched after the consent request settled (M4A-R5-REV-001,
 * R6-REV-002/003).
 *
 * The consent switch only invalidates the trust query, so for a moment after
 * a disconnect every hook still holds `consented: true`, and a foreground pass
 * then would put the deleted busy times back on the phone. Only an answer the
 * server gave after the request settled says what the consent is now: off, and
 * the consent itself keeps passes from starting; on (the request never applied,
 * or it was turned back on elsewhere), and syncing resumes. Its answer may
 * have been lost even though it applied, so an error proves nothing either.
 * `settled` is the trust query as it stood when the request settled, null
 * while the request is still out: which query it was, and its count of
 * answers. Fetches begun before then are cancelled at that moment, so only a
 * later answer moves the count. Every account change clears the query cache
 * (`ApiProvider`), and a query made after that holds only later answers,
 * whatever its count (M4A-R7-REV-001).
 *
 * Numbers only: the query holds the account's trust answer, and a sign-out
 * leaves none of an account's data in memory (M4A-R8-REV-001). Which query it
 * was is a number from `queryIds`, whose keys the cache is free to drop.
 */
let withdrawn: { uid: string; settled: { queryId: number; answers: number } | null } | null = null;

const queryIds = new WeakMap<object, number>();
let nextQueryId = 1;

/** A number for this query object, the same one every time; 0 for none. */
function queryIdOf(query: object | undefined): number {
  if (!query) return 0;
  let id = queryIds.get(query);
  if (id === undefined) {
    id = nextQueryId;
    nextQueryId += 1;
    queryIds.set(query, id);
  }
  return id;
}

function trustQuery(client: QueryClient, uid: string) {
  return client.getQueryCache().find({ queryKey: queryKeys.trust(uid), exact: true });
}

/** Whether the trust query holds an answer given after `settled`. */
function answeredSince(client: QueryClient, uid: string, settled: { queryId: number; answers: number }): boolean {
  const query = trustQuery(client, uid);
  if (!query) return false;
  return queryIdOf(query) === settled.queryId
    ? query.state.dataUpdateCount > settled.answers
    : query.state.dataUpdateCount > 0;
}

/** Tests only: what the disconnect mark holds. */
export function busySyncMarkForTests(): typeof withdrawn {
  return withdrawn;
}

export function resetBusySyncForTests(): void {
  // A pass still running from before stops at its next check.
  passGeneration += 1;
  passInFlight = false;
  activePass = null;
  withdrawn = null;
  resetM5aCalendarForTests();
  resetSourceCredentialForTests();
}

/**
 * This account's device cache: the last busy blocks it read, and the window
 * they honestly cover (M4a). Never another account's (M4A-R8-001).
 */
export function useDeviceBusy(): { data: DeviceBusyCache | undefined; isPending: boolean; isError: boolean } {
  const uid = useUid();
  // Consent off, said by the server: nothing of the cache is shown from this
  // render on, while its removal from the disk is still on its way (owner
  // decision 2026-10-09; inspection FU-002). A loading or failed answer says
  // nothing about consent, so the cache stays visible then.
  const consentOff = useTrust().data?.trust?.calendarConsent === false;
  const query = useQuery({
    queryKey: busyQueryKeys.blocks(uid),
    queryFn: () => loadDeviceBusy(uid),
    enabled: uid !== 'signed-out',
    // Read once and then only when a sync says so. The value changes on a
    // fifteen-minute cadence at most, and re-reading a file on every screen
    // focus would buy nothing.
    staleTime: Infinity,
  });
  if (consentOff) return { data: NOTHING_READ, isPending: false, isError: false };
  return { data: query.data, isPending: query.isPending, isError: query.isError };
}

const NOTHING_READ: DeviceBusyCache = { blocks: [], coverage: null, syncedAt: null };

/** The last busy blocks this device read for this account. Empty until the first sync. */
export function useBusyBlocks(): DeviceBusyBlock[] {
  return useDeviceBusy().data?.blocks ?? EMPTY_BLOCKS;
}

const EMPTY_BLOCKS: DeviceBusyBlock[] = [];

/** The window one sync covers, as the device reads it. */
function windowFrom(now: Date): { startAt: string; endAt: string } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + BUSY_LOOK_AHEAD_DAYS);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

/**
 * `stillCurrent`: whether the pass's account is still signed in. The cache
 * writes ask it again right before they write, after their own read
 * (M4A-R3-REV-001).
 */
function apiBusyPorts(owner: string, stillCurrent: () => boolean): BusySyncPorts {
  return {
    // Calendars switched off in Calendar settings are never read (L7). A
    // never-enrolled phone only: an enrolled one reads what it chose (M5a).
    readBusy: async (ownEventIds, now) => deviceCalendar.fetchBusyBlocks({
      ownEventIds, now, excludedCalendarIds: new Set(await loadExcludedCalendarIds()),
    }),
    ownEventIds: () => loadWrittenEventIds(owner),
    cache: (blocks, coverage) => saveCachedBusyBlocks(owner, blocks, coverage, stillCurrent),
    uncover: () => uncoverCachedBusyBlocks(owner, stillCurrent),
    upload: async (body) => { await postCalendarBusy(body, { asUid: owner }); },
    recordSync: (at) => saveBusySyncedAt(owner, at, stillCurrent),
  };
}

/**
 * What a screen may do about busy time.
 *
 * Deliberately no `running` flag and no last-`outcome`. Both existed and
 * nothing rendered either of them — and holding them meant `syncNow` called
 * `setState` synchronously, which React 19's `set-state-in-effect` rule
 * correctly reports as an error for a function a mounting effect calls. A piece
 * of state no screen reads is not a feature waiting to be used; it is a
 * cascading render and a lie about what this hook is for. The count on the
 * settings screen comes from `useBusyBlocks`, which is the cache itself.
 */
export interface BusyCalendarState {
  /** Runs a pass. Returns null when one was already in flight. */
  syncNow(trigger: BusySyncTrigger, options?: { skipProbe?: boolean }): Promise<BusySyncOutcome | null>;
  /** Clears the phone, then the account, then the switch. */
  disconnect(): Promise<{ local: true; server: boolean }>;
  /**
   * M5a: the calendars this account reads on this phone. Rejects with
   * `SelectionNotSavedError` when the choice could not be saved; nothing was
   * sent then (M5A-R51-001).
   */
  chooseCalendars(included: readonly string[]): Promise<void>;
  /** One calendar on or off, applied to the newest selection there is (M5A-R3-005). */
  toggleCalendar(calendarId: string, on: boolean): Promise<void>;
  /** M5a «رجّع هاد التلفون»: true when this phone is a source again. */
  rejoin(): Promise<boolean>;
}

export function useBusyCalendar(): BusyCalendarState {
  const uid = useUid();
  const client = useQueryClient();
  const trust = useTrust();
  // Asked as soon as the host mounts (M5A-R2-002): a never-enrolled phone
  // reads nothing until it is answered, so it is not left waiting on trust.
  // One fetch into the shared query, not a subscription: the host draws
  // nothing, and a pass asks again (`resolveCalendarMode`) when it runs.
  useEffect(() => {
    if (uid !== 'signed-out') void fetchM5aCapabilities(client, uid);
  }, [client, uid]);
  const trustAction = useTrustAction();

  const consented = trust.data?.trust?.calendarConsent === true;
  // Read here so an answer identical to the last one still renders this hook,
  // which is what lets a disconnect's mark see the server's answer arrive.
  const trustAnsweredAt = trust.dataUpdatedAt;
  // A ref so the `AppState` listener below is registered once rather than
  // re-registered every time the trust query answers, and written in an effect
  // rather than during render so a discarded render cannot leave the sync
  // holding a consent value the user never saw.
  const latest = useRef({ uid, consented });
  useEffect(() => { latest.current = { uid, consented }; });

  /**
   * The consent as the trust query holds it now, read straight from the cache
   * rather than from a render: an effect of an earlier render can run after a
   * newer answer has landed, and the two must not disagree (M4A-R6-REV-003).
   */
  // And no switch-off on its way: that counts from the tap, before the cache
  // says so (`calendarConsentEffective`, Codex M6B-R6-001).
  const consentNow = useCallback((forUid: string) => calendarConsentEffective(client, forUid), [client]);

  const syncNow = useCallback(async (
    trigger: BusySyncTrigger,
    options: { skipProbe?: boolean } = {},
  ): Promise<BusySyncOutcome | null> => {
    const current = latest.current;
    if (passInFlight || withdrawn?.uid === current.uid) return null;
    const generation = passGeneration;
    // The signed-in account, from the repository (it changes before React's
    // state does), and the hook's own view of it; both must still be the
    // account this pass began for (M4A-REV-001, R2-REV-001), and no
    // disconnect since it began (M4A-R4-REV-001).
    const accountCurrent = () => passGeneration === generation
      && latest.current.uid === current.uid
      && (current.uid === 'signed-out' || getAuthRepository()?.currentUser()?.uid === current.uid);
    // And the consent still on (R5-REV-001).
    const stillCurrent = () => accountCurrent() && consentNow(current.uid);
    passInFlight = true;
    const pass = (async (): Promise<BusySyncOutcome | null> => {
      if (!calendarReadEnabled() || current.uid === 'signed-out') return null;
      const now = new Date();
      // M5a (R1.1): an enrolled phone, or one enrolling now, reads only what
      // the person chose; a phone whose capability is unknown reads nothing.
      const mode = await resolveCalendarMode(current.uid, client, accountCurrent);
      if (mode === 'blocked' || !accountCurrent()) return null;
      const lastSyncedAt = await loadBusySyncedAt(current.uid);
      if (mode !== 'legacy') {
        // Every host and screen mounts with a `connect`; on an enrolled phone
        // only a pull-to-refresh or a phone that never synced skips the
        // fifteen-minute throttle, so a just-finished selection upload is not
        // followed by a second one.
        const due = busySyncDecision({
          trigger: trigger === 'connect' ? 'foreground' : trigger,
          featureEnabled: true, signedIn: true, consented: true, lastSyncedAt, now,
        }).run;
        const result = await runM5aPass({
          uid: current.uid,
          stillCurrent,
          accountCurrent,
          consented: () => consentNow(current.uid),
          justEnrolled: mode === 'just_enrolled',
          lastSyncedAt,
          due,
          ...(options.skipProbe ? { skipProbe: true } : {}),
        });
        void refreshM5aView(current.uid);
        void client.invalidateQueries({ queryKey: busyQueryKeys.blocks(current.uid) });
        return result;
      }
      const writerId = await resolveWriterId();
      if (!stillCurrent()) return null;
      const result = await runBusySync(apiBusyPorts(current.uid, stillCurrent), {
        trigger,
        featureEnabled: calendarReadEnabled(),
        signedIn: current.uid !== 'signed-out',
        consented: consentNow(current.uid),
        lastSyncedAt,
        now,
        sourceId: deviceSourceId(writerId),
        platform: Platform.OS === 'android' ? 'android' : 'ios',
        window: windowFrom(now),
        // The pass belongs to the account it began for (M4A-REV-001).
        stillCurrent,
      });
      // Only a pass that actually read the calendar changed the cache.
      if (result.kind === 'synced' || result.kind === 'failed' || result.kind === 'denied') {
        void client.invalidateQueries({ queryKey: busyQueryKeys.blocks(current.uid) });
      }
      return result;
    })();
    activePass = pass;
    try {
      return await pass;
    } finally {
      passInFlight = false;
      activePass = null;
    }
  }, [client, consentNow]);

  const chooseCalendars = useCallback(async (
    included: readonly string[] | ((current: readonly string[]) => readonly string[]),
  ): Promise<void> => {
    const current = latest.current;
    // No calendar is chosen while the account's consent says off (Codex
    // M6B-R02/R3-001): a pending selection would otherwise resume the moment
    // it is turned back on. A pass's own pruning goes through startSelection
    // directly and only runs with consent on.
    if (!consentNow(current.uid)) return;
    const generation = passGeneration;
    const accountCurrent = () => passGeneration === generation
      && latest.current.uid === current.uid
      && getAuthRepository()?.currentUser()?.uid === current.uid;
    await startSelection(current.uid, included, {
      uid: current.uid,
      accountCurrent,
      stillCurrent: () => accountCurrent() && consentNow(current.uid),
      consented: () => consentNow(current.uid),
    });
    void client.invalidateQueries({ queryKey: busyQueryKeys.blocks(current.uid) });
  }, [client, consentNow]);

  const toggleCalendar = useCallback((calendarId: string, on: boolean) => chooseCalendars((current) => (on
    ? [...current.filter((id) => id !== calendarId), calendarId]
    : current.filter((id) => id !== calendarId))), [chooseCalendars]);

  const rejoin = useCallback(async (): Promise<boolean> => {
    const back = await rejoinPhone(latest.current.uid);
    if (back) void syncNow('connect', { skipProbe: true });
    return back;
  }, [syncNow]);

  const disconnectHeld = useCallback(async (): Promise<{ local: true; server: boolean }> => {
    const current = latest.current;
    // A pass already running read the calendar being disconnected: from here
    // on it keeps, sends and records nothing (M4A-R4-REV-001), and no new pass
    // starts until the server has said what the switch is (`withdrawn`).
    passGeneration += 1;
    const mark: NonNullable<typeof withdrawn> = { uid: current.uid, settled: null };
    withdrawn = mark;
    // The phone first, and unconditionally. Whatever the network does, the
    // person who pressed this sees their busy times gone from the screen.
    await invalidateDeviceBusyCache(current.uid);
    void client.invalidateQueries({ queryKey: busyQueryKeys.blocks(current.uid) });
    try {
      // An upload already on its way lands first, so the delete is the last
      // word on the server rather than something the upload undoes.
      await activePass?.catch(() => undefined);
      await deleteThisPhonesBusy(current.uid);
    } catch {
      // Nothing reached the switch, so it is still on: syncing resumes, as it
      // always has when the account could not be reached.
      if (withdrawn === mark) withdrawn = null;
      return { local: true, server: false };
    }
    try {
      // And the switch, so nothing syncs it back. See the header: clearing the
      // cache also cleared the throttle, so leaving this on would mean the next
      // trip to the home screen re-uploaded the window that was just deleted.
      if (getAuthRepository()?.currentUser()?.uid !== current.uid) return { local: true, server: false };
      await trustAction.mutateAsync({ type: 'set_calendar_consent', granted: false });
      return { local: true, server: true };
    } catch {
      return { local: true, server: false };
    } finally {
      // Settled, whichever way: the next answer the server gives says what the
      // switch is. Anything fetched before now is dropped unread.
      const query = trustQuery(client, current.uid);
      mark.settled = { queryId: queryIdOf(query), answers: query?.state.dataUpdateCount ?? 0 };
      void client.refetchQueries({ queryKey: queryKeys.trust(current.uid) }, { cancelRefetch: true });
    }
  }, [client, trustAction]);

  const disconnect = useCallback(async (): Promise<{ local: true; server: boolean }> => {
    // Every calendar-consent control stays locked from here to the last step,
    // on every screen, so nothing tapped meanwhile is overtaken by this
    // disconnect's switch-off (Codex M6B-R8-003).
    const release = beginCalendarConsentOperation(client, latest.current.uid);
    try {
      return await disconnectHeld();
    } finally {
      release();
    }
  }, [client, disconnectHeld]);


  // The server's answer has caught up with a disconnect: from here on the
  // consent itself decides. On means the switch never went off, or was turned
  // back on elsewhere, so the sync the mark held back runs now.
  useEffect(() => {
    if (withdrawn?.uid !== uid || withdrawn.settled === null) return;
    if (!answeredSince(client, uid, withdrawn.settled)) return;
    withdrawn = null;
    if (consentNow(uid)) void syncNow('connect');
  }, [uid, trustAnsweredAt, client, consentNow, syncNow]);

  // Consent withdrawn, wherever it was withdrawn — here, the Trust Center,
  // another phone — takes the phone's copy of the busy times with it (owner
  // decision 2026-10-09, M4A-R6-REV-001). It used to stay on disk, unread,
  // until a disconnect or another account. Only an answer that says off
  // clears: while the answer is loading nothing is known, and nothing goes.
  const consentOff = trust.data?.trust?.calendarConsent === false;
  // A selection's read writes the cache after the tap returned (SIM-M5A-02):
  // every write is announced, and the screens reading the cache re-read it.
  const cacheVersion = useM5aCalendarView(uid).cacheVersion;
  useEffect(() => {
    if (cacheVersion === 0 || uid === 'signed-out') return;
    void client.invalidateQueries({ queryKey: busyQueryKeys.blocks(uid) });
  }, [cacheVersion, uid, client]);
  useEffect(() => {
    if (!consentOff || uid === 'signed-out') return;
    void invalidateDeviceBusyCache(uid).then(() => client.invalidateQueries({ queryKey: busyQueryKeys.blocks(uid) }));
  }, [consentOff, uid, client]);

  // Somebody turned the switch on, or it was already on when the app started.
  useEffect(() => {
    if (!consented) return;
    void syncNow('connect');
  }, [consented, syncNow]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncNow('foreground');
    });
    return () => subscription.remove();
  }, [syncNow]);

  return { syncNow, disconnect, chooseCalendars, toggleCalendar, rejoin };
}

/**
 * "Disconnect and delete" for this phone's own busy time, bound to its account
 * (M5A-R53-002). An enrolled phone clears its registered source as a `clear`
 * operation — clearing is not removing, so the registration stays and the
 * phone can choose again (M5A-R11-002); a never-enrolled phone deletes its
 * legacy source as before.
 */
export async function deleteThisPhonesBusy(uid: string): Promise<void> {
  // Every local read is strict (M5A-R9-002): an enrolment marker or source
  // record that cannot be read fails the disconnect visibly; only a read that
  // succeeded and found nothing takes the "never registered" path.
  let enrolledAt: string | null;
  try {
    enrolledAt = uid === 'signed-out' ? null : await loadChoiceEnrolledAt(uid);
  } catch {
    throw new Error('the calendar choice could not be read');
  }
  if (enrolledAt !== null) {
    let source;
    try {
      source = await loadSourceStrict(uid);
    } catch {
      throw new Error('the source record could not be read');
    }
    let credential;
    try {
      credential = await readSourceCredential(uid);
    } catch {
      // The keychain did not answer: whether this phone has busy time on the
      // account is unknown, so the delete is not reported as done (M5A-R3-002).
      throw new Error('the source credential could not be read');
    }
    // Never registered: nothing of this phone's is on the account.
    if (!source && !credential) return;
    // Registered, but this phone can no longer prove it is that source: the
    // server half did not happen. The other-phones list can still remove it.
    if (!source || !credential || credential.sourceInstallationId !== source.sourceInstallationId) {
      throw new Error('this phone cannot clear its source');
    }
    const intent = await postBusyIntent({
      sourceId: source.sourceId, intentId: Crypto.randomUUID(), operation: 'clear', selectionDigest: 'disconnect',
    }, credential.sourceSecret, { asUid: uid });
    await clearCalendarBusyM5(source.sourceId, intent, credential.sourceSecret, { asUid: uid });
    return;
  }
  await deleteCalendarBusy(deviceSourceId(await resolveWriterId()), uid === 'signed-out' ? {} : { asUid: uid });
}

/**
 * Runs the busy-time sync for the whole signed-in session (UC-3.2, #186).
 *
 * Mounted in `Root` beside `DeviceCalendarSyncHost`, and drawing nothing.
 * Without it the chips on Today and on review would only ever be populated
 * while somebody had the calendar settings screen open, which is the one screen
 * they are not on when a conflict matters.
 */
export function BusyCalendarHost(): null {
  useBusyCalendar();
  return null;
}
