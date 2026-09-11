import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../../src/app/api/health/ready/route';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage';
import type { StorageAdapter } from '../../lib/storage/storageAdapter';

// Cloud Run's startup probe points at this route. If it reports ready while
// storage is unreachable, the deploy sends traffic to a service that answers
// requests by losing data — so the failing case matters more than the happy one.

test('ready when storage answers', async () => {
  setStorageForTests(createMemoryStorage());
  try {
    const response = await GET();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ready: true });
  } finally {
    resetStorageForTests();
  }
});

test('503 with a coarse reason when storage is unreachable', async () => {
  const broken = {
    get: async () => {
      throw new Error('connection refused to firestore.googleapis.com:443 (project maybesitter-app)');
    },
  } as unknown as StorageAdapter;
  setStorageForTests(broken);
  try {
    const response = await GET();
    assert.equal(response.status, 503);
    const body = (await response.json()) as { ready: boolean; reason: string };
    assert.equal(body.ready, false);
    assert.equal(body.reason, 'storage_unavailable');
    // A probe response is public: it must not leak the project, the host, or
    // the underlying error text.
    assert.equal(JSON.stringify(body).includes('firestore.googleapis.com'), false);
    assert.equal(JSON.stringify(body).includes('maybesitter-app'), false);
  } finally {
    resetStorageForTests();
  }
});

test('503 rather than hanging when storage never answers', async () => {
  const hanging = {
    get: () => new Promise(() => {}),
  } as unknown as StorageAdapter;
  setStorageForTests(hanging);
  try {
    const started = Date.now();
    const response = await GET();
    assert.equal(response.status, 503);
    // The probe runs every few seconds; it has to give up quickly.
    assert.ok(Date.now() - started < 5_000, 'the probe should time out in about two seconds');
  } finally {
    resetStorageForTests();
  }
});
