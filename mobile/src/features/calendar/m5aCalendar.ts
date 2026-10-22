/**
 * M5a on the phone: calendars chosen, not assumed (PLAN-M5a R1.1).
 *
 * ── Enrolment completes only after the server confirms ───────────
 *
 * The first time the app sees `calendarChoice` on, it writes the per-account
 * pending marker (awaited) and reads nothing until the server answers
 * `active` (M5A-R9-004). The always-available `GET /calendar/choice` can also
 * finish it after a lost response or a restart (M5A-R51-005). From then on
 * only the calendars the person turned on are read, whatever the flag says
 * later (M5A-001, M5A-R2-003).
 *
 * ── The server hears about a selection before the phone reads it ─
 *
 * A change of selection is a recoverable two-phase operation (M5A-R51-001,
 * M5A-R52-001/002): the one pending record is written first, the server
 * starts the operation and mints its epoch, and only then is the list applied,
 * the calendar read and the upload (or the clear) sent as that operation. A
 * restart resumes from the record. A newer selection supersedes an older one
 * whose answer arrives late (M5A-R54-001).
 *
 * ── A routine refresh reads first ────────────────────────────────
 *
 * With no selection change, a pass reads the chosen calendars and only then
 * asks for an operation and uploads, so an account switch during the read
 * sends nothing at all (M5A-R53-002).
 *
 * ── A removed phone stays removed ────────────────────────────────
 *
 * On `source_revoked`, or a probe that says `revoked`, the barrier is written
 * before the credential is deleted (M5A-R59-001); while it is set nothing
 * mints, registers or reads, until «رجّع هاد التلفون» registers a brand-new
 * source (M5A-R60-001). A held credential the server no longer knows
 * (`sourceStatus: null`) fails closed.
 *
 * Every request is bound to the account it began for (`asUid`), and every
 * step re-checks it.
 */
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import type { QueryClient } from '@tanstack/react-query';
import { getAuthRepository } from '../../api/auth';
import { M5aRefusedError } from '../../api/errors';
import {
  clearCalendarBusyM5,
  enrolCalendarChoice,
  postBusyIntent,
  postCalendarBusyM5,
  probeCalendarChoice,
  registerBusySource,
  type BusyContinuation,
} from '../../api/endpoints/m5a';
import {
  applyIncludedCalendarIds,
  clearRejoinInstallation,
  clearRemovedInstallation,
  loadRejoinInstallation,
  saveRejoinInstallation,
  saveRemovedInstallation,
  invalidateDeviceBusyCache,
  bumpInclusionGeneration,
  clearPhoneRemoved,
  finishChoiceEnrolment,
  loadChoiceEnrolledAt,
  loadChoicePending,
  loadIncludedCalendarIds,
  loadPendingSelection,
  loadPhoneRemoved,
  loadSource,
  removePendingSelection,
  removeSource,
  saveChoicePending,
  savePendingSelection,
  savePhoneRemoved,
  saveSource,
  type PendingSelection,
} from '../../lib/deviceSettings/calendarChoice';
import {
  deleteSourceCredential,
  ensureSourceCredential,
  mintFreshSourceCredential,
  readSourceCredential,
} from '../../lib/deviceSettings/sourceCredential';
import {
  clearCachedBusyBlocksOf,
  holdsCachedBusyBlocksOf,
  loadInclusionGeneration,
  saveBusySyncedAt,
  saveCachedBusyBlocks,
  uncoverCachedBusyBlocks,
} from '../../lib/deviceSettings/calendarBusy';
import { loadWrittenEventIds } from '../../lib/deviceSettings/calendarDevice';
import { fetchM5aCapabilities } from '../m5a/capabilities';
import { BUSY_LOOK_AHEAD_DAYS, deviceCalendar } from './deviceCalendar';
import { BUSY_SYNC_UPLOAD_LIMIT, busyUploadFor, fitToLimit, type BusySyncOutcome } from './busySync';
import type { DeviceBusyBlock } from './busyBlocks';

/* ── what the screen shows ───────────────────────────────────────── */

export interface M5aCalendarView {
  /** True once this account's local state has been read. */
  loaded: boolean;
  enrolled: boolean;
  /** The applied list; null when it could not be read (reads are blocked). */
  included: string[] | null;
  /** The selection being applied, shown as the switches' state until it lands. */
  pending: PendingSelection | null;
  saveFailed: boolean;
  clearFailed: boolean;
  tooManyPhones: boolean;
  removed: boolean;
  /** This phone's own source id, so the other-phones list leaves it out. */
  sourceId: string | null;
  /**
   * Bumped whenever this account's busy cache on disk changes, so the screens
   * reading it re-read (SIM-M5A-02: a selection's read lands after the tap's
   * own re-read, and nothing else asked again).
   */
  cacheVersion: number;
}

