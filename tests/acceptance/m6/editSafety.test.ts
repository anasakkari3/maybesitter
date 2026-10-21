/**
 * M6a-2 Gate B, R0 — the memory edit path made safe (PLAN-M6a-2, review r1
 * findings M6A2-R001, R002, R004). Gate author: Claude, written before Task
 * B's build. Confirming a proposed translation is the existing
 * `PATCH /api/mobile/memory/{id}`, so these hold for every edit.
 *
 * The competing writes are made from the memory adapter's before-commit hook
 * (a write landing between a transaction's last read and its commit, as a
 * second Cloud Run instance would) or from inside `deleteScope`'s list (a
 * storage wrapper). Each test must fail on 4d555c3c, where `supersede` reads,
 * then writes twice outside any transaction.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { createStorageRuntimeMemoryStore } from '../../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { deleteMemory, patchMemory } from '../../../lib/services/mobile/memoryService.ts';
import { GOAL_GRAPH_PROPOSALS, GOAL_LINEAGES, userCol, userDoc } from '../../../lib/storage/paths.ts';
import type { StorageAdapter } from '../../../lib/storage/storageAdapter.ts';
import { addRows, call, currentStorage, show } from '../m5b/support.ts';
import { begin, end } from './support.ts';

afterEach(() => {
  try { (currentStorage() as any).setBeforeCommitHookForTests(null); } catch { /* no storage */ }
  end();
});

const store = (storage: StorageAdapter = currentStorage() as unknown as StorageAdapter) =>
  createStorageRuntimeMemoryStore(undefined, storage);

function memoryPaths(): string[] {
  return ((currentStorage() as any).pathsForTests() as string[]).filter((path) => /\/memory\/[^/]+$/.test(path));
}

async function pathOf(id: string): Promise<string> {
  const path = memoryPaths().find((candidate) => candidate.endsWith(`/memory/${id}`));
  assert.ok(path, `no stored record ${id}`);
  return path!;
}

async function active(uid: string): Promise<Array<{ id: string; content: string; language: string }>> {
  return (await store().listAll(uid)).filter((record) => record.status === 'active') as any;
}

/** Runs `write` once, at the first commit check that finds `id` still active. */
function onceWhileActive(id: string, write: (storage: any, path: string, record: any) => Promise<void>): void {
  const storage = currentStorage() as any;
  let done = false;
  storage.setBeforeCommitHookForTests(async () => {
    if (done) return;
    const path = memoryPaths().find((candidate) => candidate.endsWith(`/memory/${id}`));
    if (!path) return;
    const record = await storage.get(path);
    if (!record || record.status !== 'active') return;
    done = true;
    await write(storage, path, record);
  });
}

const at = () => new Date().toISOString();

test('R0.1 two concurrent PATCHes of one head: one 200, the other 409 or 404, and exactly one active head', async () => {
  const uid = await begin();
  const [row] = await addRows(uid, [{ content: 'Prefers quiet mornings', language: 'en' }]);
  const results = await Promise.all([
    call(uid, 'memory/[id]', 'PATCH', { params: { id: row!.id }, body: { content: 'First edit' } }),
    call(uid, 'memory/[id]', 'PATCH', { params: { id: row!.id }, body: { content: 'Second edit' } }),
  ]);
  const statuses = results.map((result) => result.status).sort();
  assert.equal(statuses.filter((status) => status === 200).length, 1, `statuses ${statuses}: ${results.map((r) => show(r.body)).join(' | ')}`);
  assert.ok([404, 409].includes(statuses.find((status) => status !== 200)!), `statuses ${statuses}`);
  const heads = await active(uid);
  assert.equal(heads.length, 1, `the chain forked: ${heads.map((h) => h.content).join(', ')}`);
});

