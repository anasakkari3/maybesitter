import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CAPTURE_EDIT_TITLE_MAX, CAPTURE_EDIT_TITLE_MIN } from '../../src/contracts/v1/captureContracts.ts';

/**
 * The app's title cap and the contract's are the same number (#351, from #164).
 *
 * They were not. `MAX_TITLE_LENGTH` was 200 with a comment saying it was "the
 * longest title the commitment validator accepts", while
 * `CAPTURE_EDIT_TITLE_MAX` has always been 120 and `applyEdits.ts` has always
 * refused more.
 *
 * What made it worth a test rather than a one-line fix: an invalid edit fails
 * the *whole* confirm, not the item that carries it. So the failure reached
 * items the person never edited, wearing a generic error that named no field.
 * A number duplicated across a boundary drifts; this is the thing that notices.
 *
 * Read as text, not imported. `captureMachine.ts` is a React Native module —
 * pulling it into the Node suite would drag in the whole app graph to check one
 * integer, and the integer is what matters.
 */
const source = readFileSync(
  join(import.meta.dirname, '..', '..', 'mobile', 'src', 'features', 'capture', 'captureMachine.ts'),
  'utf8',
);

function constant(name: string): number {
  const match = source.match(new RegExp(`export const ${name} = (\\d+);`));
  assert.ok(match, `${name} is not declared as a plain integer in captureMachine.ts`);
  return Number(match[1]);
}

test('the app stops typing at exactly the length the confirm accepts', () => {
  assert.equal(constant('MAX_TITLE_LENGTH'), CAPTURE_EDIT_TITLE_MAX);
});

test('the contract bounds are still the shape this test assumes', () => {
  // If the contract ever grows a range or a computed bound, the assertion above
  // becomes meaningless without saying so. This is what says so.
  assert.equal(typeof CAPTURE_EDIT_TITLE_MAX, 'number');
  assert.ok(CAPTURE_EDIT_TITLE_MAX > CAPTURE_EDIT_TITLE_MIN);
  assert.equal(CAPTURE_EDIT_TITLE_MIN, 1);
});

test('the capture length cap is not accidentally tied to the title cap', () => {
  // Different limits for different reasons: the capture body is what the
  // extractor reads, the title is one field of one commitment. They were both
  // edited in the same commit once; this keeps that from reading as intent.
  const capture = constant('MAX_CAPTURE_LENGTH');
  assert.notEqual(capture, CAPTURE_EDIT_TITLE_MAX);
  assert.ok(capture > CAPTURE_EDIT_TITLE_MAX);
});
