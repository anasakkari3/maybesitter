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
import { createHash, randomUUID } from 'node:crypto';
import { getStorage, LLM_USAGE, requireDocId, USAGE, userCol, type StorageAdapter } from '../storage';
import type { LlmPurpose } from '../../src/extraction/llm/llmProvider';

/**
 * Per-user daily calls.
 *
 * 60, lowered from #160's 150 by the launch decision in UC-4.5 (#181). A capture
 * is one call for up to three clauses and at most three for any capture (the
 * clauses of one capture are read together since CL1), plus one for a typed
 * clarification — so sixty is a heavy day of real use and a short loop.
 */
export const DEFAULT_USER_DAILY_CAP = 60;
/** Everybody, together, in one UTC day. #181's launch figure, down from 20 000. */
export const DEFAULT_GLOBAL_DAILY_CAP = 3_000;
/**
 * Per-user tokens in one UTC day (UC-4.5, #181).
 *
 * Calls and tokens are different failure modes: sixty calls of twenty thousand
 * characters each costs far more than sixty captures, and a call cap alone
 * cannot see the difference.
 */
export const DEFAULT_USER_DAILY_TOKEN_CAP = 150_000;
/**
 * Per-user calls in one minute (UC-4.5, #181).
 *
 * A daily cap stops a slow leak; it does nothing about a client in a tight retry
 * loop, which can spend the whole day's budget in under a minute.
 */
export const DEFAULT_USER_MINUTE_CAP = 8;
/** M5a's independent per-user daily call budget (owner decision 2026-10-24). */
export const M5A_USER_DAILY_CALL_CAP = 300;
/** M5a's independent per-user daily token budget (300 ordinary scan calls, rounded). */
export const M5A_USER_DAILY_TOKEN_CAP = 1_500_000;
/** The corresponding global share of the existing 3,000-call brake. */
export const M5A_GLOBAL_DAILY_CALL_CAP = 2_000;
/**
 * The longest input a model call may carry, in characters (UC-4.5, #181).
 *
 * Refused before the reservation. A twenty-thousand-character paste is not a
 * capture, and the cost of one is what a whole day of ordinary use costs.
 */
export const MAX_INPUT_CHARACTERS = 20_000;
/** How long a usage document is kept, for the Firestore TTL policy. */
export const USAGE_TTL_DAYS = 7;



/**
 * `unavailable` is a refusal, not an error.
 *
 * If the counters cannot be read or written — contention, an outage — the
 * guard does not know what has been spent today. Permitting the call would
 * make the cap advisory exactly when it matters, so the call is refused and
 * capture falls back to rules. Spending nothing is recoverable; spending
 * without a limit is not.
 */
export type ReservationOutcome =
  | 'ok'
  | 'user_cap'
  | 'user_token_cap'
  | 'user_minute_cap'
  | 'global_cap'
  | 'unavailable';

/**
 * The scope a client is told about, when it is told anything.
 *
 * Deliberately coarser than `ReservationOutcome`: a user learns that *they* are
 * over a limit or that *the service* is, and never which internal counter said
 * so. `global_daily` is the one that is nobody's fault, and the copy for it says
 * so.
 */
export type QuotaScope = 'user_daily' | 'user_minute' | 'global_daily';

export function quotaScopeFor(outcome: ReservationOutcome): QuotaScope | null {
  switch (outcome) {
    case 'user_cap':
    case 'user_token_cap':
      return 'user_daily';
    case 'user_minute_cap':
      return 'user_minute';
    case 'global_cap':
      return 'global_daily';
    default:
      return null;
  }
}

/**
 * How long to wait, in seconds, for a scope that will clear on its own.
 *
 * A minute cap clears within the minute. A daily cap clears at the next UTC
 * midnight, and saying so is more useful than a fixed number — "try again in
 * 3600 seconds" is wrong for most of the day.
 */
export function retryAfterSecondsFor(scope: QuotaScope, now: Date): number {
  if (scope === 'user_minute') return 60 - now.getUTCSeconds();
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextMidnight - now.getTime()) / 1_000));
}

