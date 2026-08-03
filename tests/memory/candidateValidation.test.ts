import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMemoryCandidate, validateMemoryCandidateResult } from '../../src/extraction/memoryCandidateSchema.ts';

test('validation: valid candidate passes', () => {
  const result = validateMemoryCandidate({
    candidateType: 'commitment',
    normalizedText: 'visit uncle',
    modality: 'possible',
    confidence: 0.74,
    temporal: { rawText: 'next week', precision: 'day' },
    evidenceSpan: { start: 0, end: 20, text: 'maybe visit uncle' },
  });
  assert.ok(result);
  assert.equal(result.candidateType, 'commitment');
  assert.equal(result.modality, 'possible');
});

test('validation: invalid candidateType → null', () => {
  const result = validateMemoryCandidate({
    candidateType: 'invalid',
    normalizedText: 'test',
    modality: 'possible',
    confidence: 0.5,
    evidenceSpan: { start: 0, end: 4, text: 'test' },
  });
  assert.equal(result, null);
});

test('validation: missing evidence span → null', () => {
  const result = validateMemoryCandidate({
    candidateType: 'commitment',
    normalizedText: 'test',
    modality: 'possible',
    confidence: 0.5,
  });
  assert.equal(result, null);
});

test('validation: confidence out of range → null', () => {
  assert.equal(validateMemoryCandidate({
    candidateType: 'commitment',
    normalizedText: 'test',
    modality: 'possible',
    confidence: 1.5,
    evidenceSpan: { start: 0, end: 4, text: 'test' },
  }), null);
  assert.equal(validateMemoryCandidate({
    candidateType: 'commitment',
    normalizedText: 'test',
    modality: 'possible',
    confidence: -0.1,
    evidenceSpan: { start: 0, end: 4, text: 'test' },
  }), null);
});

test('validation: empty normalizedText → null', () => {
  const result = validateMemoryCandidate({
    candidateType: 'commitment',
    normalizedText: '',
    modality: 'possible',
    confidence: 0.5,
    evidenceSpan: { start: 0, end: 0, text: '' },
  });
  assert.equal(result, null);
});

test('validation: valid result with multiple candidates', () => {
  const result = validateMemoryCandidateResult({
    candidates: [
      {
        candidateType: 'commitment',
        normalizedText: 'call doctor',
        modality: 'certain',
        confidence: 0.90,
        evidenceSpan: { start: 0, end: 11, text: 'call doctor' },
      },
      {
        candidateType: 'commitment',
        normalizedText: 'visit university',
        modality: 'intended',
        confidence: 0.78,
        evidenceSpan: { start: 15, end: 31, text: 'visit university' },
      },
    ],
    language: 'en',
  });
  assert.ok(result);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.language, 'en');
});

test('validation: result filters out invalid candidates', () => {
  const result = validateMemoryCandidateResult({
    candidates: [
      {
        candidateType: 'commitment',
        normalizedText: 'valid',
        modality: 'certain',
        confidence: 0.90,
        evidenceSpan: { start: 0, end: 5, text: 'valid' },
      },
      {
        candidateType: 'INVALID_TYPE',
        normalizedText: 'invalid',
        modality: 'certain',
        confidence: 0.90,
        evidenceSpan: { start: 6, end: 13, text: 'invalid' },
      },
    ],
    language: 'ar',
  });
  assert.ok(result);
  assert.equal(result.candidates.length, 1);
});

test('validation: null/undefined input → null', () => {
  assert.equal(validateMemoryCandidate(null), null);
  assert.equal(validateMemoryCandidate(undefined), null);
  assert.equal(validateMemoryCandidateResult(null), null);
});