test('R0.1 an edit that lands inside a PATCH: 409 memory_changed, and the other edit stands alone', async () => {
  const uid = await begin();
  const [row] = await addRows(uid, [{ content: 'Prefers quiet mornings', language: 'en' }]);
  onceWhileActive(row!.id, async (storage, path, record) => {
    const otherId = `mem_${randomUUID()}`; // the store accepts only mem_ ids (M6A2-R2-005)
    const otherPath = path.replace(/[^/]+$/, otherId);
    await storage.set(otherPath, { ...record, id: otherId, content: 'Edited elsewhere', supersedesId: record.id });
    await storage.set(path, { ...record, status: 'superseded', supersededById: otherId, updatedAt: at() });
  });
  const result = await call(uid, 'memory/[id]', 'PATCH', { params: { id: row!.id }, body: { content: 'My edit' } });
  assert.equal(result.status, 409, show(result.body));
  assert.equal(result.body.reason ?? result.body.error, 'memory_changed', show(result.body));
  const heads = await active(uid);
  assert.deepEqual(heads.map((h) => h.content), ['Edited elsewhere']);
});

test('R0.1 a delete of the record inside a PATCH: 404, and nothing of the chain is re-created', async () => {
  const uid = await begin();
  const [row] = await addRows(uid, [{ content: 'Prefers quiet mornings', language: 'en' }]);
  onceWhileActive(row!.id, async (storage, path) => { await storage.delete(path); });
  await assert.rejects(
    patchMemory(uid, row!.id, 'My edit', at(), { storage: currentStorage() as any }),
    (error: Error) => error.name === 'MemoryNotFoundError',
  );
  assert.deepEqual(await store().listAll(uid), [], 'a deleted memory came back');
});

test('R0.1 an edit that commits after delete-one discovered the chain, before its deletes: the replacement is deleted too (M6A2-R2-001)', async () => {
  const uid = await begin();
  const [row] = await addRows(uid, [{ content: 'Prefers quiet mornings', language: 'en' }]);
  // Delete-one discovers the chain with reads, then deletes by id. The edit is
  // committed at its first deleteById, after the discovery saw only the head.
  const target = currentStorage() as any;
  let armed = true;
  let replacementId = '';
  const wrapper = new Proxy(target, {
    get(object, property) {
      if (property === 'delete') {
        return async (path: string) => {
          if (armed && path.endsWith(`/memory/${row!.id}`)) {
            armed = false;
            const replacement = await patchMemory(uid, row!.id, 'Edited mid-delete', at(), { storage: target });
            replacementId = replacement.id;
            // A step proposal written for the replacement: downstream cleanup must see its id too (M6A2-R3-003).
            await target.set(`${userCol(uid, GOAL_GRAPH_PROPOSALS)}/p-${replacement.id}`, { goalMemoryId: replacement.id, scopeId: uid });
          }
          return object.delete(path);
        };
      }
      const value = object[property];
      return typeof value === 'function' ? value.bind(object) : value;
    },
  }) as StorageAdapter;
  const removed = await deleteMemory(uid, row!.id, at(), { storage: wrapper });
  assert.equal(armed, false, 'the edit was never interleaved');
  assert.deepEqual((await store().listAll(uid)).map((r) => r.content), [], 'the replacement survived delete-one');
  assert.equal(removed, 2, 'the swept replacement was not counted');
  const proposals = await target.list(userCol(uid, GOAL_GRAPH_PROPOSALS));
  assert.deepEqual(proposals.filter((p: any) => p.data.goalMemoryId === replacementId), [], 'cleanup keyed by ids never saw the swept replacement');
});

test('R0.2 the account deletion mark landing inside a PATCH: refused, and no replacement is written', async () => {
  const uid = await begin();
  const [row] = await addRows(uid, [{ content: 'Prefers quiet mornings', language: 'en' }]);
  onceWhileActive(row!.id, async (storage) => {
    const user = (await storage.get(userDoc(uid))) ?? {};
    await storage.set(userDoc(uid), { ...user, trust: { ...(user.trust ?? {}), deletedAt: at(), updatedAt: at() } });
  });
  await assert.rejects(
    patchMemory(uid, row!.id, 'My edit', at(), { storage: currentStorage() as any }),
    (error: Error) => error.name === 'MemoryNotFoundError',
  );
  const records = await store().listAll(uid);
  assert.deepEqual(records.map((r) => r.content), ['Prefers quiet mornings'], 'an edit was written after the account was marked deleted');
});

