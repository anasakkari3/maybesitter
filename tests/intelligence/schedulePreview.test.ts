import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage } from '../../lib/storage/index.ts';
import { putObservations } from '../../lib/intelligence/observationStore.ts';
import { previewSuggestionSchedule } from '../../lib/intelligence/schedulePreview.ts';
import type { IntelligenceSuggestion } from '../../lib/intelligence/proposalEngine.ts';

test('a proposed action is never previewed in time already gone', async () => {
  const storage = createMemoryStorage();
  const now = '2026-09-30T10:00:00.000Z';
  const [exam] = await putObservations('alice', 'manual', 'exam', now,
    [{ kind: 'event', evidence: 'Exam tomorrow', confidence: 1 }], storage);
  const action: IntelligenceSuggestion = {
    id: 'a'.repeat(64), kind: 'action', title: 'Review the exam material',
    reason: 'Exam tomorrow', observationIds: [exam.id], confidence: 0.8,
    durationMinutes: 45, status: 'pending', decidedAt: null, linkedEntityId: null, generatedAt: now,
  };
  const [preview] = await previewSuggestionSchedule('alice', [action], now, storage);
  assert.ok(preview?.slot, 'the synthetic day should have available time');
  assert.ok(Date.parse(preview.slot.startsAt) >= Date.parse(now));
});
