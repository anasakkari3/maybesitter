/**
 * Weekly fixed blocks — «ثابت أسبوعي» (owner request, 2026-09-29).
 *
 * A block is a rule the person confirmed ("تدريب, every Saturday 10:00–16:00")
 * stored at `users/{uid}/weeklyBlocks/{id}`. What the planner, the replan tick
 * and the phone's calendar read is its *occurrences*: busy blocks under the
 * source `weekly-{id}`, written through `replaceBusyBlocks` (so every change is
 * announced to the replan tick, #611) from the same expansion accepted lecture
 * sessions use (`expandWeeklySessionsToBusyBlocks`).
 *
 * ── The horizon, and who keeps it rolling ────────────────────────
 *
 * An active block holds `WEEKLY_BLOCK_HORIZON_WEEKS` of occurrences ahead of
 * the moment it was last materialized, and a `renewAt` a week after that. The
 * nightly maintenance job (`runMaintenance`, step `weekly_blocks_renewed`) asks
 * for every block whose `renewAt` has arrived — one single-field
 * collection-group query, declared in firestore.indexes.json — and
 * materializes it again. A paused block carries no `renewAt` at all, so no
 * sweep can find it (a missing field matches no filter; an explicit null would
 * compare in the memory adapter and not in Firestore).
 *
 * ── The past is never rewritten ──────────────────────────────────
 *
 * Every materialization keeps each occurrence that has already *ended* exactly
 * as it is, and regenerates only the ones that have not: an edit or a pause on
 * Wednesday does not move last Saturday. Pausing therefore removes every
 * occurrence that has not ended; deleting removes all of them. History older
 * than `WEEKLY_BLOCK_HISTORY_DAYS` is pruned so a year-old block does not leave
 * fifty rows that every daily plan reads.
 *
 * ── Nothing here logs a title ────────────────────────────────────
 *
 * The title is the person's words. Errors are logged by name only.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  WEEKLY_BLOCK_HISTORY_DAYS,
  WEEKLY_BLOCK_HORIZON_WEEKS,
  WEEKLY_BLOCK_RENEW_AFTER_DAYS,
  validateWeeklyBlockShape,
  type WeeklyBlockContract,
  type WeeklyBlockDocument,
  type WeeklyBlockInput,
  type WeeklyBlockOccurrenceContract,
  type WeeklyBlockPatch,
  type WeeklyBlockSource,
} from '../../src/contracts/v1/weeklyBlockContracts';
import type { TimeInterval } from '../../src/contracts/v1/planningContracts';
import { getStorage, type StorageAdapter } from '../storage';
import { WEEKLY_BLOCKS, userCol, userSubDoc } from '../storage/paths';
import {
  deleteBusySource,
  listBusyBlocks,
  listBusyBlocksOfSource,
  replaceBusyBlocks,
  type BusyBlock,
} from '../calendar/busyBlocks';
import { expandWeeklySessionsToBusyBlocks } from '../calendar/manualBusy';
import { localDayKey } from '../services/mobile/time';

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** How many due blocks one nightly sweep renews at most. */
export const WEEKLY_BLOCK_RENEWAL_LIMIT = 500;

export interface WeeklyBlockDeps {
  readonly storage?: StorageAdapter;
  readonly now?: Date;
}

function storageOf(deps: WeeklyBlockDeps): StorageAdapter {
  return deps.storage ?? getStorage();
}

function nowOf(deps: WeeklyBlockDeps): Date {
  return deps.now ?? new Date();
}

/** The busy source a block's occurrences are filed under. */
export function weeklyBusySourceId(blockId: string): string {
  return `weekly-${blockId}`;
}

const WEEKLY_SOURCE_PREFIX = 'weekly-';

export function isWeeklyBlockId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function weeklyBlockPath(uid: string, blockId: string): string {
  return userSubDoc(uid, WEEKLY_BLOCKS, blockId);
}

/**
 * The id a capture item's block gets: derived from the proposal and the item,
 * so a confirm that is retried or replayed addresses the same document instead
 * of creating a second Saturday. Uuid-shaped like every other block id.
 */
