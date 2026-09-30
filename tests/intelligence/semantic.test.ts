import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticFallback, validateSemanticObservations } from '../../lib/intelligence/semantic.ts';

test('keeps different observations from one source, only with exact evidence', () => {
  const source = 'I want to learn React. My exam is Friday. Complete registration for the job.';
  assert.deepEqual(validateSemanticObservations({ observations: [
    { kind: 'goal', evidence: 'I want to learn React', confidence: 0.9 },
    { kind: 'event', evidence: 'My exam is Friday', confidence: 0.8 },
    { kind: 'request', evidence: 'Complete registration for the job', confidence: 0.9 },
    { kind: 'outcome', evidence: 'I failed the exam', confidence: 0.99 },
  ] }, source).map(item => item.kind), ['goal', 'event', 'request']);
});

test('fallback preserves a goal or request without inventing a task', () => {
  assert.equal(semanticFallback('حابب الاقي وقت اتدرب بيلاتيس')[0]?.kind, 'goal');
  assert.equal(semanticFallback('Complete registration for your application')[0]?.kind, 'request');
});