test('R0.2 a goal edit\'s lineage follow-up, after account deletion removed the tree mid-PATCH: no goal lineage is recreated (M6A2-R4-001)', async () => {
  const uid = await begin();
  const [row] = await addRows(uid, [{ content: 'Run a half marathon', language: 'en', kind: 'goal' }]);
  const storage = currentStorage() as any;
  let done = false;
  // Fires at the first commit check after the memory supersession has landed —
  // the goal-lineage transaction — and plays the account deletion: the mark,
  // then the user tree.
  storage.setBeforeCommitHookForTests(async () => {
    if (done) return;
    const priorPath = memoryPaths().find((candidate) => candidate.endsWith(`/memory/${row!.id}`));
    const prior = priorPath ? await storage.get(priorPath) : null;
    if (!prior || prior.status !== 'superseded') return;
    done = true;
    const user = (await storage.get(userDoc(uid))) ?? {};
    await storage.set(userDoc(uid), { ...user, trust: { ...(user.trust ?? {}), deletedAt: at(), updatedAt: at() } });
    for (const path of (storage.pathsForTests() as string[]).filter((candidate) => candidate.startsWith(`${userDoc(uid)}/`))) {
      await storage.delete(path);
    }
  });
  await patchMemory(uid, row!.id, 'Run a full marathon', at(), { storage }).catch(() => null);
  assert.equal(done, true, 'the deletion never interleaved after the supersession');
  const lineages = await storage.list(userCol(uid, GOAL_LINEAGES));
  assert.deepEqual(lineages.map((l: any) => l.id), [], 'goal lineage rows were written under a deleted account');
  assert.deepEqual(memoryPaths().filter((path) => path.startsWith(`${userDoc(uid)}/`)), []);
});

test('R0.3 an edit that commits between delete-all\'s list and its deletes is swept: nothing is left', async () => {
  const uid = await begin();
  const [row] = await addRows(uid, [{ content: 'Prefers quiet mornings', language: 'en' }]);
  const target = currentStorage() as any;
  let armed = true;
  const wrapper = new Proxy(target, {
    get(object, property) {
      if (property === 'list') {
        return async (collection: string, options?: unknown) => {
          const rows = await object.list(collection, options);
          if (armed && /\/memory$/.test(collection)) {
            armed = false;
            await patchMemory(uid, row!.id, 'Edited mid-delete', at(), { storage: target });
          }
          return rows;
        };
      }
      const value = object[property];
      return typeof value === 'function' ? value.bind(object) : value;
    },
  }) as StorageAdapter;
  await store(wrapper).deleteScope(uid);
  assert.equal(armed, false, 'deleteScope never listed the memory collection');
  assert.deepEqual((await store().listAll(uid)).map((r) => r.content), [], 'an edit survived delete-all');
  assert.deepEqual(memoryPaths().filter((path) => path.includes(uid)), []);
});

test('R0.4 an ordinary edit stores the language of its own text: ar → en is en, en → he is he', async () => {
  const uid = await begin();
  const [row] = await addRows(uid, [{ content: 'بحب القهوة', language: 'ar' }]);
  const english = await call(uid, 'memory/[id]', 'PATCH', { params: { id: row!.id }, body: { content: 'Likes coffee' } });
  assert.equal(english.status, 200, show(english.body));
  assert.equal(english.body.memory.language, 'en');
  const hebrew = await call(uid, 'memory/[id]', 'PATCH', { params: { id: english.body.memory.id }, body: { content: 'אוהב קפה' } });
  assert.equal(hebrew.status, 200, show(hebrew.body));
  assert.equal(hebrew.body.memory.language, 'he');
  const heads = await active(uid);
  assert.deepEqual(heads.map((h) => h.language), ['he']);
});