export function captureWeeklyBlockId(proposalId: string, itemId: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['weekly-block', proposalId, itemId])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The first local date on or after `now`'s, in `timezone`, that falls on one of `weekdays`. */
export function firstOccurrenceDate(weekdays: readonly number[], timezone: string, now: Date): string {
  const today = localDayKey(now, timezone);
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = new Date(Date.UTC(year, month - 1, day + offset));
    if (weekdays.includes(candidate.getUTCDay())) return candidate.toISOString().slice(0, 10);
  }
  // Unreachable for a validated block: one to seven weekdays always match within a week.
  return today;
}

/** A renewAt stamp, or the absence of one for a block the sweep must not find. */
function withRenewAt(doc: Omit<WeeklyBlockDocument, 'renewAt'>, renewAt: string | null): WeeklyBlockDocument {
  const { renewAt: _previous, ...rest } = doc as WeeklyBlockDocument;
  return (renewAt === null ? rest : { ...rest, renewAt }) as WeeklyBlockDocument;
}

/**
 * The document a confirmed block is stored as. Pure, so the capture confirm
 * can write it inside its own transaction.
 */
export function weeklyBlockDocumentFrom(
  input: WeeklyBlockInput,
  options: { id: string; source: WeeklyBlockSource; now: Date },
): WeeklyBlockDocument {
  const at = options.now.toISOString();
  return withRenewAt({
    id: options.id,
    title: input.title,
    weekdays: [...input.weekdays],
    start: input.start,
    end: input.end,
    timezone: input.timezone,
    status: 'active',
    source: options.source,
    createdAt: at,
    updatedAt: at,
    confirmedAt: input.confirmedAt,
    startsOn: firstOccurrenceDate(input.weekdays, input.timezone, options.now),
  }, at);
}

export function presentWeeklyBlock(doc: WeeklyBlockDocument): WeeklyBlockContract {
  return {
    id: doc.id,
    title: doc.title,
    weekdays: [...doc.weekdays],
    start: doc.start,
    end: doc.end,
    timezone: doc.timezone,
    status: doc.status,
    source: doc.source,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    confirmedAt: doc.confirmedAt,
    startsOn: doc.startsOn,
    deviceEvent: doc.status === 'active'
      ? { title: doc.title, weekdays: [...doc.weekdays], start: doc.start, end: doc.end, timezone: doc.timezone, startsOn: doc.startsOn }
      : null,
  };
}

/* ── Materialization ─────────────────────────────────────────────── */

/**
 * Restates the block's busy source: the past it already has, and the horizon
 * its current rule asks for (none while paused). Then stamps the next renewal.
 */
export async function materializeWeeklyBlock(
  uid: string,
  doc: WeeklyBlockDocument,
  deps: WeeklyBlockDeps = {},
): Promise<{ written: number; removed: number }> {
  const storage = storageOf(deps);
  const now = nowOf(deps);
  const nowMs = now.getTime();
  const sourceId = weeklyBusySourceId(doc.id);

  const held = await listBusyBlocksOfSource(uid, sourceId, { storage });
  // Ended, and recent enough to keep: exactly as stored, never regenerated.
  const kept = held.filter((block) => {
    const endMs = Date.parse(block.endAt);
    return endMs <= nowMs && endMs > nowMs - WEEKLY_BLOCK_HISTORY_DAYS * DAY_MS;
  });
  const expansion = expandWeeklySessionsToBusyBlocks(
    sourceId,
    'weekly',
    doc.weekdays.map((weekday) => ({ weekday, start: doc.start, end: doc.end })),
    { timezone: doc.timezone, referenceTime: now.toISOString(), weeks: WEEKLY_BLOCK_HORIZON_WEEKS },
  );
  const upcoming = doc.status === 'active'
    ? expansion.blocks.filter((block) => Date.parse(block.endAt) > nowMs)
    : [];

  const earliest = kept.reduce((min, block) => Math.min(min, Date.parse(block.startAt)), Date.parse(expansion.window.startsAt));
  const window: TimeInterval = { startsAt: new Date(earliest).toISOString(), endsAt: expansion.window.endsAt };
  const outcome = await replaceBusyBlocks(uid, sourceId, window, [...kept, ...upcoming], { storage, platform: null, now });

  const renewAt = doc.status === 'active' ? new Date(nowMs + WEEKLY_BLOCK_RENEW_AFTER_DAYS * DAY_MS).toISOString() : null;
  await storage.runTransaction(async (tx) => {
    const current = await tx.get<WeeklyBlockDocument>(weeklyBlockPath(uid, doc.id));
    // Deleted, or changed by a later request that will materialize itself.
    if (current === null || current.updatedAt !== doc.updatedAt) return;
    tx.set(weeklyBlockPath(uid, doc.id), withRenewAt(current, renewAt));
  });
  return outcome;
}