export interface UsageDay {
  /** Calls reserved today, whether or not the provider answered. */
  calls: number;
  /** For reading a day's shape without joining the path back together. */
  date: string;
  updatedAt: string;
  /**
   * Tokens actually spent today, recorded after each call answers (#181).
   *
   * Separate from `calls` because they cap different things, and recorded after
   * rather than reserved before: the true count is only known once the provider
   * has replied, and reserving an estimate would either under-count (useless) or
   * over-count (refusing calls that would have fit).
   */
  inputTokens?: number;
  outputTokens?: number;
  /** Calls/tokens reserved by whole M5a work units, reconciled by their permits. */
  m5aCalls?: number;
  m5aReservedTokens?: number;
  m5aInputTokens?: number;
  m5aOutputTokens?: number;
  /** Legacy shared reservation field, retained for old documents and general usage. */
  reservedTokens?: number;
  /**
   * The minute window the counter below belongs to, `YYYY-MM-DDTHH:MM`.
   *
   * The per-minute limit lives on this same document rather than in process
   * memory or a document of its own. In memory it would cap each Cloud Run
   * instance separately — the real limit becoming the cap times however many
   * instances happen to be up, a number nobody chose. In its own document it
   * would double the writes on the hottest path in the product. Here it is exact
   * across instances and costs nothing, because this document is already being
   * read and written in the same transaction.
   */
  minute?: string;
  minuteCalls?: number;
  /** When Firestore's TTL policy may delete this document. */
  expireAt?: string;
}

export type QuotaPermitSlotState = 'reserved' | 'started' | 'settled';

export interface QuotaPermitRecord {
  readonly v: 1;
  readonly permitId: string;
  readonly uid: string;
  readonly purpose: LlmPurpose;
  readonly owner: string;
  readonly day: string;
  readonly minute: string;
  readonly tokenBudget: number;
  readonly tokenBudgetPerSlot: number;
  readonly slots: ReadonlyArray<{
    readonly state: QuotaPermitSlotState;
    readonly promptTokens?: number;
    readonly outputTokens?: number;
  }>;
  readonly finalizedAt: string | null;
  readonly createdAt: string;
  readonly expireAt: string;
}

export interface QuotaPermit {
  readonly uid: string;
  readonly permitId: string;
  readonly owner: string;
  readonly day: string;
  readonly minute: string;
  readonly slots: number;
}

export type QuotaPermitOutcome = ReservationOutcome | 'minute_boundary';

export interface QuotaPermitReservation {
  readonly outcome: QuotaPermitOutcome;
  readonly permit?: QuotaPermit;
}

export interface ReserveOptions {
  now?: Date;
  storage?: StorageAdapter;
  userCap?: number;
  globalCap?: number;
  tokenCap?: number;
  minuteCap?: number;
}

/** The UTC day a moment belongs to, as `YYYY-MM-DD`. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The UTC minute a moment belongs to, as `YYYY-MM-DDTHH:MM`. */
export function utcMinute(now: Date): string {
  return now.toISOString().slice(0, 16);
}