const INITIAL: M5aCalendarView = {
  loaded: false, enrolled: false, included: [], pending: null,
  saveFailed: false, clearFailed: false, tooManyPhones: false, removed: false, sourceId: null,
  cacheVersion: 0,
};

const views = new Map<string, M5aCalendarView>();
const listeners = new Set<() => void>();

function viewOf(uid: string): M5aCalendarView {
  return views.get(uid) ?? INITIAL;
}

function patch(uid: string, change: Partial<M5aCalendarView>): void {
  views.set(uid, { ...viewOf(uid), ...change });
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useM5aCalendarView(uid: string): M5aCalendarView {
  return useSyncExternalStore(subscribe, () => viewOf(uid), () => viewOf(uid));
}

/** The switches' state: what is being applied, else what is applied. */
export function shownIncluded(view: M5aCalendarView): string[] {
  return view.pending?.included ?? view.included ?? [];
}

/** Reads this account's local state into the view (screen mount, and after a pass). */
export async function refreshM5aView(uid: string): Promise<void> {
  let enrolled = false;
  let included: string[] | null = [];
  let pending: PendingSelection | null = null;
  let removed = false;
  let saveFailed = false;
  try {
    enrolled = (await loadChoiceEnrolledAt(uid)) !== null;
  } catch {
    saveFailed = true;
  }
  try {
    included = await loadIncludedCalendarIds(uid);
  } catch {
    included = null;
    saveFailed = true;
  }
  try {
    pending = await loadPendingSelection(uid);
  } catch {
    saveFailed = true;
  }
  try {
    removed = await loadPhoneRemoved(uid);
  } catch {
    removed = true;
  }
  const source = await loadSource(uid);
  patch(uid, {
    loaded: true, enrolled, included, pending, removed,
    saveFailed: saveFailed || viewOf(uid).saveFailed,
    sourceId: source?.sourceId ?? null,
  });
}

/** Tests only. */
export function resetM5aCalendarForTests(): void {
  lifetime += 1;
  views.clear();
  continuations.clear();
  registrations.clear();
  rejoins.clear();
  pendingLocks.clear();
  savedSequence.clear();
  selectionGeneration = 0;
}

/* ── guards ──────────────────────────────────────────────────────── */

/**
 * Moved on by every confirmed selection write: a pass that loaded an older
 * selection writes nothing more locally (M5A-R12-002).
 */
let selectionGeneration = 0;

/** Moved on by a reset: work begun before it stops at its next check. */
let lifetime = 0;

export function currentSelectionGeneration(): number {
  return selectionGeneration;
}

function signedInAs(uid: string): boolean {
  return getAuthRepository()?.currentUser()?.uid === uid;
}

/** A guard that also turns false after a reset. */
function withinLifetime(guard: () => boolean): () => boolean {
  const life = lifetime;
  return () => life === lifetime && guard();
}

const randomId = () => Crypto.randomUUID();

async function digestOf(included: readonly string[]): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify([...new Set(included)].sort()));
}

function windowFrom(now: Date): { startAt: string; endAt: string } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + BUSY_LOOK_AHEAD_DAYS);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

const platform = (): 'ios' | 'android' => (Platform.OS === 'android' ? 'android' : 'ios');

/* ── enrolment ───────────────────────────────────────────────────── */

export type CalendarMode = 'enrolled' | 'just_enrolled' | 'legacy' | 'blocked';

/**
 * Which calendar behaviour this pass runs, enrolling first when the flag is
 * on (M5A-R2-002, M5A-R9-004, M5A-R51-005). `blocked`: nothing is read.
 */
