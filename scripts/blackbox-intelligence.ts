/** Real-model synthetic staging probe. Run only against an in-memory account. */
import assert from 'node:assert/strict';
import { createMemoryStorage, resetStorageForTests, setStorageForTests } from '../lib/storage/index';
import { analyzeSource } from '../lib/intelligence/analyzeSource';
import { proposeFromObservations } from '../lib/intelligence/proposalEngine';
import { reviewSuggestion } from '../lib/intelligence/reviewSuggestion';
import { loadDomainState } from '../lib/services/mobile/participantState';
import { listObservations } from '../lib/intelligence/observationStore';
import { previewSuggestionSchedule } from '../lib/intelligence/schedulePreview';

async function main(): Promise<void> {
  const uid = 'BlackboxSyntheticAccount';
  const now = '2026-09-30T10:00:00.000Z';
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
  const sources = [
    ['manual', 'exam-note', 'عندي امتحان بكرة الساعة 9 الصبح، وعندي سهرة مع صحابي الليلة. مش متأكد إذا حضرت منيح.'],
    ['manual', 'pilates-note', 'حابب ألاقي وقت أكثر أتدرب فيه بيلاتيس مرتين بالأسبوع.'],
    ['manual', 'react-note', 'حابب أتعلم React خلال الشهرين الجايين.'],
    ['gmail', 'synthetic-job-mail', 'Thank you for applying. Please complete your job application at the registration link by Friday.'],
  ] as const;
  const counts: Record<string, number> = {};
  for (const [source, ref, content] of sources) {
    const found = await analyzeSource(uid, source, ref, content, now, { storage });
    counts[ref] = found.length;
  }
  const suggestions = await proposeFromObservations(uid, now, { storage });
  const schedule = await previewSuggestionSchedule(uid, suggestions, now, storage);
  assert.ok(schedule.every(item => !item.slot || Date.parse(item.slot.startsAt) >= Date.parse(now)),
    'a suggested slot must not be in the past');
  const observations = await listObservations(uid, storage);
  const examId = observations.find(item => item.evidence.includes('امتحان'))?.id;
  const partyId = observations.find(item => item.evidence.includes('سهرة'))?.id;
  const requestId = observations.find(item => item.kind === 'request' && item.source === 'gmail')?.id;
  const tradeoff = suggestions.some(item => (item.kind === 'question' || item.kind === 'warning')
    && Boolean(examId && partyId && item.observationIds.includes(examId) && item.observationIds.includes(partyId)));
  const examPreparation = suggestions.some(item => item.kind === 'action' && Boolean(examId && item.observationIds.includes(examId)));
  const faithfulFollowup = suggestions.some(item => item.kind === 'action' && Boolean(requestId && item.observationIds.includes(requestId))
    && /complete your job application/i.test(item.title));
  assert.equal(Object.keys((await loadDomainState(storage, uid)).commitments).length, 0,
    'generation must not create work');
  const action = suggestions.find(item => item.kind === 'action');
  if (action) {
    await reviewSuggestion(uid, action.id, 'accept', now, storage);
    assert.equal(Object.keys((await loadDomainState(storage, uid)).commitments).length, 1,
      'one explicit accept must create one action');
  }
  // No personal data: these are synthetic strings fixed in this probe.
  process.stdout.write(`${JSON.stringify({ counts, tradeoff, examPreparation, faithfulFollowup, schedule: schedule.map(item => ({
    title: suggestions.find(suggestion => suggestion.id === item.suggestionId)?.title,
    startsAt: item.slot?.startsAt ?? null, reason: item.reason,
  })), observations: observations.map(item => ({ kind: item.kind, evidence: item.evidence })),
    suggestions: suggestions.map(item => ({
    kind: item.kind, title: item.title, reason: item.reason,
  })), acceptedAction: Boolean(action) }, null, 2)}\n`);
  assert.equal(tradeoff, true, 'the exam and party must be considered together');
  assert.equal(examPreparation, true, 'an important near-term event must produce a preparation step');
  assert.equal(faithfulFollowup, true, 'the job follow-up must preserve the external request');
  } finally {
    resetStorageForTests();
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'blackbox_failed'}\n`);
  process.exitCode = 1;
});
