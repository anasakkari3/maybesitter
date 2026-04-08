import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantCopy,
  getAssistantPersonality,
  isAssistantCopyAllowed,
} from '../lib/services/personalityService.ts';

test('personalityService: returns stable calm-firm low-verbosity style', () => {
  const first = getAssistantPersonality();
  const second = getAssistantPersonality();

  assert.deepEqual(first, {
    style: {
      verbosity: 'low',
      tone: 'calm_firm',
      questioningStyle: 'focused',
    },
  });
  assert.deepEqual(second, first);
});

test('personalityService: copy is concise and not system-like', () => {
  const copy = [
    assistantCopy('interpretation'),
    assistantCopy('context'),
    assistantCopy('no_change'),
    assistantCopy('no_action'),
    assistantCopy('action_done'),
    assistantCopy('clean_end'),
    assistantCopy('confirm'),
    assistantCopy('clarification_unresolved'),
    assistantCopy('review'),
  ];

  assert.ok(copy.every((line) => isAssistantCopyAllowed(line)));
  assert.ok(copy.every((line) => line.length <= 70));
  assert.ok(copy.every((line) => !/Sounds like you're planning to|Done\.|Nothing else needed|Nothing to act on yet/.test(line)));
  assert.equal(isAssistantCopyAllowed('Executed commands successfully.'), false);
  assert.equal(isAssistantCopyAllowed('Awesome, no worries!'), false);
});