export async function resolveCalendarMode(
  uid: string,
  client: QueryClient,
  stillCurrent: () => boolean,
): Promise<CalendarMode> {
  let enrolledAt: string | null;
  let pending: string | null;
  try {
    enrolledAt = await loadChoiceEnrolledAt(uid);
    pending = await loadChoicePending(uid);
  } catch {
    patch(uid, { saveFailed: true });
    return 'blocked';
  }
  if (enrolledAt !== null) {
    patch(uid, { enrolled: true });
    return 'enrolled';
  }
  let fresh = false;
  if (pending === null) {
    // Unknown (no answer yet, or only errors) reads nothing on a phone that
    // never enrolled; known false is today's behaviour exactly.
    const capabilities = await fetchM5aCapabilities(client, uid);
    if (!stillCurrent() || capabilities === null) return 'blocked';
    if (!capabilities.calendarChoice) return 'legacy';
    try {
      await saveChoicePending(uid, new Date());
    } catch {
      patch(uid, { saveFailed: true });
      return 'blocked';
    }
    fresh = true;
  }
  if (!stillCurrent()) return 'blocked';
  if (!fresh) {
    try {
      const probe = await probeCalendarChoice(null, { asUid: uid });
      if (!stillCurrent()) return 'blocked';
      if (probe.enrolled && probe.state === 'active') return finishEnrolment(uid, new Date().toISOString());
    } catch {
      // The POST below asks again.
    }
  }
  try {
    const answer = await enrolCalendarChoice({ asUid: uid });
    if (!stillCurrent()) return 'blocked';
    if (answer.state === 'active') return finishEnrolment(uid, answer.enrolledAt);
  } catch {
    // Still pending: the next foreground or headless pass retries.
  }
  return 'blocked';
}

async function finishEnrolment(uid: string, enrolledAt: string): Promise<CalendarMode> {
  try {
    // A new inclusion generation before the enrolled state exists (R1.1c): a
    // cache read under the old opt-out rule can never match it again, even if
    // removing that cache fails below.
    await bumpInclusionGeneration(uid);
    await finishChoiceEnrolment(uid, enrolledAt);
  } catch {
    patch(uid, { saveFailed: true });
    return 'blocked';
  }
  // Busy time read under the old opt-out rule never shows again.
  await clearCachedBusyBlocksOf(uid);
  patch(uid, { enrolled: true, loaded: true });
  return 'just_enrolled';
}

/* ── this phone's source ─────────────────────────────────────────── */

type SourceOutcome =
  | { kind: 'ready'; sourceId: string; secret: string }
  | { kind: 'no_store' | 'too_many' | 'revoked' | 'failed' | 'removed' };

const registrations = new Map<string, Promise<SourceOutcome>>();

/**
 * This phone's registered source for the account: the credential is minted
 * and persisted first, then registered (M5A-R55-001). Shared between every
 * caller, so a cold start registers once (M5A-R56-001). Never while the
 * removed barrier is set.
 */
export function ensureRegisteredSource(uid: string): Promise<SourceOutcome> {
  const running = registrations.get(uid);
  if (running) return running;
  const task: Promise<SourceOutcome> = registerOnce(uid).finally(() => {
    if (registrations.get(uid) === task) registrations.delete(uid);
  });
  registrations.set(uid, task);
  return task;
}

async function registerOnce(uid: string): Promise<SourceOutcome> {
  let removed: boolean;
  try {
    removed = await loadPhoneRemoved(uid);
  } catch {
    removed = true;
  }
  if (removed) return { kind: 'removed' };
  const credential = await ensureSourceCredential(uid);
  if (!credential) {
    patch(uid, { saveFailed: true });
    return { kind: 'no_store' };
  }
  // The removal barrier is read again after every wait: a removal that lands
  // while this resolver runs stops it before it registers or hands out a
  // secret (M5A-R3-001).
  if (await barrierSet(uid)) return { kind: 'removed' };
  const stored = await loadSource(uid);
  if (stored && stored.sourceInstallationId === credential.sourceInstallationId) {
    if (await barrierSet(uid)) return { kind: 'removed' };
    return { kind: 'ready', sourceId: stored.sourceId, secret: credential.sourceSecret };
  }
  if (!signedInAs(uid)) return { kind: 'failed' };
  try {
    const answer = await registerBusySource(credential, { asUid: uid });
    if (await barrierSet(uid)) {
      await deleteSourceCredential(uid);
      return { kind: 'removed' };
    }
    await saveSource(uid, { sourceId: answer.sourceId, sourceInstallationId: credential.sourceInstallationId });
    patch(uid, { tooManyPhones: false, sourceId: answer.sourceId });
    return { kind: 'ready', sourceId: answer.sourceId, secret: credential.sourceSecret };
  } catch (error) {
    if (error instanceof M5aRefusedError && error.code === 'too_many_phones') {
      patch(uid, { tooManyPhones: true });
      return { kind: 'too_many' };
    }
    if (error instanceof M5aRefusedError && error.code === 'source_revoked') {
      await markPhoneRemoved(uid, { fromRegistration: true });
      return { kind: 'revoked' };
    }
    return { kind: 'failed' };
  }
}

