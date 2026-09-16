/**
 * The Must ring identifier, server side (#198 review F2). The table is shared
 * with the phone's `mustRingIdentifier.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mustRingIdentifier } from '../../lib/services/reminders/mustRingIdentifier.ts';
import { assertPushData } from '../../lib/push/pushService.ts';

const table = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mobile/src/features/reminders/__fixtures__/mustRingIdentifier.json'),
  'utf8',
)) as { cases: Array<{ commitmentId: string; identifier: string }> };

test('the shared table covers a uuid, a long id and a non-ASCII id', () => {
  assert.ok(table.cases.some((c) => c.commitmentId.length === 128));
  assert.ok(table.cases.some((c) => /[^\x00-\x7f]/.test(c.commitmentId)));
});

for (const c of table.cases) {
  test(`identifier for ${c.commitmentId.slice(0, 24)}… (${c.commitmentId.length})`, () => {
    const identifier = mustRingIdentifier(c.commitmentId);
    assert.equal(identifier, c.identifier);
    // Every one of them is a collapse id the push service accepts.
    assert.doesNotThrow(() => assertPushData({
      kind: 'hard_reminder', uid: 'u', dedupeKey: 'hard:x', collapseId: identifier,
      data: { tag: identifier, notificationId: identifier }, title: 't', body: 'b', urgency: 'time_sensitive', respectQuietHours: true,
    }));
  });
}
