/**
 * Where the model's guess meets the user's own choice of categories (#415).
 *
 * `resolveCategory` holds the policy and `categoryContracts.test.ts` proves it.
 * What these cases prove is that the mapper *asks* — the bug this guards is not
 * a wrong floor, it is a mapper that copies `result.category` straight onto the
 * commitment and never consults the preference at all. That bug is invisible in
 * every other test, because the default preference enables everything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mapExtractionToCommand } from '../../src/extraction/mapExtractionToCommand.ts';
import type { ExtractionResult } from '../../src/extraction/extractionTypes.ts';
import {
  CATEGORY_CONFIDENCE_FLOOR,
  normalizeCategoryPreferences,
} from '../../src/contracts/v1/categoryContracts.ts';

const NOW = '2026-04-08T08:00:00.000Z';

function extracted(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    type: 'task',
    action: 'send the invoice',
    title: 'Send the invoice',
    person: null,
    dueAt: '2026-04-08T18:00:00.000Z',
    remindAt: '2026-04-08T17:00:00.000Z',
    localTimeSpec: null,
    timeEvidence: 'hhmm',
    priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    category: 'work',
    categoryConfidence: 0.95,
    confidence: { overall: 0.9, type: 0.9, action: 0.9, time: 0.9, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
    rawText: 'Send the invoice at 6',
    parserVersion: 'capture-v2',
    ...overrides,
  };
}

function draftIn(commands: ReturnType<typeof mapExtractionToCommand>) {
  const draft = commands.find((command) => command.type === 'CreateDraft');
  assert.ok(draft, 'the extraction must produce a draft');
  return draft as Extract<typeof draft, { type: 'CreateDraft' }>;
}

test('a confident category from a category the user uses reaches the commitment', () => {
  const commands = mapExtractionToCommand(extracted(), NOW);
  assert.equal(draftIn(commands).commitment.category, 'work');
});

test('a category the user turned off does not reach the commitment', () => {
  const preferences = normalizeCategoryPreferences({ enabled: ['family'], grouping: true });
  const commands = mapExtractionToCommand(extracted(), NOW, preferences);
  assert.equal(draftIn(commands).commitment.category, null);
});

test('a guess the model was not sure of does not reach the commitment', () => {
  const commands = mapExtractionToCommand(
    extracted({ categoryConfidence: CATEGORY_CONFIDENCE_FLOOR - 0.01 }),
    NOW,
  );
  assert.equal(draftIn(commands).commitment.category, null);
});

test('an extraction that read no category produces an uncategorised commitment', () => {
  const commands = mapExtractionToCommand(extracted({ category: null, categoryConfidence: 0 }), NOW);
  assert.equal(draftIn(commands).commitment.category, null);
});

test('a user who turned every category off never gets one filled in', () => {
  const preferences = normalizeCategoryPreferences({ enabled: [], grouping: false });
  const commands = mapExtractionToCommand(extracted(), NOW, preferences);
  assert.equal(draftIn(commands).commitment.category, null);
});
