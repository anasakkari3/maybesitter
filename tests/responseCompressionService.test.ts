import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compressActions,
  compressInterpretation,
  compressResponse,
} from '../lib/services/responseCompressionService.ts';

test('responseCompressionService: legacy compression stays bounded and debug-only friendly', () => {
  const interpretation = compressInterpretation('Tracking call Maya. No changes made. One command was skipped safely.');
  const actions = compressActions([
    'Created a draft for "Call Maya".',
    'Confirmed the commitment and scheduled a reminder.',
    'Marked the commitment complete.',
    'Postponed the commitment.',
  ]);

  assert.ok(interpretation.length < 90);
  assert.ok(actions.length <= 2);
  assert.ok(actions.every((action) => action.length < 90));
});

test('responseCompressionService: preserves the V3 message while compressing legacy compatibility fields', () => {
  const response = compressResponse({
    message: 'I will keep that as context, not a task.',
    interpretation: 'Noted: Maya is waiting on the invoice. No changes made.',
    actions: [
      'Marked the reminder as acknowledged.',
      'Marked the commitment complete.',
      'Postponed the commitment.',
    ],
    nextStep: { type: 'review', message: 'I need one clearer detail before changing anything. Please review before I change anything.' },
  });

  assert.equal(response.message, 'I will keep that as context, not a task.');
  assert.ok(response.actions.length <= 2);
  assert.equal(response.nextStep.type, 'review');
});