/** The source a selection registered, with its secret; null when there is none. Never mints or registers. */
async function registeredSource(uid: string): Promise<{ kind: 'ready'; sourceId: string; secret: string } | null> {
  const stored = await loadSource(uid);
  if (!stored) return null;
  let credential;
  try {
    credential = await readSourceCredential(uid);
  } catch {
    return null;
  }
  if (!credential || credential.sourceInstallationId !== stored.sourceInstallationId) return null;
  return { kind: 'ready', sourceId: stored.sourceId, secret: credential.sourceSecret };
}

/** The removal barrier, read now; unreadable counts as set. */
async function barrierSet(uid: string): Promise<boolean> {
  try {
    return await loadPhoneRemoved(uid);
  } catch {
    return true;
  }
}

/** The barrier first, then the credential (M5A-R59-001). */
async function markPhoneRemoved(uid: string, options: { fromRegistration?: boolean } = {}): Promise<void> {
  try {
    await savePhoneRemoved(uid, new Date());
  } catch {
    // Without a written barrier the credential is kept: the next probe says
    // `revoked` again and this runs again. Nothing is read meanwhile.
    patch(uid, { removed: true });
    return;
  }
  // The cache goes straight after the barrier (M5A-R5-001): nothing awaited in
  // between can leave a removed phone's busy time matching.
  await invalidateDeviceBusyCache(uid);
  // A registration already under way finishes against the barrier (it reads
  // it again) before the credential goes, so nothing mints after the delete.
  if (!options.fromRegistration) await registrations.get(uid)?.catch(() => undefined);
  // Which tuple was removed, in case its delete below fails and it survives:
  // a rejoin never sends it again (M5A-R6-003).
  const removedTuple = await readSourceCredential(uid).catch(() => null);
  if (removedTuple) await saveRemovedInstallation(uid, removedTuple.sourceInstallationId).catch(() => undefined);
  await deleteSourceCredential(uid);
  await removeSource(uid);
  await invalidateDeviceBusyCache(uid);
  patch(uid, { removed: true, sourceId: null });
}

/**
 * «رجّع هاد التلفون» (M5A-R60-001): a new credential, persisted, registered
 * as a new source; only then does the barrier go. It stays when any step
 * fails. One rejoin at a time per account, and a retry after a lost response
 * reuses the tuple it persisted instead of registering yet another source —
 * the removed phone's own tuple was deleted when it was removed, and if that
 * delete had failed, the server's `source_revoked` makes a fresh one here.
 * Answers true when the phone is back.
 */
const rejoins = new Map<string, Promise<boolean>>();

export function rejoinPhone(uid: string): Promise<boolean> {
  const running = rejoins.get(uid);
  if (running) return running;
  const task: Promise<boolean> = rejoinOnce(uid).finally(() => {
    if (rejoins.get(uid) === task) rejoins.delete(uid);
  });
  rejoins.set(uid, task);
  return task;
}

async function rejoinOnce(uid: string): Promise<boolean> {
  // A rejoin starts from a tuple of its own (M5A-R6-003, M5A-R7-002): unless
  // the stored credential is the one a previous rejoin minted (a retry after a
  // lost response), a fresh one is minted and marked before any request — so
  // the removed tuple is never sent, even when the removal was interrupted
  // before it could record which tuple that was.
  let credential = await readSourceCredential(uid).catch(() => null);
  const prepared = await loadRejoinInstallation(uid);
  // The marker must be stored before any request (M5A-R8-003): without it a
  // lost response would leave a retry unable to recognise its own tuple.
  const markFresh = async (): Promise<boolean> => {
    credential = await mintFreshSourceCredential(uid);
    if (!credential) return false;
    try {
      await saveRejoinInstallation(uid, credential.sourceInstallationId);
      return true;
    } catch {
      return false;
    }
  };
  if (!credential || prepared === null || credential.sourceInstallationId !== prepared) {
    if (!await markFresh()) {
      patch(uid, { saveFailed: true });
      return false;
    }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!credential) {
      patch(uid, { saveFailed: true });
      return false;
    }
    if (!signedInAs(uid)) return false;
    try {
      const answer = await registerBusySource(credential, { asUid: uid });
      await saveSource(uid, { sourceId: answer.sourceId, sourceInstallationId: credential.sourceInstallationId });
      await clearPhoneRemoved(uid);
      await clearRemovedInstallation(uid).catch(() => undefined);
      await clearRejoinInstallation(uid).catch(() => undefined);
      patch(uid, { removed: false, tooManyPhones: false, sourceId: answer.sourceId });
      return true;
    } catch (error) {
      if (error instanceof M5aRefusedError && error.code === 'source_revoked' && attempt === 0) {
        // The tuple that was removed survived its delete: replace it once,
        // marked before the retry is sent (M5A-R8-003).
        if (!await markFresh()) {
          patch(uid, { saveFailed: true });
          return false;
        }
        continue;
      }
      if (error instanceof M5aRefusedError && error.code === 'too_many_phones') patch(uid, { tooManyPhones: true });
      return false;
    }
  }
  return false;
}

