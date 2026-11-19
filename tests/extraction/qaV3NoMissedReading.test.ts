/**
 * Review of #872, round 5: the deterministic missed-thing reading is gone
 * (coordinator decision: its fallback was met — every narrowing still made
 * cards of regret, a second subject, a thing done in the same sentence, a
 * past event). A thing the person was to do and did not (V3-F04-03) is now
 * the model's to read, by the capture-chat prompt; the code does not
 * guarantee it.
 *
 * Held here: 60 of the reviewer's sentences are read exactly as origin/main
 * read them — on the rules, and with a model that answered nothing — so the
 * branch makes no card main did not.
 *
 * Synthetic text only. No model is called: the "model" is a scripted provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { MemoryCaptureProposalStore, proposeCapture } from '../../lib/services/captureBoundary/index.ts';
import { TransactionalCapturePersistenceAdapter } from '../../lib/services/captureBoundary/persistenceAdapter.ts';
import { guardedMobileExtract } from '../../lib/services/mobile/safety.ts';

const NOW = new Date('2026-11-19T05:12:00.000Z');
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/qaV3NoMissedReading.json', import.meta.url), 'utf8')) as {
  sentences: Record<string, { rules: string; modelNothing: string }>;
};

const nothing = async () => JSON.stringify({
  type: 'unknown', action: null, title: null, person: null, dueAt: null, remindAt: null, localTimeSpec: null,
  priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false }, flexibility: 'movable',
  category: null, categoryConfidence: 0, confidence: { overall: 0.9, type: 0.9, action: 0.9, time: 0.9, priority: 1 },
  missingFields: [], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
});

/** What a capture proposes, as one line: status, reason, and each item's title, day, hour and question. */
async function readAs(text: string, model: boolean): Promise<string> {
  const contract = await proposeCapture(
    text,
    { now: NOW, timezone: 'Asia/Jerusalem', scopeId: 's', requestedEngine: model ? 'model' : 'rules' },
    {
      store: new MemoryCaptureProposalStore(),
      persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
      extractor: guardedMobileExtract,
      ...(model ? { llmProvider: nothing, llmEngine: 'gemini' as const } : {}),
    },
  );
  const reason = (contract as { noCommitmentReason?: string }).noCommitmentReason;
  const items = contract.items.map((item) => `${item.title}|${item.resolvedDate ?? '-'}|${item.resolvedTime ?? '-'}|${item.clarification?.questionKey ?? '-'}`);
  return `${contract.status}${reason ? `:${reason}` : ''} [${items.join(' ; ')}]`;
}

test('round 5: 60 of the reviewer\'s sentences are read as origin/main read them, on the rules', async () => {
  const differ: string[] = [];
  for (const [text, main] of Object.entries(FIXTURE.sentences)) {
    const now = await readAs(text, false);
    if (now !== main.rules) differ.push(`${text}\n  main: ${main.rules}\n  now:  ${now}`);
  }
  assert.deepEqual(differ, []);
});

test('round 5: with a model that answered nothing, those sentences make what main made — no card the model did not give', async () => {
  const differ: string[] = [];
  for (const [text, main] of Object.entries(FIXTURE.sentences)) {
    const now = await readAs(text, true);
    if (now !== main.modelNothing) differ.push(`${text}\n  main: ${main.modelNothing}\n  now:  ${now}`);
  }
  assert.deepEqual(differ, []);
});