/** When a usage document written now becomes eligible for TTL deletion. */
function expireAtFor(now: Date): string {
  return new Date(now.getTime() + USAGE_TTL_DAYS * 86_400_000).toISOString();
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

function permitPath(uid: string, day: string, permitId: string): string {
  const id = createHash('sha256').update(`m5a\0${day}\0${permitId}`).digest('hex');
  return `${userCol(uid, USAGE)}/${requireDocId(`m5a-permit-${id}`)}`;
}

function nextUtcMinute(now: Date): Date {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  return next;
}

/**
 * Reserves a complete M5a unit before its first model call. Its per-user calls
 * and tokens live in a separate ledger, so a mailbox scan cannot consume the
 * person's capture/chat budget. The shared minute counter still stops loops,
 * and the global counters remain the project's spend brake.
 */
export async function reserveQuotaPermit(
  uid: string,
  purpose: LlmPurpose,
  input: { owner: string; calls: 1 | 2; tokenBudget: number; minimumRuntimeMs?: number },
  options: ReserveOptions = {},
): Promise<QuotaPermitReservation> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const minimumRuntimeMs = input.minimumRuntimeMs ?? (input.calls === 2 ? 18_000 : 9_000);
  if (nextUtcMinute(now).getTime() - now.getTime() < minimumRuntimeMs) return { outcome: 'minute_boundary' };
  const day = utcDay(now);
  const minute = utcMinute(now);
  const permitId = randomUUID();
  const path = permitPath(uid, day, permitId);
  const userPath = userDayPath(uid, day);
  const globalPath = globalDayPath(day);
  const at = now.toISOString();
  const tokenBudget = Math.max(1, Math.trunc(input.tokenBudget));
  const tokenBudgetPerSlot = Math.ceil(tokenBudget / input.calls);
  const globalCap = options.globalCap ?? capFrom(process.env.MAYBESITTER_LLM_GLOBAL_DAILY_CALL_CAP, DEFAULT_GLOBAL_DAILY_CAP);
  const minuteCap = options.minuteCap ?? capFrom(process.env.MAYBESITTER_LLM_MINUTE_CALL_CAP, DEFAULT_USER_MINUTE_CAP);
  try {
    const outcome = await storage.runTransaction(async tx => {
      const [userDay, globalDay] = await Promise.all([
        tx.get<UsageDay>(userPath), tx.get<UsageDay>(globalPath),
      ]);
      const minuteCalls = userDay?.minute === minute ? userDay.minuteCalls ?? 0 : 0;
      const userCalls = userDay?.calls ?? 0;
      const globalCalls = globalDay?.calls ?? 0;
      const userM5a = userDay?.m5aCalls ?? 0;
      const globalM5a = globalDay?.m5aCalls ?? 0;
      const heldTokens = userDay?.m5aReservedTokens ?? 0;
      const spentTokens = (userDay?.m5aInputTokens ?? 0) + (userDay?.m5aOutputTokens ?? 0);
      if (minuteCalls + input.calls > minuteCap) return 'user_minute_cap' as const;
      if (userM5a + input.calls > M5A_USER_DAILY_CALL_CAP) return 'user_cap' as const;
      if (spentTokens + heldTokens + tokenBudget > M5A_USER_DAILY_TOKEN_CAP) return 'user_token_cap' as const;
      if (globalCalls + input.calls > globalCap || globalM5a + input.calls > M5A_GLOBAL_DAILY_CALL_CAP) return 'global_cap' as const;
      tx.set<UsageDay>(userPath, {
        calls: userCalls, date: day, updatedAt: at,
        inputTokens: userDay?.inputTokens ?? 0, outputTokens: userDay?.outputTokens ?? 0,
        reservedTokens: userDay?.reservedTokens ?? 0,
        m5aCalls: userM5a + input.calls, m5aReservedTokens: heldTokens + tokenBudget,
        m5aInputTokens: userDay?.m5aInputTokens ?? 0, m5aOutputTokens: userDay?.m5aOutputTokens ?? 0,
        minute, minuteCalls: minuteCalls + input.calls, expireAt: expireAtFor(now),
      });
      tx.set<UsageDay>(globalPath, {
        calls: globalCalls + input.calls, date: day, updatedAt: at,
        m5aCalls: globalM5a + input.calls, expireAt: expireAtFor(now),
      });
      tx.create<QuotaPermitRecord>(path, {
        v: 1, permitId, uid, purpose, owner: input.owner, day, minute, tokenBudget, tokenBudgetPerSlot,
        slots: Array.from({ length: input.calls }, () => ({ state: 'reserved' as const })),
        finalizedAt: null, createdAt: at, expireAt: expireAtFor(now),
      });
      return 'ok' as const;
    });
    return outcome === 'ok'
      ? { outcome, permit: { uid, permitId, owner: input.owner, day, minute, slots: input.calls } }
      : { outcome };
  } catch (error) {
    console.error(`[llm/usage] permit reservation unavailable: ${(error as Error).name}`);
    return { outcome: 'unavailable' };
  }
}

