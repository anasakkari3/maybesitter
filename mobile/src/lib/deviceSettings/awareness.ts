/**
 * "I know about this" — the pure half of `awarenessStore.ts` (UC-3.11, #196).
 *
 * The shapes and the rules, with no storage: `isAware` is what the reminder
 * planner (`features/reminders/reminderPlan.ts`) asks before it plans a stage,
 * and the planner has to load without a native module in reach — the server's
 * tests run the phone's own planner where only the root is installed (CL5a
 * round 3). Reading and writing the cache stays in `awarenessStore.ts`, the
 * one file here that touches `AsyncStorage`; its header makes the argument for
 * what is stored.
 */
export const AWARENESS_CACHE_VERSION = 1;

/** Entries older than this are forgotten; the commitments are long gone. */
export const AWARENESS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface AwarenessEntry {
  /** When the user said they knew. ISO-8601. */
  readonly at: string;
  /** The commitment's scheduled start when they said it. ISO-8601. */
  readonly startFingerprint: string;
}

export interface AwarenessCache {
  readonly version: number;
  readonly entries: Readonly<Record<string, AwarenessEntry>>;
}

export const EMPTY_AWARENESS: AwarenessCache = Object.freeze({
  version: AWARENESS_CACHE_VERSION,
  entries: Object.freeze({}),
});

/**
 * A stored blob, if this version understands it.
 *
 * A cache written by a future version reads as empty rather than as a partial
 * one. The failure direction matters: a half-read cache would silence a
 * reminder the user never acknowledged, which is the quiet failure. An empty
 * one reminds somebody about something they already know about, which they can
 * see and act on.
 */
export function parseAwarenessCache(raw: string | null): AwarenessCache {
  if (!raw) return EMPTY_AWARENESS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_AWARENESS;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_AWARENESS;
  const cache = value as Record<string, unknown>;
  if (cache.version !== AWARENESS_CACHE_VERSION) return EMPTY_AWARENESS;
  const stored = cache.entries;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return EMPTY_AWARENESS;

  const entries: Record<string, AwarenessEntry> = {};
  for (const [id, entry] of Object.entries(stored as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.at !== 'string' || typeof row.startFingerprint !== 'string') continue;
    entries[id] = { at: row.at, startFingerprint: row.startFingerprint };
  }
  return { version: AWARENESS_CACHE_VERSION, entries };
}

/** Drops entries older than `AWARENESS_MAX_AGE_MS`. Pure. */
export function pruneAwareness(cache: AwarenessCache, now: number): AwarenessCache {
  const entries: Record<string, AwarenessEntry> = {};
  for (const [id, entry] of Object.entries(cache.entries)) {
    const at = Date.parse(entry.at);
    if (!Number.isNaN(at) && now - at <= AWARENESS_MAX_AGE_MS) entries[id] = entry;
  }
  return { version: AWARENESS_CACHE_VERSION, entries };
}

/**
 * Whether the user has said they know about this commitment *as it now stands*.
 *
 * False when the start has moved: a rescheduled commitment gets a fresh cycle,
 * which is #196's third acceptance criterion.
 */
export function isAware(
  cache: AwarenessCache,
  commitmentId: string,
  scheduledStart: string | null,
): boolean {
  const entry = cache.entries[commitmentId];
  if (!entry) return false;
  return entry.startFingerprint === (scheduledStart ?? '');
}

export function withAwareness(
  cache: AwarenessCache,
  commitmentId: string,
  scheduledStart: string | null,
  at: string,
): AwarenessCache {
  return {
    version: AWARENESS_CACHE_VERSION,
    entries: { ...cache.entries, [commitmentId]: { at, startFingerprint: scheduledStart ?? '' } },
  };
}
