/**
 * What each feature has spent on the model this month, per person.
 *
 * One document a month at `users/{uid}/usage/spend-YYYY-MM`, beside the daily
 * counters in `usageGuard.ts` and deleted with the account the same way. The
 * month is UTC for the reason the day is UTC there: one arbitrary boundary
 * rather than one per timezone.
 *
 * Spend is recorded after a call answers, like `commitUsage`, because the true
 * token count is only known then. A failed write is logged and swallowed: the
 * person already has their answer, and the daily call caps were reserved
 * before the call, so the hard brake does not depend on this document.
 */
import { getStorage, requireDocId, USAGE, userCol, type StorageAdapter } from '../storage';
import type { FeatureId } from './catalog';

export interface MonthSpend {
  readonly month: string;
  readonly totalNanoUsd: number;
  readonly features: Readonly<Partial<Record<FeatureId, number>>>;
  readonly updatedAt: string;
  readonly expireAt: string;
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
function expireAtFor(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).toISOString();
}

export function emptyMonth(now: Date): MonthSpend {
  return { month: monthKey(now), totalNanoUsd: 0, features: {}, updatedAt: now.toISOString(), expireAt: expireAtFor(now) };
}

/** Throws when storage cannot be read: an unknown spend is not a zero spend. */
export async function readMonthSpend(uid: string, options: LedgerOptions = {}): Promise<MonthSpend> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const stored = await storage.get<MonthSpend>(monthPath(uid, monthKey(now)));
  return stored ?? emptyMonth(now);
}

export async function recordFeatureSpend(
  uid: string,
  feature: FeatureId,
  nanoUsd: number,
  options: LedgerOptions = {},
): Promise<void> {
  const amount = Number.isFinite(nanoUsd) ? Math.max(0, Math.trunc(nanoUsd)) : 0;
  if (amount === 0) return;
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const path = monthPath(uid, monthKey(now));
  try {
    await storage.runTransaction(async tx => {
      const current = (await tx.get<MonthSpend>(path)) ?? emptyMonth(now);
      tx.set<MonthSpend>(path, {
        month: current.month,
        totalNanoUsd: current.totalNanoUsd + amount,
        features: { ...current.features, [feature]: (current.features[feature] ?? 0) + amount },
        updatedAt: now.toISOString(),
        expireAt: expireAtFor(now),
      });
    });
  } catch (error) {
    // Named, without the message: a storage error can quote the uid-keyed path.
    console.error(`[features/spend] record failed: ${(error as Error).name}`);
  }
}
