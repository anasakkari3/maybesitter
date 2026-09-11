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
    // A probe response is public, so assert the whole body rather than a few
    // fields: this proves nothing else is in it — no host, no project id, no
    // error text — which a substring check could never establish.
    assert.deepEqual(await response.json(), { ready: false, reason: 'storage_unavailable' });
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