/* ── The person's operations ─────────────────────────────────────── */

export async function readWeeklyBlock(uid: string, blockId: string, deps: WeeklyBlockDeps = {}): Promise<WeeklyBlockDocument | null> {
  if (!isWeeklyBlockId(blockId)) return null;
  return storageOf(deps).get<WeeklyBlockDocument>(weeklyBlockPath(uid, blockId));
}

export async function listWeeklyBlocks(uid: string, deps: WeeklyBlockDeps = {}): Promise<WeeklyBlockDocument[]> {
  const rows = await storageOf(deps).list<WeeklyBlockDocument>(userCol(uid, WEEKLY_BLOCKS));
  return rows
    .map((row) => row.data)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

/** Stores a block the person confirmed and materializes its horizon. */
export async function createWeeklyBlock(
  uid: string,
  input: WeeklyBlockInput,
  deps: WeeklyBlockDeps & { id?: string; source?: WeeklyBlockSource } = {},
): Promise<{ block: WeeklyBlockDocument }> {
  const storage = storageOf(deps);
  const now = nowOf(deps);
  validateWeeklyBlockShape(input);
  const doc = weeklyBlockDocumentFrom(input, { id: deps.id ?? randomUUID(), source: deps.source ?? 'manual', now });
  await storage.set(weeklyBlockPath(uid, doc.id), doc);
  await materializeWeeklyBlock(uid, doc, { storage, now });
  return { block: (await storage.get<WeeklyBlockDocument>(weeklyBlockPath(uid, doc.id))) ?? doc };
}

/**
 * Title, days, hours or status. Null when the block does not exist in this
 * account — the same answer as another account's id, because the read is
 * scoped to the caller's own tree and cannot tell the two apart.
 */
export async function patchWeeklyBlock(
  uid: string,
  blockId: string,
  patch: WeeklyBlockPatch,
  deps: WeeklyBlockDeps = {},
): Promise<WeeklyBlockDocument | null> {
  const storage = storageOf(deps);
  const now = nowOf(deps);
  const current = await readWeeklyBlock(uid, blockId, { storage });
  if (current === null) return null;

  const merged = {
    ...current,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.weekdays !== undefined ? { weekdays: [...patch.weekdays] } : {}),
    ...(patch.start !== undefined ? { start: patch.start } : {}),
    ...(patch.end !== undefined ? { end: patch.end } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
  };
  validateWeeklyBlockShape(merged);

  const scheduleChanged = merged.start !== current.start
    || merged.end !== current.end
    || merged.status !== current.status
    || merged.weekdays.join(',') !== current.weekdays.join(',');
  const at = now.toISOString();

  if (!scheduleChanged) {
    // A new title changes no busy time: occurrences carry no title.
    const next = { ...merged, updatedAt: at } as WeeklyBlockDocument;
    await storage.set(weeklyBlockPath(uid, blockId), next);
    return next;
  }

  const startsOn = merged.status === 'active'
    ? firstOccurrenceDate(merged.weekdays, merged.timezone, now)
    : current.startsOn;
  const next = withRenewAt({ ...merged, startsOn, updatedAt: at }, merged.status === 'active' ? at : null);
  await storage.set(weeklyBlockPath(uid, blockId), next);
  await materializeWeeklyBlock(uid, next, { storage, now });
  return (await storage.get<WeeklyBlockDocument>(weeklyBlockPath(uid, blockId))) ?? next;
}

/**
 * The block and every occurrence it ever wrote. The busy source goes first:
 * a block document left behind by a failure here is retried by the client and
 * shows in its list, while occurrences left behind with no block would be busy
 * time nobody could find to remove.
 */
export async function deleteWeeklyBlock(uid: string, blockId: string, deps: WeeklyBlockDeps = {}): Promise<boolean> {
  if (!isWeeklyBlockId(blockId)) return false;
  const storage = storageOf(deps);
  const existing = await storage.get<WeeklyBlockDocument>(weeklyBlockPath(uid, blockId));
  await deleteBusySource(uid, weeklyBusySourceId(blockId), { storage, now: nowOf(deps) });
  if (existing === null) return false;
  await storage.delete(weeklyBlockPath(uid, blockId));
  return true;
}

/* ── The nightly renewal ─────────────────────────────────────────── */

export interface WeeklyBlockRenewalTotals {
  due: number;
  renewed: number;
  failed: number;
}

/** `users/{uid}/weeklyBlocks/{id}` → uid. */
function uidOfPath(path: string): string {
  return path.split('/')[1] ?? '';
}

export async function runWeeklyBlockRenewal(
  deps: WeeklyBlockDeps & { limit?: number } = {},
): Promise<WeeklyBlockRenewalTotals> {
  const storage = storageOf(deps);
  const now = nowOf(deps);
  const rows = await storage.listGroup<WeeklyBlockDocument>(WEEKLY_BLOCKS, {
    where: [['renewAt', '<=', now.toISOString()]],
    orderBy: { field: 'renewAt', direction: 'asc' },
    limit: deps.limit ?? WEEKLY_BLOCK_RENEWAL_LIMIT,
  });
  const totals: WeeklyBlockRenewalTotals = { due: rows.length, renewed: 0, failed: 0 };
  for (const row of rows) {
    try {
      const uid = uidOfPath(row.path);
      // Read again rather than trusting the query row: a deletion or a pause
      // may have landed since, and neither may be re-materialized.
      const doc = await storage.get<WeeklyBlockDocument>(weeklyBlockPath(uid, row.id));
      if (doc === null || doc.status !== 'active') continue;
      await materializeWeeklyBlock(uid, doc, { storage, now });
      totals.renewed += 1;
    } catch (error) {
      totals.failed += 1;
      console.error(`[internal/jobs/maintenance] weekly block ${row.id} renewal failed`, error instanceof Error ? error.name : 'unknown');
    }
  }
  return totals;
}

/* ── Reads for the phone and the next step ───────────────────────── */

/** The materialized occurrences overlapping `window`, with their block's title. */
export async function listWeeklyBlockOccurrences(
  uid: string,
  window: TimeInterval,
  deps: WeeklyBlockDeps = {},
): Promise<WeeklyBlockOccurrenceContract[]> {
  const storage = storageOf(deps);
  const [busy, blocks] = await Promise.all([
    listBusyBlocks(uid, window, { storage }),
    listWeeklyBlocks(uid, { storage }),
  ]);
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  return busy.flatMap((occurrence: BusyBlock) => {
    if (occurrence.sourceKind !== 'weekly' || !occurrence.sourceId.startsWith(WEEKLY_SOURCE_PREFIX)) return [];
    const block = byId.get(occurrence.sourceId.slice(WEEKLY_SOURCE_PREFIX.length));
    if (!block) return [];
    return [{
      occurrenceId: occurrence.blockId,
      weeklyBlockId: block.id,
      title: block.title,
      startAt: occurrence.startAt,
      endAt: occurrence.endAt,
    }];
  });
}

/** The active block whose occurrence is under way at `at`, if any. */
export async function weeklyBlockCovering(
  uid: string,
  at: Date,
  deps: WeeklyBlockDeps = {},
): Promise<{ block: WeeklyBlockDocument; occurrence: WeeklyBlockOccurrenceContract } | null> {
  const storage = storageOf(deps);
  const instant = { startsAt: at.toISOString(), endsAt: new Date(at.getTime() + 1).toISOString() };
  const [occurrence] = await listWeeklyBlockOccurrences(uid, instant, { storage });
  if (!occurrence) return null;
  const block = await readWeeklyBlock(uid, occurrence.weeklyBlockId, { storage });
  if (!block || block.status !== 'active') return null;
  return { block, occurrence };
}
