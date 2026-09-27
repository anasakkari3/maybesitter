/**
 * The CL1 capture probe harness, kept (review of PR #678).
 *
 * 138 probes the reviewer ran before and after the part-of-day and day-word
 * boundary work: 116 on the rules path, 16 on the model path with a scripted
 * answer, and 6 typed answers to "when?". Each row pins what the capture
 * gives now. A row that changed from e26da115 carries that older answer
 * (`atE26da115`) — every one an intended fix — so a later change that moves
 * any row back, or anywhere else, fails here and has to say why.
 *
 * Deterministic: no model is called, the reference time is fixed, and
 * storage is in memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { clarifyMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import {
  MemoryCaptureProposalStore,
  proposeCapture,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';

interface Outcome { status: string; items: string[] }
interface Row { text: string; model?: string; modelTitle?: string; expected: Outcome; atE26da115?: Outcome }
interface Probes {
  rules: Row[];
  model: Row[];
  clarify: { text: string; answers: Array<{ answer: string; expected: string; atE26da115?: string }> };
}

const PROBES = JSON.parse(
  readFileSync(new URL('./fixtures/cl1-capture-probes.json', import.meta.url), 'utf8'),
) as Probes;

const TZ = 'Asia/Jerusalem';
const NOW = new Date('2026-09-26T07:00:00.000Z');

const timeOf = (iso: string | null | undefined) => (iso ? localTimeSpecFor(new Date(iso), TZ)?.time ?? '-' : '-');

type Item = { title: string; resolvedDate?: string; resolvedTime: string | null; clarification?: { questionKey?: string } | null };
const line = (item: Item) =>
  `${item.title} | ${item.resolvedDate ?? '-'} ${timeOf(item.resolvedTime)} | ${item.clarification?.questionKey ?? ''}`;

async function withStorage<T>(run: () => Promise<T>): Promise<T> {
  setStorageForTests(createMemoryStorage());
  try {
    return await run();
  } finally {
    resetStorageForTests();
  }
}

test('the harness still has all 138 probes', () => {
  assert.equal(PROBES.rules.length + PROBES.model.length + PROBES.clarify.answers.length, 138);
});

test('rules path: every probe gives what it gives now', async () => {
  const drift: string[] = [];
  for (const row of PROBES.rules) {
    const proposal = await withStorage(() =>
      proposeMobileCapture({ text: row.text, timezone: TZ, referenceTime: NOW.toISOString() }));
    const actual = { status: proposal.status, items: proposal.items.map(line) };
    try {
      assert.deepEqual(actual, row.expected);
    } catch {
      drift.push(`${row.text}\n   expected ${JSON.stringify(row.expected)}\n   actual   ${JSON.stringify(actual)}`);
    }
  }
  assert.deepEqual(drift, []);
});

test('model path: every probe keeps or strips the scripted answer as it does now', async () => {
  const drift: string[] = [];
  for (const row of PROBES.model) {
    const [date, time] = row.model!.split(' ');
    const title = row.modelTitle!;
    const answer = {
      type: 'task', action: title, title, person: null,
      dueAt: new Date(`${date}T${time}:00+03:00`).toISOString(), remindAt: null,
      localTimeSpec: { date, time, timezone: TZ },
      priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
      flexibility: 'movable', category: null, categoryConfidence: 0,
      confidence: { overall: 0.9, type: 1, action: 0.9, time: 0.9, priority: 1 },
      missingFields: [], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
    };
    const provider = async (prompt: string): Promise<string> => {
      const lines = prompt.split('\n');
      const payload = JSON.parse(lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1]!) as string | string[];
      return Array.isArray(payload)
        ? JSON.stringify({ items: payload.map((_, clauseIndex) => ({ clauseIndex, ...answer })) })
        : JSON.stringify(answer);
    };
    const contract = await proposeCapture(row.text, { now: NOW, timezone: TZ, scopeId: 'probe', requestedEngine: 'model' }, {
      store: new MemoryCaptureProposalStore(),
      persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
      llmProvider: provider,
      llmEngine: 'gemini',
    });
    const actual = { status: contract.status, items: contract.items.map(line) };
    try {
      assert.deepEqual(actual, row.expected);
    } catch {
      drift.push(`${row.text} [model ${row.model}]\n   expected ${JSON.stringify(row.expected)}\n   actual   ${JSON.stringify(actual)}`);
    }
  }
  assert.deepEqual(drift, []);
});

test('clarify: every typed answer to "when?" gives what it gives now', async () => {
  const drift: string[] = [];
  for (const { answer, expected } of PROBES.clarify.answers) {
    const actual = await withStorage(async () => {
      const proposal = await proposeMobileCapture({ text: PROBES.clarify.text, timezone: TZ, referenceTime: NOW.toISOString(), scopeId: 's' });
      const item = proposal.items[0]!;
      try {
        const updated = await clarifyMobileCapture({
          proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId,
          freeText: answer, timezone: TZ, referenceTime: NOW.toISOString(), scopeId: 's',
        });
        const answered = updated.items.find((candidate) => candidate.itemId === item.itemId)!;
        return `${answered.resolvedDate ?? '-'} ${timeOf(answered.resolvedTime)} needs=${answered.needsClarification} q=${answered.clarification?.questionKey ?? ''}`;
      } catch (error) {
        return `ERR ${(error as { code?: string }).code ?? ''}`;
      }
    });
    if (actual !== expected) drift.push(`${answer}: expected ${expected}, actual ${actual}`);
  }
  assert.deepEqual(drift, []);
});
