/**
 * The FX3 review's probe set, kept (obligation words and the month's end).
 *
 * 109 probes beside the CL1 harness (`cl1CaptureProbes.test.ts`): 81 on the
 * rules path through `proposeMobileCapture`, some at their own reference time
 * (the month's last day, the 1st at 00:30 local, February, December), and 28
 * on the model path with a scripted Gemini answer — a date, an hour and a
 * priority per row. Each row pins what the capture gives now; a row that
 * changed from cb9982b7 carries that older answer (`atCb9982b7`), every one an
 * intended change. A later change that moves any row fails here and has to say
 * why.
 *
 * Deterministic: no model is called, and storage is in memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import {
  MemoryCaptureProposalStore,
  proposeCapture,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';

interface Outcome { status: string; items: string[] }
interface ScriptedAnswer { date: string | null; time: string | null; level: string; source: string }
interface Row { text: string; referenceTime?: string; model?: ScriptedAnswer; expected: Outcome; atCb9982b7?: Outcome }

const PROBES = JSON.parse(
  readFileSync(new URL('./fixtures/fx3-capture-probes.json', import.meta.url), 'utf8'),
) as { rules: Row[]; model: Row[] };

const TZ = 'Asia/Jerusalem';
const NOW = '2026-09-26T07:00:00.000Z';

type Item = { title: string; resolvedDate?: string; resolvedTime: string | null; priority?: string; priorityEstimated?: boolean; clarification?: { questionKey?: string } | null };
const line = (item: Item) => {
  const time = item.resolvedTime ? localTimeSpecFor(new Date(item.resolvedTime), TZ)?.time : null;
  return `${item.title} | ${item.resolvedDate ?? '-'} ${time ?? '-'} | ${item.clarification?.questionKey ?? ''} | ${item.priority}${item.priorityEstimated ? '~' : ''}`;
};

test('the FX3 harness still has all 109 probes', () => {
  assert.equal(PROBES.rules.length + PROBES.model.length, 109);
});

test('FX3 probes, rules path: every row gives what it gives now', async () => {
  const drift: string[] = [];
  for (const row of PROBES.rules) {
    setStorageForTests(createMemoryStorage());
    try {
      const proposal = await proposeMobileCapture({ text: row.text, timezone: TZ, referenceTime: row.referenceTime ?? NOW });
      const actual = { status: proposal.status, items: proposal.items.map(line) };
      try {
        assert.deepEqual(actual, row.expected);
      } catch {
        drift.push(`${row.text} @${row.referenceTime ?? NOW}\n   expected ${JSON.stringify(row.expected)}\n   actual   ${JSON.stringify(actual)}`);
      }
    } finally {
      resetStorageForTests();
    }
  }
  assert.deepEqual(drift, []);
});

test('FX3 probes, model path: every scripted answer is kept, raised or asked as it is now', async () => {
  const drift: string[] = [];
  for (const row of PROBES.model) {
    const { date, time, level, source } = row.model!;
    const dueAt = date ? new Date(`${date}T${time ?? '00:00'}:00+03:00`).toISOString() : null;
    const answer = (clause: string) => ({
      type: 'task', action: clause, title: clause, person: null, dueAt, remindAt: null,
      localTimeSpec: date ? { date, time, timezone: TZ } : null,
      priority: { level, source, pressureAllowed: false, pressureImplied: false },
      flexibility: 'movable', category: null, categoryConfidence: 0,
      confidence: { overall: 0.9, type: 1, action: 0.9, time: 0.9, priority: 1 },
      missingFields: [], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
    });
    const provider = async (prompt: string): Promise<string> => {
      const lines = prompt.split('\n');
      const payload = JSON.parse(lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1]!) as string | string[];
      return Array.isArray(payload)
        ? JSON.stringify({ items: payload.map((clause, clauseIndex) => ({ clauseIndex, ...answer(clause) })) })
        : JSON.stringify(answer(payload));
    };
    const contract = await proposeCapture(row.text, { now: new Date(row.referenceTime ?? NOW), timezone: TZ, scopeId: 'probe', requestedEngine: 'model' }, {
      store: new MemoryCaptureProposalStore(),
      persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
      llmProvider: provider,
      llmEngine: 'gemini',
    });
    const actual = { status: contract.status, items: contract.items.map(line) };
    try {
      assert.deepEqual(actual, row.expected);
    } catch {
      drift.push(`${row.text} [model ${date} ${time} ${level}/${source}] @${row.referenceTime ?? NOW}\n   expected ${JSON.stringify(row.expected)}\n   actual   ${JSON.stringify(actual)}`);
    }
  }
  assert.deepEqual(drift, []);
});
