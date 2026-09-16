/**
 * Getting busy time off the phone and onto the account (UC-3.2, #186 steps 3–4).
 *
 * ── Why the decision is a separate pure function ─────────────────
 *
 * `busySyncDecision` takes six values and returns "run" or a word. Every rule
 * this feature has about *when* it may read somebody's calendar lives there:
 * the build flag, being signed in, the consent switch, and the throttle. None
 * of them can be observed on a device without seeding a calendar and waiting
 * fifteen minutes, and all of them are the difference between a product that
 * reads a calendar when it was asked to and one that reads it because an
 * `AppState` listener fired. Separating the decision is what makes each one a
 * case rather than a comment.
 *
 * ── Which triggers the throttle applies to ───────────────────────
 *
 * Not the user's. "Connect" and the pull-to-refresh are somebody asking for an
 * answer now, and a fifteen-minute cooldown on those is the product telling
 * them to wait for a reason it cannot explain. The throttle is for the two
 * triggers that fire on their own — coming back to the front, and finishing a
 * UC-3.1 calendar write — because those are the ones that can fire ten times a
 * minute while somebody switches between two apps.
 *
 * ── The block id is computed here, and matches the server's ──────
 *
 * `sha256(JSON.stringify([sourceId, nativeId, startAt]))`, the same preimage as
 * `lib/calendar/busyBlocks.ts`. The native id never leaves the phone in the
 * clear: it goes into the hash and nowhere else, so the account's stored rows
 * do not let one device recognise another device's calendar entries.
 */
import * as Crypto from 'expo-crypto';
import type { DeviceBusyBlock } from './busyBlocks';
import type { CalendarBusyUpload } from '../../api/endpoints/calendar';

/** How often an automatic trigger may sync. */
export const BUSY_SYNC_MIN_INTERVAL_MS = 15 * 60_000;

/** The most blocks one upload carries. The server refuses more. */
export const BUSY_SYNC_UPLOAD_LIMIT = 1000;

export type BusySyncTrigger =
  /** The user just turned the calendar on, or picked a calendar. */
  | 'connect'
  /** The user pulled to refresh. */
  | 'refresh'
  /** The app came back to the front. */
  | 'foreground'
  /** UC-3.1 (#185) wrote or removed an event, so our own id set has changed. */
  | 'calendar_write';

export type BusySyncSkip =
  | 'feature_off'
  | 'signed_out'
  | 'no_consent'
  | 'too_soon';

export interface BusySyncDecisionInput {
  readonly trigger: BusySyncTrigger;
  /** `calendarReadEnabled()`. */
  readonly featureEnabled: boolean;
  readonly signedIn: boolean;
  /** The Trust Center's calendar switch (UC-1.R4, #157). */
  readonly consented: boolean;
  /** Epoch millis of the last successful upload, or null. */
  readonly lastSyncedAt: number | null;
  readonly now: Date;
}

export type BusySyncDecision = { run: true } | { run: false; because: BusySyncSkip };

export function busySyncDecision(input: BusySyncDecisionInput): BusySyncDecision {
  if (!input.featureEnabled) return { run: false, because: 'feature_off' };
  if (!input.signedIn) return { run: false, because: 'signed_out' };
  // The switch, checked before the calendar is touched rather than before the
  // upload. Reading somebody's calendar to then decide not to send it is still
  // reading somebody's calendar.
  if (!input.consented) return { run: false, because: 'no_consent' };
  if (input.trigger === 'connect' || input.trigger === 'refresh') return { run: true };
  if (input.lastSyncedAt === null) return { run: true };
  const since = input.now.getTime() - input.lastSyncedAt;
  // A clock that went backwards — a manual time change, an NTP correction —
  // gives a negative age. Treating that as "not due" would stop syncing until
  // the clock caught up; treating it as due costs one extra sync.
  if (since >= 0 && since < BUSY_SYNC_MIN_INTERVAL_MS) return { run: false, because: 'too_soon' };
  return { run: true };
}

/** The id the server files this block under. See the header. */
export async function deviceBlockId(
  sourceId: string,
  nativeId: string,
  startAt: string,
): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    JSON.stringify([sourceId, nativeId, startAt]),
  );
}

