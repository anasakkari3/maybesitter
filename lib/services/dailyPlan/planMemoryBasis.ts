import { keptFocusWindowRecord } from '../../memoryGrowth/suggestionService';
import { m5bBasisMode, type M5bBasisMode } from '../../release/m5bCapabilities';
import { getStorage, type StorageAdapter } from '../../storage';
import { userDoc } from '../../storage/paths';
import type { StoredDailyPlan } from './planStore';

export interface PlanMemoryBasisDto {
  readonly memoryId: string;
  readonly window: { readonly start: string; readonly end: string };
}

export interface PlanMemoryProjection {
  readonly mode: M5bBasisMode;
  readonly memoryBasis: PlanMemoryBasisDto | null;
  readonly memoryBasisChanged: boolean;
  readonly markerUnknown: boolean;
}

function purgeEpochOf(user: unknown): number {
  const epoch = (user as { personalizationPurge?: { epoch?: unknown } } | null)?.personalizationPurge?.epoch;
  return typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : 0;
}

function purgeRunning(user: unknown): boolean {
  return (user as { personalizationPurge?: { state?: unknown } } | null)?.personalizationPurge?.state === 'purging';
}

function minute(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function planUsedWindow(stored: StoredDailyPlan, window: { start: string; end: string }): boolean {
  const startMinute = minute(window.start);
  const endMinute = minute(window.end);
  if (startMinute === null || endMinute === null) return false;
  return stored.constraints.workingWindows.some(candidate =>
    candidate.startMinute === startMinute && candidate.endMinute === endMinute);
}

/** Live, content-free projection of the kept focus record used by a plan. */
export async function readPlanMemoryProjection(
  uid: string,
  stored: StoredDailyPlan,
  now: string,
  storage: StorageAdapter = getStorage(),
): Promise<PlanMemoryProjection> {
  const mode = m5bBasisMode();
  const markerUnknown = stored.focusFromMemory === undefined;
  if (mode === 'off') return { mode, memoryBasis: null, memoryBasisChanged: false, markerUnknown };
  if (markerUnknown || stored.focusFromMemory === false) {
    return { mode, memoryBasis: null, memoryBasisChanged: false, markerUnknown };
  }
  if (mode === 'on_nobasis') {
    return { mode, memoryBasis: null, memoryBasisChanged: true, markerUnknown: false };
  }
  // Fenced (M5B2A-REV-004): the purge state is read before the record and
  // again after it; a purge that began in between, or an epoch that moved,
  // shows no basis.
  const before = await storage.get(userDoc(uid));
  if (purgeRunning(before)) return { mode, memoryBasis: null, memoryBasisChanged: true, markerUnknown: false };
  const record = await keptFocusWindowRecord(uid, now, { storage });
  const after = await storage.get(userDoc(uid));
  const fenceHeld = !purgeRunning(after) && purgeEpochOf(after) === purgeEpochOf(before);
  if (fenceHeld && record && planUsedWindow(stored, record.window)) {
    return {
      mode,
      memoryBasis: { memoryId: record.id, window: record.window },
      memoryBasisChanged: false,
      markerUnknown: false,
    };
  }
  return { mode, memoryBasis: null, memoryBasisChanged: true, markerUnknown: false };
}