/* ── one pass ────────────────────────────────────────────────────── */

export interface M5aPassContext {
  uid: string;
  /** The account, the disconnect generation and the consent, as the hook checks them. */
  stillCurrent: () => boolean;
  /** The account and the disconnect generation only: a selection's clear runs whatever the consent. */
  accountCurrent: () => boolean;
  consented: () => boolean;
  /** Just enrolled: one read with the (empty) selection, so the cache is this rule's. */
  justEnrolled: boolean;
  /** A rejoin just registered this source: the probe would still describe the old one. */
  skipProbe?: boolean;
  lastSyncedAt: number | null;
  /** Whether the throttle lets a routine refresh run now. */
  due: boolean;
}

const SKIPPED: BusySyncOutcome = { kind: 'skipped', because: 'no_consent' };
const GONE: BusySyncOutcome = { kind: 'skipped', because: 'signed_out' };

/** An enrolled account's pass: probe, resume a pending selection, else refresh. */
export async function runM5aPass(context: M5aPassContext): Promise<BusySyncOutcome | null> {
  const { uid } = context;
  const stillCurrent = withinLifetime(context.stillCurrent);
  let removed: boolean;
  try {
    removed = await loadPhoneRemoved(uid);
  } catch {
    removed = true;
  }
  const source = removed ? null : await loadSource(uid);
  let held = false;
  if (!removed) {
    try {
      held = (await readSourceCredential(uid)) !== null;
    } catch {
      // An unreadable secure store is not "no credential": nothing is read
      // until it answers again (R1.1, M5A-R55-001).
      patch(uid, { saveFailed: true });
      return SKIPPED;
    }
  }
  // Just enrolled: the purge took every phone source with it, so there is no
  // source of this phone's to ask about yet.
  if (!context.skipProbe && !context.justEnrolled) {
    let probe: Awaited<ReturnType<typeof probeCalendarChoice>>;
    try {
      probe = await probeCalendarChoice(source?.sourceId ?? null, { asUid: uid });
    } catch {
      // No answer is not "not revoked": the pass stops before anything is
      // read (M5A-R11-004), and the next one asks again.
      return SKIPPED;
    }
    if (!stillCurrent()) return GONE;
    if (!removed && probe.sourceStatus === 'revoked') {
      await markPhoneRemoved(uid);
      return SKIPPED;
    }
    if (!removed && source && held && probe.sourceStatus === null) {
      // The server no longer knows this credential: fail closed. The next
      // selection registers a new source.
      await deleteSourceCredential(uid);
      await removeSource(uid);
      patch(uid, { sourceId: null });
      return SKIPPED;
    }
  }
  patch(uid, { removed });
  if (removed) {
    // A removal interrupted before its invalidation (the app was killed) is
    // finished here, on the next pass after a restart (M5A-R5-001).
    if (await holdsCachedBusyBlocksOf(uid)) await invalidateDeviceBusyCache(uid);
    return SKIPPED;
  }

  let pending: PendingSelection | null;
  try {
    pending = await loadPendingSelection(uid);
  } catch {
    patch(uid, { saveFailed: true });
    return SKIPPED;
  }
  if (pending) {
    await continueSelection(uid, pending, context);
    return null;
  }
  if (!context.consented()) return SKIPPED;
  let included: string[];
  try {
    included = await loadIncludedCalendarIds(uid);
  } catch {
    patch(uid, { included: null, saveFailed: true });
    return SKIPPED;
  }
  patch(uid, { included });
  // A calendar gone from the phone leaves the list on the next successful
  // read (R1.1, M5A-R4-003), as a selection change of its own; a list that
  // could not be read changes nothing.
  if (included.length > 0) {
    let present: Set<string> | null = null;
    try {
      // Only a granted, successful listing says which calendars exist; an
      // empty one is an answer too — the last calendar was deleted
      // (M5A-R5-002). Without access, or on a failed read, nothing is pruned.
      if ((await deviceCalendar.getAccess()) === 'granted') {
        present = new Set((await deviceCalendar.listEventCalendars()).map((calendar) => calendar.id));
      }
    } catch {
      present = null;
    }
    if (!stillCurrent()) return GONE;
    if (present && included.some((id) => !present!.has(id))) {
      await startSelection(uid, (current) => current.filter((id) => present!.has(id)), context).catch(() => undefined);
      return null;
    }
  }
  if (included.length === 0 && !context.justEnrolled) return SKIPPED;
  if (!context.due && !context.justEnrolled) return { kind: 'skipped', because: 'too_soon' };
  const generation = selectionGeneration;
  return readAndUpload(uid, included, null, () => stillCurrent() && selectionGeneration === generation);
}

