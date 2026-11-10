/**
 * What each feature has spent on the model this month, per person.
 *
 * One document a month at `users/{uid}/usage/spend-YYYY-MM`, beside the daily
 * counters in `usageGuard.ts` and deleted with the account the same way. The
 * month is UTC for the reason the day is UTC there: one arbitrary boundary
 * rather than one per timezone.
 *
 * ── Hold, then settle ────────────────────────────────────────────
 *
 * A budget read before a call and charged after it lets every call in flight
 * pass the same check: eight concurrent chat turns could each see the last
 * cent free. Under `enforce` a call therefore *holds* its worst-case cost in
 * this document, inside the transaction that checks the budget, and the hold
 * is settled to the true cost when the call answers (or released when it does
 * not). A hold whose process died is ignored after `HOLD_TTL_MS`, so a crash
 * can withhold budget for minutes, never for the month.
 *
 * Settling and plain recording are logged and swallowed on failure, like
 * `commitUsage`: the person already has their answer, and the hold already
 * counted the worst case against the budget.
 */
import { randomUUID } from 'node:crypto';
import { getStorage, requireDocId, USAGE, userCol, type StorageAdapter } from '../storage';
import type { FeatureId } from './catalog';

export const HOLD_TTL_MS = 15 * 60_000;

export interface SpendHoldRecord {
  readonly feature: FeatureId;
  readonly nanoUsd: number;
  readonly at: string;
}

export interface MonthSpend {
  readonly month: string;
  readonly totalNanoUsd: number;
  readonly features: Readonly<Partial<Record<FeatureId, number>>>;
  /** Worst-case costs of calls in flight, keyed by hold id. */
  readonly holds?: Readonly<Record<string, SpendHoldRecord>>;
  readonly updatedAt: string;
  readonly expireAt: string;
}

/** What a caller keeps between `reserveFeatureSpend` and settling it. */
export interface SpendHold {
  readonly id: string;
  readonly month: string;
  readonly feature: FeatureId;
  readonly nanoUsd: number;
}

export interface LedgerOptions {
  readonly now?: Date;
  readonly storage?: StorageAdapter;
}

/** The UTC month a moment belongs to, as `YYYY-MM`. */
export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** The first instant of the next UTC month. */
export function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function monthPath(uid: string, month: string): string {
  return `${userCol(uid, USAGE)}/${requireDocId(`spend-${month}`)}`;
}

/** Kept through the following month, then left to the usage TTL policy. */
function expireAtFor(month: string): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, index + 1, 1)).toISOString();
}

export function emptyMonth(now: Date): MonthSpend {
  const month = monthKey(now);
  return { month, totalNanoUsd: 0, features: {}, holds: {}, updatedAt: now.toISOString(), expireAt: expireAtFor(month) };
}

function liveHolds(month: MonthSpend, now: Date): Record<string, SpendHoldRecord> {
  const live: Record<string, SpendHoldRecord> = {};
  for (const [id, hold] of Object.entries(month.holds ?? {})) {
    if (now.getTime() - Date.parse(hold.at) < HOLD_TTL_MS) live[id] = hold;
  }
  return live;
}

/** Committed spend plus the live holds, for one feature. */
export function heldSpend(month: MonthSpend, feature: FeatureId, now: Date): number {
  let total = month.features[feature] ?? 0;
  for (const hold of Object.values(liveHolds(month, now))) if (hold.feature === feature) total += hold.nanoUsd;
  return total;
}

/** Committed spend plus the live holds, over a set of features. */
export function heldSpendOver(month: MonthSpend, features: readonly FeatureId[], now: Date): number {
  let total = 0;
  for (const feature of features) total += heldSpend(month, feature, now);
  return total;
}

/** Throws when storage cannot be read: an unknown spend is not a zero spend. */
export async function readMonthSpend(uid: string, options: LedgerOptions = {}): Promise<MonthSpend> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const stored = await storage.get<MonthSpend>(monthPath(uid, monthKey(now)));
  return stored ?? emptyMonth(now);
}

function amountOf(nanoUsd: number): number {
  return Number.isFinite(nanoUsd) ? Math.max(0, Math.trunc(nanoUsd)) : 0;
}

