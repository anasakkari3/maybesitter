/**
 * Busy blocks as a fixture, without the rows a real sync announces (#611).
 *
 * `replaceBusyBlocks` writes a `PlanningStateChange` row with every block it
 * adds, moves or removes. That is the producer, and it is tested where it
 * belongs: per writer in `tests/calendar/busyChangeRows.test.ts`, and through
 * the real tick in `tests/dailyPlan/calendarProducerTick.test.ts`.
 *
 * The replan tests that use this helper are about something else: what the
 * tick does with one change row the case writes by hand, under an id the case
 * asserts on. A sync's own rows would be a second, unasked-for change beside
 * it. So the blocks are written the production way, and the rows that write
 * produced are taken back out. The state that leaves — blocks stored, no row
 * about them — is a real one: it is what every earlier tick leaves once it has
 * drained a sync's rows.
 */
import { BUSY_CHANGE_ID_PREFIX, replaceBusyBlocks } from '../../lib/calendar/busyBlocks.ts';
import { getStorage } from '../../lib/storage/index.ts';
import { PLANNING_STATE_CHANGES, userCol } from '../../lib/storage/paths.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';

export async function replaceBusyBlocksAsFixture(
  ...args: Parameters<typeof replaceBusyBlocks>
): Promise<Awaited<ReturnType<typeof replaceBusyBlocks>>> {
  const [uid, , , , deps] = args;
  const storage = deps?.storage ?? getStorage();
  const result = await replaceBusyBlocks(...args);
  const collection = userCol(uid, PLANNING_STATE_CHANGES);
  for (const row of await storage.list<PlanningStateChange>(collection)) {
    if (row.data.changeId.startsWith(BUSY_CHANGE_ID_PREFIX)) await storage.delete(`${collection}/${row.id}`);
  }
  return result;
}
