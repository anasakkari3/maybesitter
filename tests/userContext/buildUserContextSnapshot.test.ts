import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_RECORD_SCHEMA_VERSION, type RuntimeMemoryRecord } from '../../src/contracts/v1/memoryContracts.ts';
import type { Commitment } from '../../src/domain/stateMachine.ts';
import type { BusyBlock } from '../../lib/calendar/busyBlocks.ts';
import {
  buildUserContextSnapshot,
  toUserContextModelPayload,
  type BuildUserContextSnapshotInput,
} from '../../lib/userContext/buildUserContextSnapshot.ts';
import { CONTEXT_ENRICHMENT_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';

const NOW = '2026-09-29T12:00:00.000Z';
const ALL_SOURCES = ['memory', 'goal', 'commitment', 'calendar_busy', 'gmail', 'drive', 'share'] as const;

function memory(overrides: Partial<RuntimeMemoryRecord> = {}): RuntimeMemoryRecord {
  return {
    version: MEMORY_RECORD_SCHEMA_VERSION,
    id: 'memory-1',
    scopeId: 'user-a',
    kind: 'preference',
    content: 'بفضّل المهمات القصيرة بعد القهوة',
    language: 'ar',
    source: 'user_stated',
    confidence: 1,
    exportPolicy: 'personal_never_export',
    status: 'active',
    createdAt: '2026-09-20T08:00:00.000Z',
    updatedAt: '2026-09-20T08:00:00.000Z',
    observedAt: '2026-09-20T08:00:00.000Z',
    staleAfter: '2036-09-20T08:00:00.000Z',
    evidenceIds: ['private-evidence-id'],
    provenance: { origin: 'manual', originRef: 'private-origin-ref' },
    ...overrides,
  };
}

function commitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: 'commitment-1',
    kind: 'task',
    title: 'جهّز العرض',
    description: 'private description',
    person: 'private person',
    status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    category: 'work',
    categorySource: 'user_explicit',
    timeSpec: {
      kind: 'due_by',
      dueAt: '2026-09-30T09:00:00.000Z',
      endAt: null,
      remindAt: '2026-09-30T08:30:00.000Z',
      allDay: false,
      timezone: 'Asia/Hebron',
    },
    locationTrigger: { kind: 'arrive', label: 'private location', latitude: 31.9, longitude: 35.2, radiusMeters: 100 },
    currentAckState: 'aware',
    postponedUntil: null,
    createdAt: '2026-09-25T08:00:00.000Z',
    updatedAt: '2026-09-28T08:00:00.000Z',
    confirmedAt: '2026-09-25T08:01:00.000Z',
    completedAt: null,
    droppedAt: null,
    ...overrides,
  } as Commitment;
}

function busy(overrides: Partial<BusyBlock> = {}): BusyBlock {
  return {
    blockId: 'private-block-id',
    sourceId: 'private-calendar-id',
    sourceKind: 'google',
    startAt: '2026-09-30T10:00:00.000Z',
    endAt: '2026-09-30T11:00:00.000Z',
    allDay: false,
    ...overrides,
  };
}

function baseInput(): BuildUserContextSnapshotInput {
  return {
    scopeId: 'user-a',
    purpose: 'recommendation',
    computedAt: NOW,
    timezone: 'Asia/Hebron',
    window: { startAt: NOW, endAt: '2026-10-06T12:00:00.000Z' },
    consent: {
      state: 'granted',
      version: CONTEXT_ENRICHMENT_CONSENT_VERSION,
      changedAt: '2026-09-29T11:59:00.000Z',
      allowedSources: ALL_SOURCES,
    },
    memories: {
      scopeId: 'user-a',
      updatedAt: '2026-09-29T11:00:00.000Z',
      validThrough: null,
      items: [
        memory(),
        memory({ id: 'goal-1', kind: 'goal', content: 'إنهاء البحث', observedAt: '2026-09-21T08:00:00.000Z' }),
        memory({ id: 'expired', staleAfter: NOW }),
        memory({
          id: 'unconfirmed-model',
          source: 'model_inferred',
          provenance: { origin: 'capture', model: 'private-model', promptVersion: 'private-prompt' },
        }),
        memory({ id: 'revoked', status: 'revoked' }),
      ],
    },
    commitments: {
      scopeId: 'user-a',
      updatedAt: '2026-09-29T10:00:00.000Z',
      validThrough: null,
      items: [
        commitment(),
        commitment({ id: 'draft', status: 'draft', confirmedAt: null }),
        commitment({ id: 'done', status: 'completed', completedAt: '2026-09-28T09:00:00.000Z' }),
      ],
    },
    busyBlocks: {
      scopeId: 'user-a',
      updatedAt: '2026-09-29T10:30:00.000Z',
      validThrough: '2026-10-06T12:00:00.000Z',
      items: [busy(), busy({ blockId: 'outside', startAt: '2026-10-07T10:00:00.000Z', endAt: '2026-10-07T11:00:00.000Z' })],
    },
    externalReferences: {
      scopeId: 'user-a',
      updatedAt: '2026-09-29T11:30:00.000Z',
      validThrough: '2026-09-29T12:05:00.000Z',
      items: [{
        sourceId: 'private-message-id',
        source: 'gmail',
        sourceDigest: 'a'.repeat(64),
        observedAt: '2026-09-29T11:30:00.000Z',
        validThrough: '2026-09-29T12:05:00.000Z',
      }],
    },
  };
}