/** Marks a permit slot immediately before provider dispatch. */
export async function startQuotaPermitSlot(
  permit: QuotaPermit,
  slot: number,
  options: { now?: Date; storage?: StorageAdapter } = {},
): Promise<boolean> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  if (utcDay(now) !== permit.day || utcMinute(now) !== permit.minute || slot < 0 || slot >= permit.slots) return false;
  return storage.runTransaction(async tx => {
    const path = permitPath(permit.uid, permit.day, permit.permitId);
    const record = await tx.get<QuotaPermitRecord>(path);
    if (!record || record.owner !== permit.owner || record.finalizedAt || record.slots[slot]?.state !== 'reserved') return false;
    const slots = record.slots.map((entry, index) => index === slot ? { ...entry, state: 'started' as const } : entry);
    tx.set(path, { ...record, slots });
    return true;
  });
}

/** Reconciles the conservative token hold after a provider response. */
export async function settleQuotaPermitSlot(
  permit: QuotaPermit,
  slot: number,
  tokens: { promptTokens?: number; outputTokens?: number },
  options: { now?: Date; storage?: StorageAdapter } = {},
): Promise<void> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  await storage.runTransaction(async tx => {
    const path = permitPath(permit.uid, permit.day, permit.permitId);
    const record = await tx.get<QuotaPermitRecord>(path);
    if (!record || record.owner !== permit.owner || record.slots[slot]?.state !== 'started') return;
    const promptTokens = Math.max(0, Math.trunc(tokens.promptTokens ?? 0));
    const outputTokens = Math.max(0, Math.trunc(tokens.outputTokens ?? 0));
    const userPath = userDayPath(permit.uid, permit.day);
    const usage = await tx.get<UsageDay>(userPath);
    const slots = record.slots.map((entry, index) => index === slot
      ? { state: 'settled' as const, promptTokens, outputTokens } : entry);
    tx.set(path, { ...record, slots });
    tx.set<UsageDay>(userPath, {
      calls: usage?.calls ?? 0, date: permit.day, updatedAt: now.toISOString(),
      inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
      reservedTokens: usage?.reservedTokens ?? 0,
      m5aCalls: usage?.m5aCalls ?? 0,
      m5aReservedTokens: Math.max(0, (usage?.m5aReservedTokens ?? 0) - record.tokenBudgetPerSlot),
      m5aInputTokens: (usage?.m5aInputTokens ?? 0) + promptTokens,
      m5aOutputTokens: (usage?.m5aOutputTokens ?? 0) + outputTokens,
      ...(usage?.minute ? { minute: usage.minute, minuteCalls: usage.minuteCalls ?? 0 } : {}),
      expireAt: expireAtFor(now),
    });
  });
}

