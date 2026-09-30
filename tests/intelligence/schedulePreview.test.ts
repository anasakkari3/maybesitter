import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { putObservations } from '../../lib/intelligence/observationStore.ts';
import { previewSuggestionSchedule } from '../../lib/intelligence/schedulePreview.ts';
import { suggestionPath, type IntelligenceSuggestion } from '../../lib/intelligence/proposalEngine.ts';
import { reviewSuggestion, SuggestionScheduleChangedError } from '../../lib/intelligence/reviewSuggestion.ts';
import { loadDomainState } from '../../lib/services/mobile/participantState.ts';

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

test('accepting the shown slot pins the task; a changed slot is refused', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    const now = '2026-09-30T10:00:00.000Z';
    const [exam] = await putObservations('alice', 'manual', 'exam', now,
      [{ kind: 'event', evidence: 'Exam tomorrow', confidence: 1 }], storage);
    const action: IntelligenceSuggestion = {
      id: 'b'.repeat(64), kind: 'action', title: 'Review exam material',
      reason: 'Exam tomorrow', observationIds: [exam.id], confidence: 0.8,
      durationMinutes: 45, status: 'pending', decidedAt: null, linkedEntityId: null, generatedAt: now,
    };
    await storage.set(suggestionPath('alice', action.id), action);
    const [preview] = await previewSuggestionSchedule('alice', [action], now, storage);
    assert.ok(preview?.slot);
    await assert.rejects(() => reviewSuggestion('alice', action.id, 'accept', now, storage,
      { slot: { startsAt: new Date(Date.parse(preview.slot!.startsAt) + 60_000).toISOString(), endsAt: preview.slot!.endsAt } }),
    SuggestionScheduleChangedError);
    assert.equal(Object.keys((await loadDomainState(storage, 'alice')).commitments).length, 0);
    const accepted = await reviewSuggestion('alice', action.id, 'accept', now, storage, { slot: preview.slot });
    const commitment = (await loadDomainState(storage, 'alice')).commitments[accepted!.linkedEntityId!];
    assert.equal(commitment?.timeSpec.kind, 'due_by');
    assert.equal(commitment?.timeSpec.dueAt, preview.slot.startsAt);
    assert.equal(commitment?.timeSpec.endAt, preview.slot.endsAt);
  } finally { resetStorageForTests(); }
});