/**
 * Reads the chosen calendars, keeps them, then uploads as `operation` — or,
 * on a routine refresh (`operation` null), asks for one only after the read.
 */
async function readAndUpload(
  uid: string,
  included: readonly string[],
  operation: (BusyContinuation & { sourceId: string; secret: string }) | null,
  stillCurrent: () => boolean,
): Promise<BusySyncOutcome> {
  const now = new Date();
  const window = windowFrom(now);
  if (!stillCurrent()) return GONE;
  // The selection this pass reads for, fixed before the read (M5A-R6-001).
  const generation = await loadInclusionGeneration(uid);
  if (generation === null || !stillCurrent()) return GONE;
  let blocks: DeviceBusyBlock[];
  try {
    const own = new Set(await loadWrittenEventIds(uid));
    if (!stillCurrent() || await barrierSet(uid)) return GONE;
    blocks = await deviceCalendar.fetchBusyBlocks({ ownEventIds: own, now, includedCalendarIds: new Set(included) });
  } catch {
    if (!stillCurrent()) return GONE;
    await uncoverCachedBusyBlocks(uid, stillCurrent, generation);
    return { kind: 'denied' };
  }
  if (!stillCurrent()) return GONE;
  let fitted: { capped: readonly DeviceBusyBlock[]; windowEnd: string } | null;
  try {
    fitted = fitToLimit(window, blocks);
  } catch {
    fitted = null;
  }
  await saveCachedBusyBlocks(uid, fitted ? fitted.capped : blocks.slice(0, BUSY_SYNC_UPLOAD_LIMIT),
    fitted ? { startAt: window.startAt, endAt: fitted.windowEnd } : null, stillCurrent, generation);
  patch(uid, { cacheVersion: viewOf(uid).cacheVersion + 1 });
  // Nothing chosen: nothing is uploaded until something is (D8).
  if (included.length === 0) return { kind: 'synced', blocks: 0, windowEnd: window.endAt };

  let op = operation;
  try {
    if (op === null) {
      // A routine refresh uploads only from a source a selection already
      // registered; registering is part of choosing (M5A-R52-001), and a phone
      // whose credential was dropped registers again at its next choice.
      const source = await registeredSource(uid);
      if (source === null) return { kind: 'synced', blocks: 0, windowEnd: window.endAt };
      if (!stillCurrent()) return GONE;
      const intent = await postBusyIntent({
        sourceId: source.sourceId, intentId: randomId(), operation: 'upload', selectionDigest: await digestOf(included),
      }, source.secret, { asUid: uid });
      op = { opId: intent.opId, epoch: intent.epoch, sourceId: source.sourceId, secret: source.secret };
    }
    const body = await busyUploadFor(op.sourceId, platform(), window, blocks);
    if (!stillCurrent()) return GONE;
    await postCalendarBusyM5(body, op, op.secret, { asUid: uid });
    if (!stillCurrent()) return GONE;
    await saveBusySyncedAt(uid, now, stillCurrent);
    return { kind: 'synced', blocks: body.blocks.length, windowEnd: body.windowEnd };
  } catch (error) {
    if (error instanceof M5aRefusedError && error.code === 'source_revoked') await markPhoneRemoved(uid);
    if (!stillCurrent()) return GONE;
    throw error;
  }
}

/* ── a selection ─────────────────────────────────────────────────── */

export class SelectionNotSavedError extends Error {
  constructor() {
    super('the calendar selection could not be saved');
  }
}

