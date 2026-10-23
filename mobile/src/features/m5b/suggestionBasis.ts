import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  beginBasisRead,
  useFreshMemoryItems,
  memoryRevisionOf,
  useMemoryRevision,
  useSuggestionBasisHidden,
  useUid,
} from '../../api/queries';
import type { BasisMode } from '../../api/schemas/intelligence';
import type { MemoryItem } from '../../api/schemas/profile';
import { m5bCapabilitySnapshot, useM5bCapabilityState } from './capabilities';

/**
 * M5b-2b-1: what every holder of intelligence suggestions (the panel on
 * «يتابع لك», Today's banner) needs to show only what it may.
 *
 * A response is classified when it is read (R13-001, R14-002). The server
 * names the mode it filtered under (`basisMode`); its absence means off only
 * when the capability probe says false — at the read's start or its answer.
 * With the capability true or never known, absence is unknown and the
 * suggestions stay hidden until a classified response arrives.
 */
export interface BasisClass {
  /** The envelope's `basisMode`; null when the server sent none. */
  readonly mode: BasisMode | null;
  /** The capability this read ran under, as best known (start, else answer). */
  readonly capAtFetch: boolean | null;
  /** Whether the capability was known false when the read started or answered. */
  readonly offAtFetch: boolean;
  /** `beginBasisRead`'s number for this read. */
  readonly startedAt: number;
}

export interface BasisReadStamp {
  readonly startedAt: number;
  readonly now: boolean | null;
  readonly lastKnown: boolean | undefined;
}

/** Taken when a suggestion read starts. */
export function stampBasisRead(client: QueryClient, uid: string): BasisReadStamp {
  return { startedAt: beginBasisRead(), ...m5bCapabilitySnapshot(client, uid) };
}

/** Classifies a response when it answers. */
export function classifyBasis(
  envelope: { basisMode?: BasisMode | undefined },
  stamp: BasisReadStamp,
  client: QueryClient,
  uid: string,
): BasisClass {
  const answered = m5bCapabilitySnapshot(client, uid);
  return {
    mode: envelope.basisMode ?? null,
    capAtFetch: stamp.now ?? answered.now,
    offAtFetch: stamp.lastKnown === false || answered.lastKnown === false,
    startedAt: stamp.startedAt,
  };
}

/**
 * Whether the suggestions of a classified response may be drawn now, with
 * their schedule rows (one rule for both, R13-001):
 * - `on_nobasis`: yes — memory never reached them;
 * - `on_basis`: only while the capability is known true; unknown hides every
 *   one of them, cited or not;
 * - absent: only if read under a known-false capability, or it is known false now.
 */
export function basisClassVisible(cls: BasisClass | null, capNow: boolean | null): boolean {
  if (!cls) return false;
  if (cls.mode === 'on_nobasis') return true;
  if (cls.mode === 'on_basis') return capNow === true;
  return capNow === false || cls.offAtFetch;
}

/**
 * The signals that make a holder read its inbox again (R6-002, R7-003,
 * R8-001, R9-001, R10-002, R12-001):
 * - the account's memory revision, bumped after every memory write that
 *   succeeded or may have (not while M5b is known off: off is unchanged);
 * - every settlement of the fresh memory list after the first — a changed or
 *   unchanged id set, an unavailability, an error — unless a read of the
 *   holder's own began after that list fetch did;
 * - a capability transition. The first answer after mount reads again only
 *   if it leaves what is held hidden, so a cold mount costs one read.
 *
 * `reread` never empties what is held before it answers; on failure the
 * holder clears its suggestions itself.
 */
