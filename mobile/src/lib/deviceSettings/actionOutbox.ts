/**
 * Taps on notification buttons, waiting to reach the server (UC-3.14, #200).
 *
 * ── Why a queue at all ───────────────────────────────────────────
 *
 * A button on a reminder is pressed with the app killed, on a train, in
 * airplane mode. TanStack mutations never retry on their own (#157), so a
 * direct POST from the response handler is a tap lost to the first tunnel.
 * This is the one sanctioned queue in the client: every item is a person's
 * explicit tap, and it holds ids and instants only — never a title.
 *
 * ── Exactly once ─────────────────────────────────────────────────
 *
 * Two layers, and each covers what the other cannot:
 *
 *  1. **On the device**, `dedupeKey` (`${notificationId}|${action}`) is
 *     remembered for a day after enqueueing. The same response delivered
 *     twice — the live listener *and* the cold-start
 *     `getLastNotificationResponseAsync`, or a relaunch replaying it — enqueues
 *     once.
 *  2. **On the server**, `clientActionId` (a random UUID minted at enqueue) is
 *     recorded in the transaction that applies the action. An item is removed
 *     from here only after a 2xx, so a request that landed but whose answer was
 *     lost is sent again with the same id and the server replays it.
 *
 * ── Keyed by account ─────────────────────────────────────────────
 *
 * A queued "done" sent with somebody else's token completes nothing of theirs
 * (the id is not in their tree) but it is still the #148 mistake. Stored per
 * uid and cleared on sign-out.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type OutboxAction = 'complete' | 'postpone' | 'aware';

export interface OutboxItem {
  readonly clientActionId: string;
  readonly commitmentId: string;
  readonly action: OutboxAction;
  /** ISO-8601, `postpone` only: computed at the tap, not at delivery. */
  readonly postponedUntil?: string;
  readonly occurredAt: string;
  readonly dedupeKey: string;
  readonly attempts: number;
  /** Epoch ms before which this item is not sent again. */
  readonly nextAttemptAt: number;
}

export interface OutboxState {
  readonly version: 1;
  readonly items: readonly OutboxItem[];
  /** dedupeKey → epoch ms it was first enqueued. */
  readonly seen: Readonly<Record<string, number>>;
}

export const OUTBOX_DEDUPE_MS = 24 * 60 * 60 * 1000;
/**
 * A tap older than this is dropped unsent. A Done from last week must not
 * complete a commitment somebody has since reopened; after a day the person
 * has had every chance to act in the app instead.
 */
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Where a tap waits when the app was woken with no signed-in user yet — the
 * Firebase session restores asynchronously in a headless task. Not a uid (uids
 * never contain `:`), and adopted by the next account that mounts.
 */
export const UNBOUND_ACCOUNT = ':unbound';
export const OUTBOX_MAX_ATTEMPTS = 8;
export const OUTBOX_BASE_BACKOFF_MS = 15_000;
export const OUTBOX_MAX_BACKOFF_MS = 30 * 60 * 1000;

export const EMPTY_OUTBOX: OutboxState = Object.freeze({ version: 1, items: Object.freeze([]), seen: Object.freeze({}) });

export function outboxStorageKey(accountId: string): string {
  return `actionOutbox.v1.${accountId}`;
}

const ACTIONS: readonly OutboxAction[] = ['complete', 'postpone', 'aware'];

function readItem(value: unknown): OutboxItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.clientActionId !== 'string' || row.clientActionId === '') return null;
  if (typeof row.commitmentId !== 'string' || row.commitmentId === '') return null;
  if (!ACTIONS.includes(row.action as OutboxAction)) return null;
  if (typeof row.occurredAt !== 'string' || typeof row.dedupeKey !== 'string') return null;
  if (row.action === 'postpone' && (typeof row.postponedUntil !== 'string' || Number.isNaN(Date.parse(row.postponedUntil)))) {
    return null;
  }
  const attempts = typeof row.attempts === 'number' && Number.isFinite(row.attempts) ? row.attempts : 0;
  const nextAttemptAt = typeof row.nextAttemptAt === 'number' && Number.isFinite(row.nextAttemptAt) ? row.nextAttemptAt : 0;
  // Rebuilt field by field, so nothing a bug put there travels to the server.
  return {
    clientActionId: row.clientActionId,
    commitmentId: row.commitmentId,
    action: row.action as OutboxAction,
    ...(row.action === 'postpone' ? { postponedUntil: row.postponedUntil as string } : {}),
    occurredAt: row.occurredAt,
    dedupeKey: row.dedupeKey,
    attempts,
    nextAttemptAt,
  };
}