/** Releases only never-started slots; started calls stay charged after crashes. */
export async function finalizeQuotaPermit(
  permit: QuotaPermit,
  options: { now?: Date; storage?: StorageAdapter } = {},
): Promise<void> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  await storage.runTransaction(async tx => {
    const path = permitPath(permit.uid, permit.day, permit.permitId);
    const record = await tx.get<QuotaPermitRecord>(path);
    if (!record || record.owner !== permit.owner || record.finalizedAt) return;
    const unused = record.slots.filter(slot => slot.state === 'reserved').length;
    const releasableTokens = record.slots.reduce((sum, slot) => sum + (slot.state === 'reserved' ? record.tokenBudgetPerSlot : 0), 0);
    const [usage, global] = await Promise.all([
      tx.get<UsageDay>(userDayPath(permit.uid, permit.day)), tx.get<UsageDay>(globalDayPath(permit.day)),
    ]);
    if (usage) tx.set<UsageDay>(userDayPath(permit.uid, permit.day), {
      ...usage, m5aCalls: Math.max(0, (usage.m5aCalls ?? 0) - unused),
      m5aReservedTokens: Math.max(0, (usage.m5aReservedTokens ?? 0) - releasableTokens), updatedAt: now.toISOString(),
    });
    if (global) tx.set<UsageDay>(globalDayPath(permit.day), {
      ...global, calls: Math.max(0, global.calls - unused), m5aCalls: Math.max(0, (global.m5aCalls ?? 0) - unused), updatedAt: now.toISOString(),
    });
    tx.set(path, { ...record, finalizedAt: now.toISOString() });
  });
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
  const tokenCap = options.tokenCap
    ?? capFrom(process.env.MAYBESITTER_LLM_DAILY_TOKEN_CAP, DEFAULT_USER_DAILY_TOKEN_CAP);
  const minuteCap = options.minuteCap
    ?? capFrom(process.env.MAYBESITTER_LLM_MINUTE_CALL_CAP, DEFAULT_USER_MINUTE_CAP);
  const minute = utcMinute(now);

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

      // The user's caps are checked first so that one account in a loop is told
      // it is the one over budget, rather than blaming the service. The minute
      // cap comes before the daily ones because it is the one that will clear on
      // its own in seconds, and telling somebody to wait a minute is a better
      // answer than telling them to wait until tomorrow.
      const sameMinute = userDay?.minute === minute;
      const minuteCalls = sameMinute ? (userDay?.minuteCalls ?? 0) : 0;
      if (minuteCalls >= minuteCap) return 'user_minute_cap';
      if (userCalls >= userCap) return 'user_cap';
      const spentTokens = (userDay?.inputTokens ?? 0) + (userDay?.outputTokens ?? 0);
      if (spentTokens >= tokenCap) return 'user_token_cap';
      if (globalCalls >= globalCap) return 'global_cap';

      tx.set<UsageDay>(userPath, {
        calls: userCalls + 1,
        date: day,
        updatedAt: at,
        // Carried forward rather than reset: `commit` writes these after the
        // call answers, and a reservation must not erase what today has spent.
        inputTokens: userDay?.inputTokens ?? 0,
        outputTokens: userDay?.outputTokens ?? 0,
        reservedTokens: userDay?.reservedTokens ?? 0,
        m5aCalls: userDay?.m5aCalls ?? 0,
        m5aReservedTokens: userDay?.m5aReservedTokens ?? 0,
        m5aInputTokens: userDay?.m5aInputTokens ?? 0,
        m5aOutputTokens: userDay?.m5aOutputTokens ?? 0,
        minute,
        minuteCalls: minuteCalls + 1,
        expireAt: expireAtFor(now),
      });
      tx.set<UsageDay>(globalPath, {
        calls: globalCalls + 1,
        date: day,
        updatedAt: at,
        m5aCalls: globalDay?.m5aCalls ?? 0,
        expireAt: expireAtFor(now),
      });
      return 'ok';
    });
  } catch (error) {
    // Named, and without the provider's message: a storage error can quote the
    // document it failed on, and these documents are keyed by uid.
    console.error(`[llm/usage] reservation unavailable: ${(error as Error).name}`);
    return 'unavailable';
  }
}

/**
 * Records what a call actually cost, after it answered (UC-4.5, #181).
 *
 * Tokens are committed rather than reserved because the true count is only known
 * once the provider has replied. Reserving an estimate would be wrong in one of
 * two ways: too low and the cap never bites, too high and calls that would have
 * fit are refused.
 *
 * A failure here is logged and swallowed. The call has already happened and the
 * user already has their answer; turning a bookkeeping write into their error
 * would be the same mistake #153 fixed on the confirm path. The consequence of
 * losing one is that the token cap is slightly generous for one day, which is
 * recoverable — and the *call* cap was reserved before the call, so the hard
 * brake is unaffected.
 */
export async function commitUsage(
  uid: string,
  tokens: { promptTokens?: number; outputTokens?: number },
  options: { now?: Date; storage?: StorageAdapter } = {},
): Promise<void> {
  const promptTokens = Math.max(0, Math.trunc(tokens.promptTokens ?? 0));
  const outputTokens = Math.max(0, Math.trunc(tokens.outputTokens ?? 0));
  if (promptTokens === 0 && outputTokens === 0) return;

  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const day = utcDay(now);
  const userPath = userDayPath(uid, day);

  try {
    await storage.runTransaction(async (tx) => {
      const current = await tx.get<UsageDay>(userPath);
      tx.set<UsageDay>(userPath, {
        // A commit for a day with no reservation should not invent one, but it
        // must not lose the tokens either: the counters are what the cap reads.
        calls: current?.calls ?? 0,
        date: day,
        updatedAt: now.toISOString(),
        inputTokens: (current?.inputTokens ?? 0) + promptTokens,
        outputTokens: (current?.outputTokens ?? 0) + outputTokens,
        reservedTokens: current?.reservedTokens ?? 0,
        m5aCalls: current?.m5aCalls ?? 0,
        m5aReservedTokens: current?.m5aReservedTokens ?? 0,
        m5aInputTokens: current?.m5aInputTokens ?? 0,
        m5aOutputTokens: current?.m5aOutputTokens ?? 0,
        ...(current?.minute ? { minute: current.minute, minuteCalls: current.minuteCalls ?? 0 } : {}),
        expireAt: expireAtFor(now),
      });
    });
  } catch (error) {
    // Named, and without the message: a storage error can quote the document it
    // failed on, and these are keyed by uid.
    console.error(`[llm/usage] token commit failed: ${(error as Error).name}`);
  }
}