/** The month document with `apply`'s change, live holds kept and expired ones dropped. */
async function update(
  uid: string,
  month: string,
  now: Date,
  storage: StorageAdapter,
  apply: (current: MonthSpend, holds: Record<string, SpendHoldRecord>) => MonthSpend | null,
): Promise<boolean> {
  const path = monthPath(uid, month);
  return storage.runTransaction(async tx => {
    const current = (await tx.get<MonthSpend>(path)) ?? { ...emptyMonth(now), month, expireAt: expireAtFor(month) };
    const next = apply(current, liveHolds(current, now));
    if (!next) return false;
    tx.set<MonthSpend>(path, { ...next, updatedAt: now.toISOString(), expireAt: expireAtFor(month) });
    return true;
  });
}

export async function recordFeatureSpend(
  uid: string,
  feature: FeatureId,
  nanoUsd: number,
  options: LedgerOptions = {},
): Promise<void> {
  const amount = amountOf(nanoUsd);
  if (amount === 0) return;
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  try {
    await update(uid, monthKey(now), now, storage, (current, holds) => ({
      ...current,
      holds,
      totalNanoUsd: current.totalNanoUsd + amount,
      features: { ...current.features, [feature]: (current.features[feature] ?? 0) + amount },
    }));
  } catch (error) {
    // Named, without the message: a storage error can quote the uid-keyed path.
    console.error(`[features/spend] record failed: ${(error as Error).name}`);
  }
}

export interface HoldLimits {
  /** The feature's monthly budget. */
  readonly budgetNanoUsd: number;
  /** When the feature runs on a free allowance: the free ceiling and the features it covers. */
  readonly freeCap: { readonly nanoUsd: number; readonly features: readonly FeatureId[] } | null;
}

export type HoldOutcome =
  | { readonly outcome: 'ok'; readonly hold: SpendHold }
  | { readonly outcome: 'budget_spent' | 'free_cap_spent' | 'unavailable' };

/** Holds `nanoUsd` if it fits both the feature's budget and, on a free allowance, the free ceiling. */
export async function reserveFeatureSpend(
  uid: string,
  feature: FeatureId,
  nanoUsd: number,
  limits: HoldLimits,
  options: LedgerOptions = {},
): Promise<HoldOutcome> {
  const amount = Math.max(1, amountOf(nanoUsd));
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const month = monthKey(now);
  const id = randomUUID();
  let refusal: 'budget_spent' | 'free_cap_spent' | null = null;
  try {
    const held = await update(uid, month, now, storage, (current, holds) => {
      const live = { ...current, holds };
      if (heldSpend(live, feature, now) + amount > limits.budgetNanoUsd) { refusal = 'budget_spent'; return null; }
      if (limits.freeCap && heldSpendOver(live, limits.freeCap.features, now) + amount > limits.freeCap.nanoUsd) {
        refusal = 'free_cap_spent';
        return null;
      }
      refusal = null;
      return { ...current, holds: { ...holds, [id]: { feature, nanoUsd: amount, at: now.toISOString() } } };
    });
    if (!held) return { outcome: refusal ?? 'budget_spent' };
    return { outcome: 'ok', hold: { id, month, feature, nanoUsd: amount } };
  } catch (error) {
    console.error(`[features/spend] hold unavailable: ${(error as Error).name}`);
    return { outcome: 'unavailable' };
  }
}

/** Replaces the hold with what the call really cost. */
export async function settleFeatureSpend(
  uid: string,
  hold: SpendHold,
  nanoUsd: number,
  options: LedgerOptions = {},
): Promise<void> {
  const amount = amountOf(nanoUsd);
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  try {
    await update(uid, hold.month, now, storage, (current, holds) => {
      const { [hold.id]: _settled, ...rest } = holds;
      return {
        ...current,
        holds: rest,
        totalNanoUsd: current.totalNanoUsd + amount,
        features: { ...current.features, [hold.feature]: (current.features[hold.feature] ?? 0) + amount },
      };
    });
  } catch (error) {
    console.error(`[features/spend] settle failed: ${(error as Error).name}`);
  }
}

/** Drops a hold whose call never ran or never answered. */
export async function releaseFeatureSpend(uid: string, hold: SpendHold, options: LedgerOptions = {}): Promise<void> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  try {
    await update(uid, hold.month, now, storage, (current, holds) => {
      if (!(hold.id in holds)) return null;
      const { [hold.id]: _released, ...rest } = holds;
      return { ...current, holds: rest };
    });
  } catch (error) {
    console.error(`[features/spend] release failed: ${(error as Error).name}`);
  }
}