export function parseOutbox(raw: string | null): OutboxState {
  if (!raw) return EMPTY_OUTBOX;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_OUTBOX;
  }
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) return EMPTY_OUTBOX;
  const blob = value as Record<string, unknown>;
  const items = Array.isArray(blob.items) ? blob.items.map(readItem).filter((item): item is OutboxItem => !!item) : [];
  const seen: Record<string, number> = {};
  if (blob.seen && typeof blob.seen === 'object' && !Array.isArray(blob.seen)) {
    for (const [key, at] of Object.entries(blob.seen as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) seen[key] = at;
    }
  }
  return { version: 1, items, seen };
}

/**
 * Adds a tap, unless this notification's same button was already queued. Pure.
 *
 * Returns the state unchanged (same object) for a duplicate, which is how the
 * caller knows not to cancel, dismiss or flush a second time.
 */
export function withEnqueued(
  state: OutboxState,
  tap: {
    clientActionId: string; commitmentId: string; action: OutboxAction; notificationId: string;
    postponedUntil?: string;
    /** The OS's delivery instant for this notification, so a re-ring under the same identifier is a new press. */
    deliveredAt?: number;
  },
  now: number,
): OutboxState {
  // The request identifier is the same every time a commitment re-rings; the
  // delivery instant is what tells one ring from the next, and it is the same
  // for one press however many ways it reaches us.
  const dedupeKey = typeof tap.deliveredAt === 'number' && Number.isFinite(tap.deliveredAt)
    ? `${tap.notificationId}|${tap.deliveredAt}|${tap.action}`
    : `${tap.notificationId}|${tap.action}`;
  const seen: Record<string, number> = {};
  for (const [key, at] of Object.entries(state.seen)) if (now - at < OUTBOX_DEDUPE_MS) seen[key] = at;
  if (seen[dedupeKey] !== undefined) return state;
  seen[dedupeKey] = now;
  const item: OutboxItem = {
    clientActionId: tap.clientActionId,
    commitmentId: tap.commitmentId,
    action: tap.action,
    ...(tap.action === 'postpone' && tap.postponedUntil ? { postponedUntil: tap.postponedUntil } : {}),
    occurredAt: new Date(now).toISOString(),
    dedupeKey,
    attempts: 0,
    nextAttemptAt: 0,
  };
  return { version: 1, items: [...state.items, item], seen };
}

/** What one delivery attempt came to. */
export type SendOutcome = 'sent' | 'drop' | 'retry';

export function backoffMs(attempts: number): number {
  return Math.min(OUTBOX_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_MAX_BACKOFF_MS);
}

/** Applies one attempt's outcome to the item it was for. Pure. */
export function withOutcome(state: OutboxState, clientActionId: string, outcome: SendOutcome, now: number): OutboxState {
  const items: OutboxItem[] = [];
  for (const item of state.items) {
    if (item.clientActionId !== clientActionId) {
      items.push(item);
      continue;
    }
    if (outcome !== 'retry') continue;
    const attempts = item.attempts + 1;
    if (attempts >= OUTBOX_MAX_ATTEMPTS) continue;
    items.push({ ...item, attempts, nextAttemptAt: now + backoffMs(attempts) });
  }
  return { ...state, items };
}

/** Commitments with a tap still on its way: the engine must not re-ring them. */
export function pendingCommitmentIds(state: OutboxState): Set<string> {
  return new Set(state.items.filter((item) => item.action !== 'aware').map((item) => item.commitmentId));
}

export async function loadOutbox(accountId: string): Promise<OutboxState> {
  try {
    return parseOutbox(await AsyncStorage.getItem(outboxStorageKey(accountId)));
  } catch {
    return EMPTY_OUTBOX;
  }
}

