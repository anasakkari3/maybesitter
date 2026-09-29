/**
 * Deleting an account takes its weekly blocks and every occurrence they
 * reserved; exporting it hands them over («ثابت أسبوعي»).
 *
 * A weekly block surviving a deletion is a standing claim on a gone person's
 * Saturdays; its occurrences are busy time the planner would keep avoiding.
 * The registry tests (`deletionCoverage`, `accountDeletion`) seed synthetic
 * rows at paths they build themselves, so they would pass if the weekly block
 * service wrote somewhere else entirely. Here the block is created through the
 * real service, its occurrences are the real materializer's, the account goes
 * through the real `deleteAccount`, and the closing assertion is behavioural:
 * the planner's own reader returns no busy time for it afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { deleteAccount, type DeletionAuthAdmin } from '../../lib/account/accountDeletion.ts';
import { resetDeletionHooksForTests } from '../../lib/account/deletionHooks.ts';
import { buildAccountExport } from '../../lib/account/accountExport.ts';
import { readBusyBlocksForPlanning } from '../../lib/calendar/busyBlocks.ts';
import { createWeeklyBlock } from '../../lib/weeklyBlocks/weeklyBlockService.ts';

const PEPPER = 'test-pepper-not-the-real-one';
const TARGET = 'user_with_weekly_blocks_deleted';
const SIBLING = 'user_still_has_weekly_blocks';
const NOW = new Date('2026-09-29T09:00:00.000Z');
const HORIZON = { startsAt: '2026-09-29T00:00:00.000Z', endsAt: '2026-12-01T00:00:00.000Z' };
const INPUT = {
  title: 'تدريب', weekdays: [6], start: '10:00', end: '16:00', timezone: 'Asia/Jerusalem', confirmedAt: NOW.toISOString(),
};

let storage: MemoryStorageAdapter;
const auth: DeletionAuthAdmin = { async revokeRefreshTokens() {}, async deleteUser() {} };

async function seed(uid: string): Promise<void> {
  await storage.set(userDoc(uid), { uid });
  await createWeeklyBlock(uid, INPUT, { storage, now: NOW });
}

function begin(): void {
  process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = PEPPER;
  resetDeletionHooksForTests();
  storage = createMemoryStorage();
}

function end(): void {
  resetDeletionHooksForTests();
  delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
}

test('a deleted account keeps no weekly block and no busy time it reserved; the sibling keeps both', async () => {
  begin();
  try {
    await seed(TARGET);
    await seed(SIBLING);
    assert.equal((await readBusyBlocksForPlanning(TARGET, HORIZON, { storage })).length, 8, 'the fixture reserved nothing');

    await deleteAccount(TARGET, { initiatedBy: 'user', storage, auth });

    assert.deepEqual((await storage.listGroup('weeklyBlocks')).filter((row) => row.path.startsWith(`${userDoc(TARGET)}/`)), []);
    assert.deepEqual(await readBusyBlocksForPlanning(TARGET, HORIZON, { storage }), [], 'a deleted account still reserves Saturdays');
    // The control: a deletion that emptied the database would pass the lines above.
    assert.equal((await storage.listGroup('weeklyBlocks')).filter((row) => row.path.startsWith(`${userDoc(SIBLING)}/`)).length, 1);
    assert.equal((await readBusyBlocksForPlanning(SIBLING, HORIZON, { storage })).length, 8);
  } finally {
    end();
  }
});

test('the account export carries the weekly block with its title, and its occurrences', async () => {
  begin();
  try {
    await seed(TARGET);
    const exported = await buildAccountExport(TARGET, { storage, now: NOW });
    const blocks = exported.collections.weeklyBlocks ?? [];
    assert.equal(blocks.length, 1);
    assert.equal((blocks[0]!.data as { title?: string }).title, 'تدريب');
    assert.equal((exported.collections.busyBlocks ?? []).length, 8);
  } finally {
    end();
  }
});