/**
 * The person turned calendars on or off: the pending record is written
 * first, and nothing is sent when that fails (M5A-R51-001, M5A-011). The rest
 * runs in the background; the switch shows the new state from here.
 */
export async function startSelection(
  uid: string,
  change: readonly string[] | ((current: readonly string[]) => readonly string[]),
  context: Omit<M5aPassContext, 'justEnrolled' | 'lastSyncedAt' | 'due'>,
): Promise<void> {
  // Numbered before the first await, in tap order: a later tap's record is
  // never overwritten by an earlier one (M5A-R54-001).
  selectionSequence += 1;
  const sequence = selectionSequence;
  const current = () => signedInAs(uid) && context.accountCurrent();
  const outcome = await underPendingLock(uid, async () => {
    if (sequence < (savedSequence.get(uid) ?? 0)) return { kind: 'superseded' as const };
    // A toggle is applied to the newest state there is — what is being
    // applied, else what is applied — read here, under the lock, so two quick
    // taps never both start from the same stale list (M5A-R3-005).
    let next: string[];
    try {
      const base = (await loadPendingSelection(uid))?.included ?? await loadIncludedCalendarIds(uid);
      next = [...new Set(typeof change === 'function' ? change(base) : change)];
    } catch {
      return { kind: 'failed' as const };
    }
    const record: PendingSelection = {
      intentId: randomId(),
      included: next,
      selectionDigest: await digestOf(next),
      operation: next.length === 0 ? 'clear' : 'upload',
      epoch: null,
      opId: null,
    };
    // The account this tap was made in, still (M5A-R53-002). And a calendar
    // chosen only while the consent says on, read right before the durable
    // write (Codex M6B-R5-002): a pending selection saved with it off would
    // resume the day it is turned back on. A clear runs whatever the consent.
    if (!current()) return { kind: 'superseded' as const };
    if (record.operation !== 'clear' && !context.consented()) return { kind: 'superseded' as const };
    try {
      // A new generation first (R1.1c, M5A-R4-001): if saving the record then
      // fails, nothing durable claims a selection the person was told failed,
      // and the old cache already never matches again.
      await bumpInclusionGeneration(uid);
      await savePendingSelection(uid, record);
    } catch {
      return { kind: 'failed' as const };
    }
    savedSequence.set(uid, sequence);
    // Any read or upload still running for an older selection writes nothing more.
    selectionGeneration += 1;
    return { kind: 'saved' as const, record };
  });
  // A newer tap already holds the record, or the account changed: nothing left to do.
  if (outcome.kind === 'superseded') return;
  if (outcome.kind === 'failed') {
    patch(uid, { saveFailed: true });
    throw new SelectionNotSavedError();
  }
  // The old selection's busy time leaves the phone before the new state is
  // shown (R1.1c): a deselected calendar's blocks are gone at once, and
  // nothing is shown until the new selection's read lands.
  await clearCachedBusyBlocksOf(uid);
  if (!current()) return;
  patch(uid, { pending: outcome.record, saveFailed: false });
  void continueSelection(uid, outcome.record, { ...context, justEnrolled: false, lastSyncedAt: null, due: true });
}

const continuations = new Map<string, Promise<void>>();

/**
 * Every read-check-write of the pending record, and applying a selection,
 * happens under one lock per account (M5A-011, M5A-R54-001): a newer tap's
 * record can never be overwritten by an older operation's acknowledgement,
 * and an older operation can never apply its list after a newer one exists.
 */
const pendingLocks = new Map<string, Promise<unknown>>();

/** Taps in order, and the newest one whose record was saved, per account. */
let selectionSequence = 0;
const savedSequence = new Map<string, number>();

function underPendingLock<T>(uid: string, task: () => Promise<T>): Promise<T> {
  const previous = pendingLocks.get(uid) ?? Promise.resolve();
  const run = previous.then(task, task);
  pendingLocks.set(uid, run.catch(() => undefined));
  return run;
}

/** One continuation per operation, whoever asks (the screen, a resumed pass). */
function continueSelection(uid: string, record: PendingSelection, context: M5aPassContext): Promise<void> {
  const running = continuations.get(record.intentId);
  if (running) return running;
  const task = runSelection(uid, record, context).catch(() => undefined).finally(() => {
    continuations.delete(record.intentId);
  });
  continuations.set(record.intentId, task);
  return task;
}

