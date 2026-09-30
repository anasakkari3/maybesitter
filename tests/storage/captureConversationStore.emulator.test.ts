/**
 * The capture-chat conversation store against real Firestore (2026-09-30).
 *
 * The memory adapter stores whatever JSON accepts; Firestore does not (the
 * proposal store's nested-array lesson, #252). A conversation holds an array
 * of `{ role, text }` maps, a nullable proposal id and a `Date` for the TTL
 * policy — this is the round trip that proves Firestore takes all three, and
 * that a conversation is addressed by its owner: the same id read under
 * another uid is nothing, through a separate instance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage, resetFirestoreForTests } from '../../lib/storage/firestoreAdapter.ts';
import { CaptureConversationStore, captureConversationPath } from '../../lib/services/captureChat/conversationStore.ts';
import { userDoc } from '../../lib/storage/paths.ts';

test('firestore: a conversation round-trips with its turns, and only under its owner', async () => {
  const owner = `chat_${Date.now().toString(36)}a`;
  const other = `chat_${Date.now().toString(36)}b`;
  const conversationId = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const writer = createFirestoreStorage();
  const reader = createFirestoreStorage();
  try {
    await new CaptureConversationStore(writer).put(owner, {
      conversationId,
      turns: [
        { role: 'user', text: 'ذكرني بكرا الساعة 5 المسا أحكي مع الدكتور' },
        { role: 'assistant', text: 'هيك فهمت. شوف القائمة وإذا كلها تمام أكّدها.' },
      ],
      proposalId: null,
      createdAt: '2026-09-30T07:00:00.000Z',
      updatedAt: '2026-09-30T07:00:00.000Z',
    }, new Date('2026-09-30T07:00:00.000Z'));

    const back = await new CaptureConversationStore(reader).get(owner, conversationId);
    assert.ok(back, 'the conversation was not stored');
    assert.deepEqual(back.turns.map((turn) => turn.role), ['user', 'assistant']);
    assert.equal(back.turns[0]!.text, 'ذكرني بكرا الساعة 5 المسا أحكي مع الدكتور');
    assert.equal(back.proposalId, null);

    // The TTL policy reads a timestamp; a string would never delete anything.
    const raw = await reader.get<{ expiresAt: unknown }>(captureConversationPath(owner, conversationId));
    const stamp = raw?.expiresAt as { toDate?: () => Date } | Date | undefined;
    const expires = stamp instanceof Date ? stamp : stamp?.toDate?.();
    assert.ok(expires instanceof Date, `expiresAt is ${typeof raw?.expiresAt}, not a timestamp`);
    assert.equal(expires.toISOString(), '2026-10-01T07:00:00.000Z', 'expiresAt is not a day after the last turn');

    assert.equal(await new CaptureConversationStore(reader).get(other, conversationId), null, 'another uid read the conversation');
  } finally {
    await createFirestoreStorage().deleteTree(userDoc(owner)).catch(() => {});
    resetFirestoreForTests();
  }
});