test('builder selects only eligible context and emits no raw ids or forbidden fields', () => {
  const snapshot = buildUserContextSnapshot(baseInput());

  assert.equal(snapshot.memory.items.length, 1);
  assert.equal(snapshot.goals.items.length, 1);
  assert.equal(snapshot.commitments.items.length, 1);
  assert.equal(snapshot.busy.items.length, 1);
  assert.equal(snapshot.external.items.length, 1);
  assert.notEqual(snapshot.external.items[0]!.sourceDigest, 'a'.repeat(64));
  assert.match(snapshot.memory.items[0]!.provenance.ref, /^ctx_[a-f0-9]{32}$/);

  const payload = toUserContextModelPayload(snapshot);
  assert.equal('scopeId' in payload, false);
  assert.equal('consent' in payload, false);
  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    'user-a',
    'memory-1',
    'goal-1',
    'commitment-1',
    'private-evidence-id',
    'private-origin-ref',
    'private description',
    'private person',
    'private location',
    'private-block-id',
    'private-calendar-id',
    'private-message-id',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `payload leaked ${forbidden}`);
  }
});

test('builder is deterministic across input ordering without mutating inputs', () => {
  const input = baseInput();
  const before = structuredClone(input);
  const first = buildUserContextSnapshot(input);
  const reversed = {
    ...input,
    memories: input.memories && { ...input.memories, items: [...input.memories.items].reverse() },
    commitments: input.commitments && { ...input.commitments, items: [...input.commitments.items].reverse() },
    busyBlocks: input.busyBlocks && { ...input.busyBlocks, items: [...input.busyBlocks.items].reverse() },
  };
  const second = buildUserContextSnapshot(reversed);

  assert.deepEqual(input, before);
  assert.deepEqual(second, first);
  assert.equal(second.snapshotDigest, first.snapshotDigest);
});

test('purpose, freshness, scope and consent fail closed', () => {
  const capture = baseInput();
  const captureSnapshot = buildUserContextSnapshot({ ...capture, purpose: 'capture' });
  assert.equal(captureSnapshot.commitments.items.some((item) => item.status === 'draft'), true);

  assert.throws(
    () => buildUserContextSnapshot({ ...baseInput(), memories: { ...baseInput().memories!, scopeId: 'user-b' } }),
    /scope does not match/,
  );
  assert.throws(
    () => buildUserContextSnapshot({ ...baseInput(), consent: { ...baseInput().consent, allowedSources: ['memory'] } }),
    /not consented/,
  );
  assert.throws(
    () => buildUserContextSnapshot({ ...baseInput(), consent: { ...baseInput().consent, version: 'ai-consent-v1' as never } }),
    /current granted consent/,
  );

  const stale = baseInput();
  const snapshot = buildUserContextSnapshot({
    ...stale,
    busyBlocks: { ...stale.busyBlocks!, validThrough: NOW },
  });
  assert.equal(snapshot.busy.metadata.freshness, 'stale');
  assert.deepEqual(snapshot.busy.items, []);
});

test('opaque external references require a digest instead of accepting provider ids', () => {
  const input = baseInput();
  assert.throws(
    () => buildUserContextSnapshot({
      ...input,
      externalReferences: {
        ...input.externalReferences!,
        items: [{ ...input.externalReferences!.items[0]!, sourceDigest: 'gmail-message-123' }],
      },
    }),
    /SHA-256 hex digest/,
  );
});

test('all text and section sizes remain inside their deterministic caps', () => {
  const input = baseInput();
  const long = 'ش'.repeat(500);
  const snapshot = buildUserContextSnapshot({
    ...input,
    memories: {
      ...input.memories!,
      items: [
        ...Array.from({ length: 20 }, (_, index) => memory({ id: `memory-${index}`, content: long })),
        ...Array.from({ length: 12 }, (_, index) => memory({ id: `goal-${index}`, kind: 'goal', content: long })),
      ],
    },
    commitments: {
      ...input.commitments!,
      items: Array.from({ length: 24 }, (_, index) => commitment({ id: `commitment-${index}`, title: long })),
    },
  });

  assert.equal(snapshot.memory.items.length, 12);
  assert.equal(snapshot.goals.items.length, 8);
  assert.equal(snapshot.commitments.items.length, 16);
  assert.equal(snapshot.memory.metadata.omittedByLimit, 8);
  assert.equal(snapshot.goals.metadata.omittedByLimit, 4);
  assert.equal(snapshot.commitments.metadata.omittedByLimit, 8);
  const textCodePoints = [
    ...snapshot.memory.items.map((item) => item.content),
    ...snapshot.goals.items.map((item) => item.content),
    ...snapshot.commitments.items.map((item) => item.title),
  ].reduce((total, value) => total + Array.from(value).length, 0);
  assert.ok(textCodePoints <= 6000);
});