/**
 * Claims one of something a user may do N times a day (UC-3.0, #183).
 *
 * The share route needs a per-account daily limit on *analyses*, which is not
 * the same number as model calls: one share is one analysis and may be one or
 * two calls, and the two limits answer different questions — "is this account
 * looping" versus "what is this account costing". They share this file so that
 * both are one transaction on one document shape, with one day boundary and one
 * TTL, rather than a second counter written somewhere else with its own rules.
 *
 * The document is `users/{uid}/usage/{action}-{yyyy-mm-dd}`, beside the model
 * counters and expiring on the same policy. It does **not** touch the global
 * counter: a global cap on model spend is a real thing, and a global cap on how
 * many people may open a share sheet is not.
 *
 * `unavailable` is a refusal for the same reason it is above: a counter that
 * cannot be read is not an absent one.
 */
export async function reserveDailyAction(
  uid: string,
  action: string,
  cap: number,
  options: { now?: Date; storage?: StorageAdapter } = {},
): Promise<'ok' | 'user_cap' | 'unavailable'> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const day = utcDay(now);
  const path = userDayPath(uid, `${action}-${day}`);

  try {
    return await storage.runTransaction(async (tx) => {
      const current = await tx.get<UsageDay>(path);
      const calls = current?.calls ?? 0;
      if (calls >= cap) return 'user_cap';
      tx.set<UsageDay>(path, {
        calls: calls + 1,
        date: day,
        updatedAt: now.toISOString(),
        expireAt: expireAtFor(now),
      });
      return 'ok';
    });
  } catch (error) {
    // Named, and without the message: a storage error can quote the document it
    // failed on, and these documents are keyed by uid.
    console.error(`[llm/usage] ${action} reservation unavailable: ${(error as Error).name}`);
    return 'unavailable';
  }
}

/** What an action has been used for today, for tests and for answering "why". */
export async function actionsToday(
  uid: string,
  action: string,
  options: { now?: Date; storage?: StorageAdapter } = {},
): Promise<number> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const day = await storage.get<UsageDay>(userDayPath(uid, `${action}-${utcDay(now)}`));
  return day?.calls ?? 0;
}

/**
 * The kill switch (UC-4.5, #181 step 3).
 *
 * One environment variable that takes every model call out of the product at
 * once, without a code change and without disabling billing — which would take
 * the whole app down for everyone rather than just the model. Flipped in
 * Cloud Run → Edit & deploy new revision → Variables.
 *
 * Read on every call rather than cached, for the same reason consent is: "it is
 * off now" has to be true on the next request rather than after a restart.
 */
export function aiDisabled(): boolean {
  const raw = (process.env.MAYBESITTER_AI_DISABLED ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** What has been reserved today, for tests and for an operator answering "why". */
export async function callsToday(
  uid: string,
  options: { now?: Date; storage?: StorageAdapter } = {},
): Promise<{ user: number; global: number; tokens: number; minuteCalls: number }> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const day = utcDay(now);
  const [userDay, globalDay] = await Promise.all([
    storage.get<UsageDay>(userDayPath(uid, day)),
    storage.get<UsageDay>(globalDayPath(day)),
  ]);
  return {
    user: userDay?.calls ?? 0,
    global: globalDay?.calls ?? 0,
    tokens: (userDay?.inputTokens ?? 0) + (userDay?.outputTokens ?? 0),
    // Zero unless the stored window is the one being asked about; a count from
    // three minutes ago is not this minute's.
    minuteCalls: userDay?.minute === utcMinute(now) ? (userDay?.minuteCalls ?? 0) : 0,
  };
}
