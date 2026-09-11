/**
 * The storage contract, written once and run against every adapter.
 *
 * `tests/storage/storageContract.test.ts` runs it against the memory adapter
 * in `npm test`; `tests/storage/storageContract.emulator.test.ts` runs the
 * identical suite against Firestore under `npm run test:emulator`. A rule that
 * only one of them obeys is a rule the memory adapter is lying about.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageUsageError, type StorageAdapter } from '../../lib/storage/storageAdapter.ts';

export interface ContractHarness {
  /** A fresh adapter, and a namespace nothing else in the run writes to. */
  adapter: StorageAdapter;
  /** A unique root id, so an emulator run does not collide with a previous one. */
  scope: string;
}

interface Row {
  id: string;
  n: number;
  label: string;
  nested?: { deep: string };
}

export function storageContractSuite(name: string, makeHarness: () => Promise<ContractHarness>): void {
  const suite = (title: string, run: (harness: ContractHarness) => Promise<void>): void => {
    test(`${name}: ${title}`, async () => {
      await run(await makeHarness());
    });
  };

  suite('a document round-trips, and a missing one reads as null', async ({ adapter, scope }) => {
    const path = `contract/${scope}/rows/a`;
    assert.equal(await adapter.get(path), null);
    await adapter.set<Row>(path, { id: 'a', n: 1, label: 'first' });
    assert.deepEqual(await adapter.get<Row>(path), { id: 'a', n: 1, label: 'first' });
  });

  suite('a read is a copy: mutating it changes nothing in storage', async ({ adapter, scope }) => {
    const path = `contract/${scope}/rows/a`;
    await adapter.set<Row>(path, { id: 'a', n: 1, label: 'first', nested: { deep: 'value' } });
    const first = await adapter.get<Row>(path);
    assert.ok(first);
    first.label = 'mutated';
    if (first.nested) first.nested.deep = 'mutated';
    const second = await adapter.get<Row>(path);
    assert.equal(second?.label, 'first');
    assert.equal(second?.nested?.deep, 'value');
  });

  suite('an undefined field is not written rather than rejected', async ({ adapter, scope }) => {
    const path = `contract/${scope}/rows/a`;
    await adapter.set(path, { id: 'a', n: 1, label: 'first', absent: undefined });
    const stored = await adapter.get<Record<string, unknown>>(path);
    assert.equal(stored?.label, 'first');
    assert.equal('absent' in (stored ?? {}), false);
  });

  suite('a collection lists, filters, orders and limits', async ({ adapter, scope }) => {
    const collection = `contract/${scope}/rows`;
    for (const [id, n] of [['a', 3], ['b', 1], ['c', 2]] as const) {
      await adapter.set<Row>(`${collection}/${id}`, { id, n, label: `row-${id}` });
    }
    assert.deepEqual((await adapter.list<Row>(collection)).map((row) => row.id), ['a', 'b', 'c']);
    assert.deepEqual(
      (await adapter.list<Row>(collection, { orderBy: { field: 'n' } })).map((row) => row.data.n),
      [1, 2, 3],
    );
    assert.deepEqual(
      (await adapter.list<Row>(collection, { orderBy: { field: 'n', direction: 'desc' } })).map((row) => row.data.n),
      [3, 2, 1],
    );
    assert.deepEqual(
      (await adapter.list<Row>(collection, { where: [['n', '>=', 2]], orderBy: { field: 'n' } })).map((row) => row.id),
      ['c', 'a'],
    );
    assert.equal((await adapter.list<Row>(collection, { limit: 2 })).length, 2);
    assert.deepEqual(
      (await adapter.list<Row>(collection, { where: [['label', '==', 'row-b']] })).map((row) => row.id),
      ['b'],
    );
  });

  suite('a collection group reads the same collection name under different parents', async ({ adapter, scope }) => {
    await adapter.set<Row>(`contract/${scope}/rows/a`, { id: 'a', n: 1, label: 'one' });
    await adapter.set<Row>(`contract/${scope}-other/rows/b`, { id: 'b', n: 2, label: 'two' });
    const group = (await adapter.listGroup<Row>('rows')).filter((row) => row.path.includes(scope));
    assert.deepEqual(group.map((row) => row.id).sort(), ['a', 'b']);
    assert.ok(group.every((row) => row.path.endsWith(`rows/${row.id}`)));
  });

  suite('a delete removes the document and is idempotent', async ({ adapter, scope }) => {
    const path = `contract/${scope}/rows/a`;
    await adapter.set<Row>(path, { id: 'a', n: 1, label: 'first' });
    await adapter.delete(path);
    assert.equal(await adapter.get(path), null);
    await adapter.delete(path);
    assert.equal(await adapter.get(path), null);
  });

  suite('deleteTree removes the document and everything beneath it, and counts', async ({ adapter, scope }) => {
    const root = `contract/${scope}`;
    await adapter.set(root, { id: scope, n: 0, label: 'root' });
    await adapter.set(`${root}/rows/a`, { id: 'a', n: 1, label: 'one' });
    await adapter.set(`${root}/rows/b`, { id: 'b', n: 2, label: 'two' });
    await adapter.set(`${root}/rows/b/deeper/c`, { id: 'c', n: 3, label: 'three' });

    const deleted = await adapter.deleteTree(root);
    assert.equal(deleted, 4);
    assert.equal(await adapter.get(root), null);
    assert.equal(await adapter.get(`${root}/rows/a`), null);
    assert.equal(await adapter.get(`${root}/rows/b/deeper/c`), null);
    assert.deepEqual(await adapter.list(`${root}/rows`), []);
  });

  suite('a transaction commits a read-modify-write', async ({ adapter, scope }) => {
    const path = `contract/${scope}/rows/a`;
    await adapter.set<Row>(path, { id: 'a', n: 1, label: 'first' });
    const returned = await adapter.runTransaction(async (tx) => {
      const current = await tx.get<Row>(path);
      tx.set<Row>(path, { ...(current as Row), n: (current?.n ?? 0) + 1 });
      return current?.n ?? 0;
    });
    assert.equal(returned, 1);
    assert.equal((await adapter.get<Row>(path))?.n, 2);
  });

  suite('a transaction merges into an existing document without erasing it', async ({ adapter, scope }) => {
    const path = `contract/${scope}/rows/a`;
    await adapter.set<Row>(path, { id: 'a', n: 1, label: 'first' });
    await adapter.runTransaction(async (tx) => {
      tx.merge<Row>(path, { n: 9 });
    });
    assert.deepEqual(await adapter.get<Row>(path), { id: 'a', n: 9, label: 'first' });
  });

  suite('a transaction merge creates the document when it is absent', async ({ adapter, scope }) => {
    const path = `contract/${scope}/rows/new`;
    await adapter.runTransaction(async (tx) => {
      tx.merge<Row>(path, { n: 4 });
    });
    assert.equal((await adapter.get<Row>(path))?.n, 4);
  });

  suite('create refuses a document that already exists', async ({ adapter, scope }) => {
    const path = `contract/${scope}/rows/a`;
    await adapter.set<Row>(path, { id: 'a', n: 1, label: 'first' });
    await assert.rejects(
      adapter.runTransaction(async (tx) => {
        tx.create<Row>(path, { id: 'a', n: 2, label: 'second' });
      }),
    );
    assert.equal((await adapter.get<Row>(path))?.n, 1);
  });

  suite('a transaction that throws writes nothing', async ({ adapter, scope }) => {
    const path = `contract/${scope}/rows/a`;
    await assert.rejects(
      adapter.runTransaction(async (tx) => {
        tx.set<Row>(path, { id: 'a', n: 1, label: 'first' });
        throw new Error('deliberate');
      }),
      /deliberate/,
    );
    assert.equal(await adapter.get(path), null);
  });

  // Firestore refuses a read issued after a write in the same transaction. If
  // only one adapter enforced it, code that passes `npm test` would fail in
  // production on the first contended write.
  suite('a get after a write in one transaction throws StorageUsageError', async ({ adapter, scope }) => {
    await assert.rejects(
      adapter.runTransaction(async (tx) => {
        tx.set<Row>(`contract/${scope}/rows/a`, { id: 'a', n: 1, label: 'first' });
        await tx.get(`contract/${scope}/rows/b`);
      }),
      (error: unknown) => error instanceof StorageUsageError,
    );
  });

  suite('a list after a write in one transaction throws StorageUsageError', async ({ adapter, scope }) => {
    await assert.rejects(
      adapter.runTransaction(async (tx) => {
        tx.set<Row>(`contract/${scope}/rows/a`, { id: 'a', n: 1, label: 'first' });
        await tx.list(`contract/${scope}/rows`);
      }),
      (error: unknown) => error instanceof StorageUsageError,
    );
  });

  suite('a listGroup after a write in one transaction throws StorageUsageError', async ({ adapter, scope }) => {
    await assert.rejects(
      adapter.runTransaction(async (tx) => {
        tx.delete(`contract/${scope}/rows/a`);
        await tx.listGroup('rows');
      }),
      (error: unknown) => error instanceof StorageUsageError,
    );
  });

  suite('concurrent read-modify-write transactions do not lose an update', async ({ adapter, scope }) => {
    const path = `contract/${scope}/counters/c`;
    await adapter.set(path, { n: 0 });
    await Promise.all(
      Array.from({ length: 5 }, () =>
        adapter.runTransaction(async (tx) => {
          const current = await tx.get<{ n: number }>(path);
          tx.set(path, { n: (current?.n ?? 0) + 1 });
        }),
      ),
    );
    assert.equal((await adapter.get<{ n: number }>(path))?.n, 5);
  });

  suite('a document path with an odd number of segments is refused', async ({ adapter, scope }) => {
    await assert.rejects(adapter.get(`contract/${scope}/rows`), /document path/);
    await assert.rejects(adapter.list(`contract/${scope}/rows/a`), /collection path/);
  });
}