/** `device:{writerId}` — the id this installation's calendar is filed under. */
export function deviceSourceId(writerId: string): string {
  return `device:${writerId}`;
}

export interface BusyUploadWindow {
  readonly startAt: string;
  readonly endAt: string;
}

/**
 * The request body, built from blocks and nothing else.
 *
 * The one function that turns busy blocks into something addressed to a server.
 * It takes `DeviceBusyBlock[]` — a type with four fields — so there is no
 * version of this call that could be handed an event, and it writes each block
 * out field by field so that "only these four" is visible in one literal.
 */
export async function busyUploadFor(
  sourceId: string,
  platform: 'ios' | 'android',
  window: BusyUploadWindow,
  blocks: readonly DeviceBusyBlock[],
): Promise<CalendarBusyUpload> {
  const capped = blocks.slice(0, BUSY_SYNC_UPLOAD_LIMIT);
  const rows = await Promise.all(capped.map(async (block) => ({
    blockId: await deviceBlockId(sourceId, block.nativeId, block.startAt),
    startAt: block.startAt,
    endAt: block.endAt,
    allDay: block.allDay,
  })));
  return {
    sourceId,
    platform,
    windowStart: window.startAt,
    windowEnd: window.endAt,
    blocks: rows,
  };
}

/** Everything the sync does to the world, so a test can hand it other ones. */
export interface BusySyncPorts {
  /** `deviceCalendar.fetchBusyBlocks`. */
  readBusy(ownEventIds: ReadonlySet<string>, now: Date): Promise<DeviceBusyBlock[]>;
  /** `loadWrittenEventIds`, so this app's own entries are not busy. */
  ownEventIds(): Promise<string[]>;
  /** `saveCachedBusyBlocks`. */
  cache(blocks: readonly DeviceBusyBlock[]): Promise<void>;
  /** `postCalendarBusy`. */
  upload(body: CalendarBusyUpload): Promise<void>;
  /** `saveBusySyncedAt`. */
  recordSync(at: Date): Promise<void>;
}

export type BusySyncOutcome =
  | { kind: 'skipped'; because: BusySyncSkip }
  | { kind: 'denied' }
  | { kind: 'failed' }
  | { kind: 'synced'; blocks: number };

export interface BusySyncInput extends BusySyncDecisionInput {
  readonly sourceId: string;
  readonly platform: 'ios' | 'android';
  readonly window: BusyUploadWindow;
}

/**
 * One pass.
 *
 * The cache is written *before* the upload and kept even when the upload fails.
 * The two answer different questions: the cache is what the conflict chip
 * renders from on a train with no signal, and the server copy is what the
 * planner uses. A failed request should not cost somebody their offline chips.
 *
 * A permission refusal is reported as `denied` rather than thrown, because the
 * caller — a hook running on `AppState` — has nowhere to put an exception, and
 * because the user revoking calendar access in Settings is a thing that happens
 * rather than a fault.
 */
export async function runBusySync(
  ports: BusySyncPorts,
  input: BusySyncInput,
): Promise<BusySyncOutcome> {
  const decision = busySyncDecision(input);
  if (!decision.run) return { kind: 'skipped', because: decision.because };

  let blocks: DeviceBusyBlock[];
  try {
    blocks = await ports.readBusy(new Set(await ports.ownEventIds()), input.now);
  } catch {
    // The calendar could not be read: no permission, or the module is not
    // there. The cache is deliberately left alone — the last answer is still
    // the best one we have, and replacing it with nothing would make the chips
    // disappear the moment somebody opened Settings and came back.
    return { kind: 'denied' };
  }

  await ports.cache(blocks);

  try {
    await ports.upload(await busyUploadFor(input.sourceId, input.platform, input.window, blocks));
  } catch {
    // Not recorded as a sync, so the next trigger tries again rather than
    // waiting out the throttle on a window the server never received.
    return { kind: 'failed' };
  }

  await ports.recordSync(input.now);
  return { kind: 'synced', blocks: Math.min(blocks.length, BUSY_SYNC_UPLOAD_LIMIT) };
}
