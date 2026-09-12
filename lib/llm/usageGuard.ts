/**
 * How many model calls a day costs (UC-2.0, #160).
 *
 * A hosted model is the first part of MaybeSitter that costs money per use,
 * and the budget is a ₪100/month alert that does not stop anything. Two things
 * can empty it: one account in a loop, and everybody at once. So there are two
 * caps, and a call is *reserved* before Vertex is asked rather than counted
 * after it answers — a crash between the call and the increment would
 * otherwise be free, which is the wrong direction to be wrong in.
 *
 * ── Why Firestore and not a counter in the process ───────────────
 *
 * Cloud Run runs several instances. A per-process counter caps each instance
 * separately, so the real limit is the cap times however many instances
 * happen to be up — a number nobody chose. The reservation is a transaction on
 * a shared document, so the instances are counting the same thing.
 *
 * ── The day boundary is UTC ──────────────────────────────────────
 *
 * Not the user's timezone. A per-user local day would let someone in UTC+3
 * reset three hours before someone in UTC, and the global cap has no timezone
 * to belong to at all. UTC is arbitrary but it is one arbitrary thing rather
 * than one per person.
 */
import { getStorage, LLM_USAGE, requireDocId, USAGE, userCol, type StorageAdapter } from '../storage';
import type { LlmPurpose } from '../../src/extraction/llm/llmProvider';

/** Per-user daily calls. #160's default. */
export const DEFAULT_USER_DAILY_CAP = 150;
/** Everybody, together, in one UTC day. */
export const DEFAULT_GLOBAL_DAILY_CAP = 20_000;



/**
 * `unavailable` is a refusal, not an error.
 *
 * If the counters cannot be read or written — contention, an outage — the
 * guard does not know what has been spent today. Permitting the call would
 * make the cap advisory exactly when it matters, so the call is refused and
 * capture falls back to rules. Spending nothing is recoverable; spending
 * without a limit is not.
 */
export type ReservationOutcome = 'ok' | 'user_cap' | 'global_cap' | 'unavailable';

export interface UsageDay {
  /** Calls reserved today, whether or not the provider answered. */
  calls: number;
  /** For reading a day's shape without joining the path back together. */
  date: string;
  updatedAt: string;
}

export interface ReserveOptions {
  now?: Date;
  storage?: StorageAdapter;
  userCap?: number;
  globalCap?: number;
}

/** The UTC day a moment belongs to, as `YYYY-MM-DD`. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function capFrom(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function userDayPath(uid: string, day: string): string {
  return `${userCol(uid, USAGE)}/${requireDocId(day)}`;
}

/**
 * The global counter lives outside every user tree.
 *
 * It is not one person's data — it is the service's spend — and putting it
 * under a uid would mean deleting that account deleted the day's global count.
 */
function globalDayPath(day: string): string {
  return `${LLM_USAGE}/${requireDocId(day)}`;
}

/**
 * Claims one model call, or says which cap refused it.
 *
 * Both counters move in one transaction: counting the user and then failing to
 * count the global would make the global cap quietly wrong for the rest of the
 * day, in the direction of spending more.
 */
export async function reserveCall(
  uid: string,
  purpose: LlmPurpose,
  options: ReserveOptions = {},
): Promise<ReservationOutcome> {
  void purpose; // Recorded on the log line; the caps are not per purpose yet.
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const day = utcDay(now);
  const userCap = options.userCap ?? capFrom(process.env.MAYBESITTER_LLM_DAILY_CALL_CAP, DEFAULT_USER_DAILY_CAP);
  const globalCap = options.globalCap
    ?? capFrom(process.env.MAYBESITTER_LLM_GLOBAL_DAILY_CALL_CAP, DEFAULT_GLOBAL_DAILY_CAP);

  const userPath = userDayPath(uid, day);
  const globalPath = globalDayPath(day);
  const at = now.toISOString();

  try {
    return await storage.runTransaction(async (tx) => {
      const [userDay, globalDay] = await Promise.all([
        tx.get<UsageDay>(userPath),
        tx.get<UsageDay>(globalPath),
      ]);
      const userCalls = userDay?.calls ?? 0;
      const globalCalls = globalDay?.calls ?? 0;

      // The user's cap is checked first so that one account in a loop is told
      // it is the one over budget, rather than blaming the service.
      if (userCalls >= userCap) return 'user_cap';
      if (globalCalls >= globalCap) return 'global_cap';

      tx.set<UsageDay>(userPath, { calls: userCalls + 1, date: day, updatedAt: at });
      tx.set<UsageDay>(globalPath, { calls: globalCalls + 1, date: day, updatedAt: at });
      return 'ok';
    });
  } catch (error) {
    // Named, and without the provider's message: a storage error can quote the
    // document it failed on, and these documents are keyed by uid.
    console.error(`[llm/usage] reservation unavailable: ${(error as Error).name}`);
    return 'unavailable';
  }
}

/** What has been reserved today, for tests and for an operator answering "why". */
export async function callsToday(
  uid: string,
  options: { now?: Date; storage?: StorageAdapter } = {},
): Promise<{ user: number; global: number }> {
  const storage = options.storage ?? getStorage();
  const day = utcDay(options.now ?? new Date());
  const [userDay, globalDay] = await Promise.all([
    storage.get<UsageDay>(userDayPath(uid, day)),
    storage.get<UsageDay>(globalDayPath(day)),
  ]);
  return { user: userDay?.calls ?? 0, global: globalDay?.calls ?? 0 };
}