export function useSuggestionBasisSignals(options: {
  /** What the holder shows now, classified; null before its first answer. */
  held: BasisClass | null;
  /** Whether the holder has an answer on screen and may read again. */
  ready: boolean;
  /** Whether that answer holds a pending suggestion (something a classification can hide). */
  holding: boolean;
  /** Whether to watch the memory list: M5b known on and something memory-filtered held. */
  watchList: boolean;
  /** The newest read of the holder's own, by `beginBasisRead`'s number. */
  lastReadStart: () => number;
  reread: () => void;
}): {
  capNow: boolean | null;
  freshItems: ReadonlyMap<string, MemoryItem> | null;
  /** Whether the watched memory list has answered (or failed) since mount. */
  listSettled: boolean;
  basisHidden: (memoryId: string, readStartedAt: number) => boolean;
  /**
   * Marks the account's memory revision as seen, without a read: for the
   * holder whose own action just bumped it and reads its inbox itself right
   * after (APP-READ-006), so the action costs one read, not two. Every
   * other holder still rereads on that bump.
   */
  absorbRevision: () => void;
} {
  const { held, ready, holding, watchList } = options;
  const uid = useUid();
  const cap = useM5bCapabilityState();
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });

  // The memory revision; one not yet acted on waits for the holder to be ready.
  // Seen per account: the account arriving after the first render is not a
  // memory write.
  const revision = useMemoryRevision(uid);
  const seenRevision = useRef({ uid, revision });
  const uidRef = useRef(uid);
  useEffect(() => { uidRef.current = uid; });

  // The memory list: a settlement the holder's own newest read predates —
  // unless a memory write already bumped the revision, whose read (about to
  // start) is fresher than the list fetch that write set off.
  const onSettled = useCallback((fetchStartedAt: number) => {
    const current = latest.current;
    if (!current.ready) return;
    if (current.lastReadStart() > fetchStartedAt) return;
    const seen = seenRevision.current;
    if (seen.uid === uidRef.current && memoryRevisionOf(seen.uid) !== seen.revision) return;
    current.reread();
  }, []);
  const list = useFreshMemoryItems(watchList && cap.now === true, onSettled);
  useEffect(() => {
    // A memory write since the last look: read again once there is an
    // answer on screen to check (not while M5b is known off).
    const seen = seenRevision.current;
    if (seen.uid !== uid) {
      seenRevision.current = { uid, revision };
      return;
    }
    if (!ready || seen.revision === revision) return;
    seenRevision.current = { uid, revision };
    if (cap.now !== false) latest.current.reread();
  }, [uid, revision, ready, cap.now]);

  // A capability transition (R12-001). The first answer after mount is not
  // one: it reads again only if it leaves a held suggestion hidden, so a
  // cold mount costs one read. A transition while nothing is on screen yet waits
  // for the first answer. A read that ran under another known answer than
  // the one now (it started before a switch) is read again too, once.
  const capSeen = useRef<{ value: boolean | null; everKnown: boolean; pending: boolean }>({ value: null, everKnown: false, pending: false });
  const handled = useRef('');
  useEffect(() => {
    const seen = capSeen.current;
    if (seen.value !== cap.now) {
      const first = !seen.everKnown;
      seen.value = cap.now;
      seen.everKnown = seen.everKnown || cap.now !== null;
      if (!first) seen.pending = true;
      else if (ready && held && holding && !basisClassVisible(held, cap.now)) seen.pending = true;
    }
    if (!ready || !held) return;
    const key = `${held.startedAt}:${String(cap.now)}`;
    if (seen.pending) {
      seen.pending = false;
      handled.current = key;
      latest.current.reread();
      return;
    }
    if (held.capAtFetch === null || held.capAtFetch === cap.now || handled.current === key) return;
    handled.current = key;
    latest.current.reread();
  }, [ready, held, holding, cap.now]);

  const basisHidden = useSuggestionBasisHidden();
  const absorbRevision = useCallback(() => {
    const current = uidRef.current;
    seenRevision.current = { uid: current, revision: memoryRevisionOf(current) };
  }, []);
  return { capNow: cap.now, freshItems: list.items, listSettled: list.settled, basisHidden, absorbRevision };
}

/**
 * The client and account a holder stamps its reads with. Both functions keep
 * their identity for the life of the holder and read the account when they
 * run, so the account arriving after the first render does not read again.
 */
export function useBasisStamp(): { stamp: () => BasisReadStamp; classify: (envelope: { basisMode?: BasisMode | undefined }, stamp: BasisReadStamp) => BasisClass } {
  const client = useQueryClient();
  const uid = useUid();
  const account = useRef({ client, uid });
  useEffect(() => { account.current = { client, uid }; });
  const stamp = useCallback(() => stampBasisRead(account.current.client, account.current.uid), []);
  const classify = useCallback(
    (envelope: { basisMode?: BasisMode | undefined }, at: BasisReadStamp) => classifyBasis(envelope, at, account.current.client, account.current.uid),
    [],
  );
  return { stamp, classify };
}
