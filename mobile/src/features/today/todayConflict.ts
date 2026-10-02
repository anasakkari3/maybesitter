import type { CommitmentView } from '../commitments/model';
import type { DeviceBusyBlock } from '../calendar/busyBlocks';
import { busyAt, chipBlock } from '../calendar/conflicts';
import { drawnClockAt } from '../plan/savedPlacement';

/**
 * Today's one conflict line (Stitch, 2026-10-02): the earliest open item of
 * the day whose hour falls inside busy time, and the block it falls in.
 *
 * The same question the rows' `BusyConflictChip` asks (`busyAt`, half-open,
 * the chip's own choice of block), asked once for the whole day so the first
 * thing on Today can say it. It is a note, never a refusal: nothing here stops
 * the item being opened, started or done.
 */
export interface TodayConflict {
  readonly item: CommitmentView;
  /** The instant the row draws, the one that is inside the block. */
  readonly at: string;
  readonly block: DeviceBusyBlock;
}

export function firstConflict(items: readonly CommitmentView[], busy: readonly DeviceBusyBlock[]): TodayConflict | null {
  let found: TodayConflict | null = null;
  for (const item of items) {
    if (item.status !== 'active') continue;
    const at = drawnClockAt(item);
    if (!at) continue;
    const block = chipBlock(busyAt(at, busy));
    if (!block) continue;
    if (!found || Date.parse(at) < Date.parse(found.at)) found = { item, at, block };
  }
  return found;
}