async function saveOutbox(accountId: string, state: OutboxState): Promise<void> {
  await AsyncStorage.setItem(outboxStorageKey(accountId), JSON.stringify(state));
}

/*
 * One writer at a time per process. The listener, the cold-start response, an
 * AppState change and a reconnect can all arrive in the same second; without
 * this, two load-modify-save cycles interleave and one of them loses a tap.
 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

/** Persists a tap. True when it was new, false for a duplicate or a failed write. */
export function enqueueTap(
  accountId: string,
  tap: { commitmentId: string; action: OutboxAction; notificationId: string; postponedUntil?: string; deliveredAt?: number },
  newId: () => string,
  now: Date,
): Promise<boolean> {
  return serial(async () => {
    const before = await loadOutbox(accountId);
    const after = withEnqueued(before, { ...tap, clientActionId: newId() }, now.getTime());
    if (after === before) return false;
    try {
      await saveOutbox(accountId, after);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Sends every item that is due, oldest first, one at a time.
 *
 * An item leaves the store only after `send` says `sent` or `drop`. A crash
 * between the server applying it and this line running leaves the item in
 * place, and the next flush sends the same `clientActionId` — which the server
 * answers as a replay. That is the whole exactly-once argument, so the save
 * happens after every item rather than once at the end.
 */
export function flushOutbox(
  accountId: string,
  send: (item: OutboxItem) => Promise<SendOutcome>,
  now: () => number,
  /**
   * Whether the credential `send` will use is still this account's. Checked
   * before every item: a sign-out or switch mid-flush stops it, and the items
   * stay for their own account rather than being sent under another's token.
   */
  stillThisAccount: () => boolean = () => true,
): Promise<{ sent: number; dropped: number; retrying: number }> {
  return serial(async () => {
    let state = await loadOutbox(accountId);
    const tally = { sent: 0, dropped: 0, retrying: 0 };
    for (const item of state.items) {
      if (item.nextAttemptAt > now()) continue;
      if (!stillThisAccount()) break;
      let outcome: SendOutcome;
      const age = now() - Date.parse(item.occurredAt);
      if (!(age <= OUTBOX_MAX_AGE_MS)) {
        outcome = 'drop';
      } else {
        try {
          outcome = await send(item);
        } catch {
          outcome = 'retry';
        }
      }
      if (outcome === 'sent') tally.sent += 1;
      else if (outcome === 'drop') tally.dropped += 1;
      else tally.retrying += 1;
      state = withOutcome(state, item.clientActionId, outcome, now());
      try {
        await saveOutbox(accountId, state);
      } catch {
        break;
      }
      // Offline: the rest will fail the same way. Wait for the next trigger.
      if (outcome === 'retry') break;
    }
    return tally;
  });
}

export async function clearOutbox(accountId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(outboxStorageKey(accountId));
  } catch {
    // Signing out; an unremovable queue is not a reason to stay signed in.
  }
}

/**
 * Moves taps queued with no signed-in user into this account's outbox.
 *
 * The press happened on this phone while it was signed in — Firebase just had
 * not restored the session in the headless task. The risk is a different
 * account signing in first: its outbox then holds ids that are not in its tree,
 * which the server answers 404 and the outbox drops. Stale ones (a day) are
 * dropped by the flush.
 */
export function adoptUnboundTaps(accountId: string): Promise<number> {
  return serial(async () => {
    const unbound = await loadOutbox(UNBOUND_ACCOUNT);
    if (unbound.items.length === 0) return 0;
    const mine = await loadOutbox(accountId);
    const known = new Set(mine.items.map((item) => item.clientActionId));
    const items = [...mine.items, ...unbound.items.filter((item) => !known.has(item.clientActionId))];
    try {
      await saveOutbox(accountId, { version: 1, items, seen: { ...unbound.seen, ...mine.seen } });
      await AsyncStorage.removeItem(outboxStorageKey(UNBOUND_ACCOUNT));
    } catch {
      return 0;
    }
    return unbound.items.length;
  });
}
