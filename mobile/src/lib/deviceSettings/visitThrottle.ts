import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * How often the phone may ask for suggestions because a screen opened
 * (review of 2026-10-03). Today and «يتابع لك» remount on every tab switch;
 * each mount used to be a `POST /intelligence/generate`, and a model run
 * shares the per-user and global caps with the capture chat.
 *
 * The server holds a visit to its own policy and answers `nextVisitAt`; the
 * phone waits until then. A server that predates the policy answers without
 * it, and treats the visit as an ordinary request — so then the phone waits
 * `DEFAULT_WAIT_MS` on its own, which alone keeps it to four a day.
 *
 * Kept per uid, in memory and (best effort) on the device: only an instant,
 * never anything the person wrote. Storage failing means the in-memory value
 * is all there is, never a crash.
 */
export const DEFAULT_WAIT_MS = 6 * 60 * 60 * 1000;
/** Never sooner than this, whatever a server says. */
export const FLOOR_MS = 15 * 60 * 1000;
/** After a failed ask (offline, a 5xx), try again later rather than at once. */
export const FAILURE_WAIT_MS = 30 * 60 * 1000;

const nextAllowed = new Map<string, number>();
const key = (uid: string) => `maybesitter.intelligence.nextVisit.${uid}`;

async function readNext(uid: string): Promise<number> {
  const known = nextAllowed.get(uid);
  if (known !== undefined) return known;
  try {
    const stored = Number(await AsyncStorage.getItem(key(uid)));
    if (Number.isFinite(stored) && stored > 0) { nextAllowed.set(uid, stored); return stored; }
  } catch { /* No storage: memory only. */ }
  return 0;
}

function writeNext(uid: string, at: number): void {
  nextAllowed.set(uid, at);
  void AsyncStorage.setItem(key(uid), String(at)).catch(() => undefined);
}

/**
 * Whether this visit may ask the server to generate. Claiming holds the slot
 * at once, so two screens mounting together ask once.
 */
export async function claimVisit(uid: string, now: number = Date.now()): Promise<boolean> {
  if (!uid || uid === 'signed-out') return false;
  if (now < await readNext(uid)) return false;
  writeNext(uid, now + DEFAULT_WAIT_MS);
  return true;
}

/** What the server answered: its `nextVisitAt` when it sent one, else the default. */
export function recordVisitAnswer(uid: string, nextVisitAt: string | undefined, now: number = Date.now()): void {
  const said = nextVisitAt ? Date.parse(nextVisitAt) : Number.NaN;
  writeNext(uid, Number.isFinite(said) ? Math.max(said, now + FLOOR_MS) : now + DEFAULT_WAIT_MS);
}

/** A failed ask. A loop that is off stays at the default; anything else retries later. */
export function recordVisitFailure(uid: string, off: boolean, now: number = Date.now()): void {
  writeNext(uid, now + (off ? DEFAULT_WAIT_MS : FAILURE_WAIT_MS));
}

export function resetVisitThrottleForTests(): void {
  nextAllowed.clear();
}