/** Whether `intentId` is still the pending operation; a newer selection supersedes it. */
async function stillPending(uid: string, intentId: string): Promise<boolean> {
  try {
    return (await loadPendingSelection(uid))?.intentId === intentId;
  } catch {
    return false;
  }
}

async function runSelection(uid: string, first: PendingSelection, context: M5aPassContext): Promise<void> {
  const current = withinLifetime(() => signedInAs(uid) && context.accountCurrent());
  // A record whose digest does not match its own list was not written by
  // this app as it stands: unreadable, so nothing is sent or read (M5A-011).
  if (first.selectionDigest !== await digestOf(first.included)) {
    patch(uid, { saveFailed: true });
    return;
  }
  let record = first;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!current()) return;
    const source = await ensureRegisteredSource(uid);
    if (source.kind !== 'ready' || !current()) return;

    // (2) The server starts the operation and mints its epoch.
    if (record.opId === null || record.epoch === null) {
      let intent;
      try {
        intent = await postBusyIntent({
          sourceId: source.sourceId, intentId: record.intentId, operation: record.operation, selectionDigest: record.selectionDigest,
        }, source.secret, { asUid: uid });
      } catch (error) {
        if (error instanceof M5aRefusedError && error.code === 'selection_stale') {
          const renewed = await renew(uid, record);
          if (!renewed) return;
          record = renewed;
          continue;
        }
        if (error instanceof M5aRefusedError && error.code === 'source_revoked') await markPhoneRemoved(uid);
        return;
      }
      if (!current() || intent.intentId !== record.intentId) return;
      const acknowledged: PendingSelection = { ...record, opId: intent.opId, epoch: intent.epoch };
      const kept = await underPendingLock(uid, async () => {
        if (!(await stillPending(uid, acknowledged.intentId))) return 'superseded' as const;
        try {
          await savePendingSelection(uid, acknowledged);
          return 'saved' as const;
        } catch {
          return 'failed' as const;
        }
      });
      if (kept === 'failed') patch(uid, { saveFailed: true });
      if (kept !== 'saved') return;
      record = acknowledged;
    }

    // (3) Applied, then read and sent as that operation.
    if (!current()) return;
    const toApply = record;
    const applied = await underPendingLock(uid, async () => {
      if (!(await stillPending(uid, toApply.intentId))) return null;
      try {
        await applyIncludedCalendarIds(uid, toApply.included);
      } catch {
        patch(uid, { saveFailed: true });
        return null;
      }
      selectionGeneration += 1;
      return selectionGeneration;
    });
    if (applied === null || !current()) return;
    await clearCachedBusyBlocksOf(uid);
    patch(uid, { included: record.included });
    const op = { opId: record.opId!, epoch: record.epoch!, sourceId: source.sourceId, secret: source.secret };
    try {
      if (record.operation === 'clear') {
        await clearCalendarBusyM5(source.sourceId, op, source.secret, { asUid: uid });
        patch(uid, { clearFailed: false });
      } else {
        if (!context.consented()) return;
        const outcome = await readAndUpload(uid, record.included, op, () => current() && selectionGeneration === applied);
        if (outcome.kind !== 'synced') return;
      }
    } catch (error) {
      if (error instanceof M5aRefusedError && error.code === 'selection_stale') {
        const renewed = await renew(uid, record);
        if (!renewed) return;
        record = renewed;
        continue;
      }
      if (record.operation === 'clear') patch(uid, { clearFailed: true });
      return;
    }

    // (4) Done: the record goes only now, and only if it is still this one.
    const finished = record;
    const removedRecord = await underPendingLock(uid, async () => {
      if (!(await stillPending(uid, finished.intentId))) return false;
      try {
        await removePendingSelection(uid);
        return true;
      } catch {
        return false;
      }
    });
    if (removedRecord) patch(uid, { pending: null });
    return;
  }
}

/** `selection_stale`: the old operation is discarded and a fresh `intentId` minted (M5A-R53-001). */
async function renew(uid: string, record: PendingSelection): Promise<PendingSelection | null> {
  const renewed: PendingSelection = { ...record, intentId: randomId(), opId: null, epoch: null };
  const outcome = await underPendingLock(uid, async () => {
    if (!(await stillPending(uid, record.intentId))) return 'superseded' as const;
    try {
      await savePendingSelection(uid, renewed);
      return 'saved' as const;
    } catch {
      return 'failed' as const;
    }
  });
  if (outcome === 'failed') patch(uid, { saveFailed: true });
  if (outcome !== 'saved') return null;
  patch(uid, { pending: renewed });
  return renewed;
}
