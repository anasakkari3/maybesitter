/**
 * Gemini 2.5 Flash's paid first-turn answers from 2026-10-24, replayed
 * through the real capture-chat service without network access.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { CaptureConversationStore } from '../../lib/services/captureChat/conversationStore.ts';
import { chatMobileCapture } from '../../lib/services/captureChat/captureChatService.ts';
import { localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';

type LiveRecord = {
  name: string;
  input: {
    locale: 'ar' | 'en' | 'he';
    message: string;
    referenceTime: string;
    timezone: string;
  };
  rawText: string;
};

const LIVE = JSON.parse(readFileSync(
  new URL('../fixtures/capture-chat-live-paid-r1.json', import.meta.url),
  'utf8',
)) as { records: LiveRecord[] };

function citedCommitment(input: {
  title: string;
  action: string;
  source: string;
  date: string;
  time: string | null;
  dueAt: string | null;
}) {
  return {
    kind: 'commitment', type: 'task', action: input.action, title: input.title, person: null,
    dueAt: input.dueAt, remindAt: null,
    localTimeSpec: { date: input.date, time: input.time, timezone: 'Asia/Jerusalem' },
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 0.9, type: 1, action: 1, time: input.time ? 1 : 0, priority: 1 },
    missingFields: input.time ? [] : ['time'], ambiguityFlags: [],
    explicitReminderRequest: false, explicitPressureRequest: false,
    appTitle: input.title, source: input.source,
  };
}

const SHARED_REMAINDER_CASES: LiveRecord[] = [
  {
    name: 'S1 en shared time',
    input: {
      locale: 'en', message: 'Tomorrow at 5 I have to call mom and pay the bill',
      referenceTime: '2026-10-24T07:00:00.000Z', timezone: 'Asia/Jerusalem',
    },
    rawText: JSON.stringify({
      reply: 'Tomorrow at 5 PM you have to call mom and pay the bill. Please confirm these below.',
      action: 'propose', locked: [], open: [],
      added: [
        citedCommitment({
          title: 'Call mom', action: 'call mom', source: 'I have to call mom', date: '2026-10-25',
          time: '17:00', dueAt: '2026-10-25T14:00:00.000Z',
        }),
        citedCommitment({
          title: 'Pay the bill', action: 'pay the bill', source: 'pay the bill', date: '2026-10-25',
          time: '17:00', dueAt: '2026-10-25T14:00:00.000Z',
        }),
      ],
    }),
  },
  {
    name: 'S3 en shared stated time',
    input: {
      locale: 'en', message: 'Tomorrow at 5 PM I have to call mom and pay the bill',
      referenceTime: '2026-10-24T07:00:00.000Z', timezone: 'Asia/Jerusalem',
    },
    rawText: JSON.stringify({
      reply: 'Tomorrow at 5 PM you have to call mom and pay the bill. Please confirm these below.',
      action: 'propose', locked: [], open: [],
      added: [
        citedCommitment({
          title: 'Call mom', action: 'call mom', source: 'I have to call mom', date: '2026-10-25',
          time: '17:00', dueAt: '2026-10-25T15:00:00.000Z',
        }),
        citedCommitment({
          title: 'Pay the bill', action: 'pay the bill', source: 'pay the bill', date: '2026-10-25',
          time: '17:00', dueAt: '2026-10-25T15:00:00.000Z',
        }),
      ],
    }),
  },
  {
    name: 'S4 en model question about another point (live r4)',
    input: {
      locale: 'en', message: "Call mom and I'm thinking about traveling",
      referenceTime: '2026-10-24T07:00:00.000Z', timezone: 'Asia/Jerusalem',
    },
    rawText: "{\"reply\":\"I have \\\"Call mom\\\" for you. What day and time would you like to travel?\",\"action\":\"propose\",\"locked\":[],\"open\":[],\"added\":[{\"kind\":\"commitment\",\"type\":\"task\",\"action\":\"Call\",\"title\":\"Call mom\",\"person\":\"mom\",\"dueAt\":null,\"remindAt\":null,\"localTimeSpec\":null,\"priority\":{\"level\":\"normal\",\"source\":\"default\",\"pressureAllowed\":false,\"pressureImplied\":false},\"flexibility\":\"movable\",\"category\":\"family\",\"categoryConfidence\":1,\"confidence\":{\"overall\":0.8,\"type\":1,\"action\":0.8,\"time\":0.5,\"priority\":1},\"missingFields\":[\"time\"],\"ambiguityFlags\":[\"vague_time\"],\"explicitReminderRequest\":false,\"explicitPressureRequest\":false,\"appTitle\":\"Call mom\",\"source\":\"Call mom\"},{\"kind\":\"consideration\",\"type\":\"informational_context\",\"action\":null,\"title\":\"traveling\",\"person\":null,\"dueAt\":null,\"remindAt\":null,\"localTimeSpec\":null,\"priority\":{\"level\":\"normal\",\"source\":\"default\",\"pressureAllowed\":false,\"pressureImplied\":false},\"flexibility\":\"movable\",\"category\":null,\"categoryConfidence\":0,\"confidence\":{\"overall\":0.8,\"type\":1,\"action\":0.8,\"time\":0.5,\"priority\":1},\"missingFields\":[],\"ambiguityFlags\":[],\"explicitReminderRequest\":false,\"explicitPressureRequest\":false,\"appTitle\":\"traveling\",\"source\":\"I'm thinking about traveling\"}]}",
  },
  {
    name: 'S2 ar shared day',
    input: {
      locale: 'ar', message: 'بكرا لازم اتصل بأمي الساعة 5 وادفع الفاتورة',
      referenceTime: '2026-10-24T07:00:00.000Z', timezone: 'Asia/Jerusalem',
    },
    rawText: JSON.stringify({
      reply: 'تمام، بكرا الساعة 5 المسا بدك تتصل بأمك وتدفع الفاتورة. أكّد من تحت.',
      action: 'propose', locked: [], open: [],
      added: [
        citedCommitment({
          title: 'اتصل بأمي', action: 'اتصل', source: 'لازم اتصل بأمي الساعة 5', date: '2026-10-25',
          time: '17:00', dueAt: '2026-10-25T14:00:00.000Z',
        }),
        citedCommitment({
          title: 'ادفع الفاتورة', action: 'ادفع', source: 'وادفع الفاتورة', date: '2026-10-25',
          time: null, dueAt: null,
        }),
      ],
    }),
  },
];

const stableCases = new Map<string, {
  reply: string;
  executedEngine: 'gemini' | 'rule-based';
  items: Array<{ title: string; date: string | null; time: string | null; endTime?: string | null; asking: boolean }>;
  seeds: Array<{ kind: string; summary: string }>;
}>([
  ['A1', {
    reply: 'تمام، بدك تخسر وزن. أكّد من تحت. «بدي اخسر وزن» هدف أكتر منه موعد، فهو تحت لحال: إذا بدك خلّيه.',
    executedEngine: 'rule-based',
    items: [], seeds: [{ kind: 'possible_goal', summary: 'بدي اخسر وزن' }],
  }],
  ['A2', {
    reply: 'فهمت إنك عم تفكر تسافر الصيف الجاي. أكّد من تحت.',
    executedEngine: 'rule-based',
    items: [], seeds: [{ kind: 'consideration', summary: 'عم بفكر أسافر الصيف الجاي' }],
  }],
  ['A3', {
    reply: "That's an interesting thought.",
    executedEngine: 'rule-based',
    items: [], seeds: [{ kind: 'consideration', summary: "I'm thinking about selling my car" }],
  }],
  ['A8', {
    reply: 'تمام، بكرا عندك شغل من الساعة 4 للساعة 8 المسا. أكّد من تحت.',
    executedEngine: 'gemini',
    items: [{ title: 'شغل', date: '2026-10-25', time: '16:00', endTime: '2026-10-25T18:00:00.000Z', asking: false }],
    seeds: [],
  }],
  ['A9', {
    reply: 'הבנתי שאתה צריך להתקשר לרופא מחר ב-10:00. אשר למטה.',
    executedEngine: 'gemini',
    items: [{ title: 'להתקשר לרופא', date: '2026-10-25', time: '10:00', asking: false }],
    seeds: [],
  }],
]);

function caseId(record: LiveRecord): string {
  return record.name.split(' ', 1)[0]!;
}

function local(iso: string | null | undefined, timezone: string): { date: string | null; time: string | null } {
  if (!iso) return { date: null, time: null };
  const spec = localTimeSpecFor(new Date(iso), timezone);
  return { date: spec?.date ?? null, time: spec?.time ?? null };
}

async function replay(record: LiveRecord, kinds: boolean) {
  process.env.MAYBESITTER_FEATURE_CAPTURE_KINDS = kinds ? 'true' : 'false';
  process.env.MAYBESITTER_KILL_SWITCH_CAPTURE_KINDS = 'false';
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const uid = `LivePaid${caseId(record)}${kinds ? 'On' : 'Off'}xxxxxxxxxxxx`.slice(0, 28);
  await seedLiveAccount(uid, storage);
  return chatMobileCapture(record.input, { participantId: uid }, {
    conversations: new CaptureConversationStore(),
    llmProviderFor: () => async () => record.rawText,
  });
}

test('live paid first turns keep each cited point inside its own evidence span, with capture kinds off and on', async () => {
  const oldFeature = process.env.MAYBESITTER_FEATURE_CAPTURE_KINDS;
  const oldKill = process.env.MAYBESITTER_KILL_SWITCH_CAPTURE_KINDS;
  try {
    for (const kinds of [false, true]) {
      for (const record of [...LIVE.records, ...SHARED_REMAINDER_CASES]) {
        const id = caseId(record);
        const answer = await replay(record, kinds);
        const proposal = answer.proposal;
        assert.ok(proposal, `${id} kinds=${kinds}: no proposal`);
        assert.equal(answer.engine, 'model', `${id} kinds=${kinds}: chat engine`);

        const stable = stableCases.get(id);
        if (stable) {
          assert.equal(answer.reply, stable.reply, `${id} kinds=${kinds}: reply changed`);
          assert.deepEqual(proposal.seeds.map(({ kind, summary }) => ({ kind, summary })), stable.seeds,
            `${id} kinds=${kinds}: seeds changed`);
          assert.deepEqual(proposal.items.map((item) => {
            const clock = local(item.resolvedTime, record.input.timezone);
            return {
              title: item.title,
              date: item.resolvedDate ?? clock.date,
              time: clock.time,
              ...(item.endTime ? { endTime: item.endTime } : {}),
              asking: item.needsClarification,
            };
          }), stable.items, `${id} kinds=${kinds}: items changed`);
          assert.equal(proposal.provenance.executedEngine, stable.executedEngine, `${id} kinds=${kinds}: provenance changed`);
        }

        if (id === 'A4') {
          assert.deepEqual(proposal.items.map((item) => ({ title: item.title, time: local(item.resolvedTime, record.input.timezone).time })), [
            { title: 'اتصل بأمي', time: '17:00' },
            { title: 'ادفع فاتورة الكهربا', time: null },
            ...(kinds ? [] : [{ title: 'ابلش اركض', time: null }]),
          ]);
          assert.equal(proposal.items.find((item) => item.title === 'ادفع فاتورة الكهربا')?.needsClarification, true);
          assert.doesNotMatch(answer.reply, /^(?:كمان|و)/, 'A4 left a dangling joining word');
          const missingFragments = answer.reply.match(/احكيلي اليوم والساعة/g) ?? [];
          assert.equal(missingFragments.length, 1, answer.reply);
          assert.ok(answer.asked, answer.reply);
          assert.ok(answer.reply.endsWith(answer.asked.text), answer.reply);
        }

        if (id === 'A5') {
          const call = proposal.items.find((item) => item.title === 'Call my mom');
          const bill = proposal.items.find((item) => item.title === 'Pay the electricity bill');
          const running = proposal.items.find((item) => item.title === 'Start running every morning');
          assert.equal(local(call?.resolvedTime, record.input.timezone).time, '17:00');
          assert.equal(call?.resolvedDate, '2026-10-25');
          assert.equal(bill?.resolvedTime, null, 'the call citation must not time the bill');
          assert.equal(bill?.needsClarification, true);
          if (kinds) {
            assert.equal(running, undefined, 'the cited habit should leave the item list');
            assert.deepEqual(proposal.habits?.map((habit) => habit.title), ['Start running every morning']);
          } else {
            assert.equal(running?.resolvedTime, null, 'the call citation must not time the running point');
            assert.equal(running?.needsClarification, true);
            assert.deepEqual(proposal.habits ?? [], []);
          }
          assert.deepEqual(proposal.seeds.map(({ kind, summary }) => ({ kind, summary })), [
            { kind: 'consideration', summary: "I'm thinking about selling the car" },
            { kind: 'possible_goal', summary: 'I want to learn Spanish this year' },
          ]);
          assert.equal(new Set(proposal.seeds.map((seed) => `${seed.kind}:${seed.summary}`)).size, 2, 'A5 duplicated a seed');
          const pointCount = proposal.items.length + proposal.seeds.length + (proposal.habits?.length ?? 0) + (proposal.goals?.length ?? 0);
          assert.equal(pointCount, 5, `A5 kinds=${kinds}: a cited point was lost or duplicated`);
        }

        if (id === 'A6') {
          assert.equal(answer.reply, 'تمام، بدك تمشي كل يوم نص ساعة. إيمتى حابب تمشي؟');
          assert.deepEqual(proposal.seeds, []);
          if (kinds) {
            assert.deepEqual(proposal.items, []);
            assert.deepEqual(proposal.habits?.map((habit) => ({
              title: habit.title,
              cadence: habit.cadence,
              durationMinutes: habit.durationMinutes,
              preferredWindow: habit.preferredWindow,
              confirmable: habit.confirmable,
            })), [{
              title: 'أمشي نص ساعة', cadence: { kind: 'weekly_count', count: 7 },
              durationMinutes: 30, preferredWindow: null, confirmable: true,
            }]);
          } else {
            assert.deepEqual(proposal.items.map((item) => ({ title: item.title, time: item.resolvedTime, asking: item.needsClarification })), [
              { title: 'أمشي نص ساعة', time: null, asking: true },
            ]);
          }
        }

        if (id === 'A7') {
          assert.equal(proposal.provenance.executedEngine, 'gemini', 'the cited answer fell back to rules');
          assert.deepEqual(proposal.items.map((item) => ({ title: item.title, asking: item.needsClarification })), [
            { title: 'Call mom', asking: true },
          ]);
          assert.deepEqual(proposal.seeds.map(({ kind, summary }) => ({ kind, summary })), [
            { kind: 'consideration', summary: "I'm thinking about traveling" },
          ]);
          assert.ok(answer.asked, answer.reply);
          assert.ok(answer.reply.endsWith(answer.asked.text), answer.reply);
        }

        if (id === 'S1') {
          assert.deepEqual(proposal.items.map((item) => ({
            title: item.title,
            date: item.resolvedDate ?? local(item.resolvedTime, record.input.timezone).date,
            time: local(item.resolvedTime, record.input.timezone).time,
            asking: item.needsClarification,
          })), [
            { title: 'Call mom', date: '2026-10-25', time: null, asking: true },
            { title: 'Pay the bill', date: '2026-10-25', time: null, asking: true },
          ], `S1 kinds=${kinds}: the shared day reaches both; the bare 5 is asked, never guessed`);
          for (const item of proposal.items) assert.equal(item.clarification?.questionKey, 'ask_am_pm', `S1 kinds=${kinds}`);
        }

        if (id === 'S3') {
          assert.deepEqual(proposal.items.map((item) => ({
            title: item.title,
            time: local(item.resolvedTime, record.input.timezone).time,
            asking: item.needsClarification,
          })), [
            { title: 'Call mom', time: '17:00', asking: false },
            { title: 'Pay the bill', time: '17:00', asking: false },
          ], `S3 kinds=${kinds}: a shared stated time reaches both citations`);
        }

        if (id === 'S4') {
          // Live r4: Gemini asked "What day and time would you like to travel?"
          // beside "Call mom"; the question names the other point, so the
          // item's own question replaces it.
          assert.ok(!/travel\?$/.test(answer.reply), answer.reply);
          assert.match(answer.reply, /"Call mom"\?/);
          assert.ok(answer.asked && /Call mom/.test(answer.asked.text), JSON.stringify(answer.asked));
        }

        if (id === 'S2') {
          const call = proposal.items.find((item) => item.title === 'اتصل بأمي');
          const bill = proposal.items.find((item) => item.title === 'ادفع الفاتورة');
          assert.equal(call?.resolvedDate, '2026-10-25');
          // A bare «الساعة 5» is asked (live r11 L3), with the day kept.
          assert.equal(call?.resolvedTime, null);
          assert.equal(call?.needsClarification, true);
          assert.equal(call?.clarification?.questionKey, 'ask_am_pm');
          assert.equal(bill?.resolvedDate, '2026-10-25');
          assert.equal(bill?.resolvedTime, null);
          assert.equal(bill?.needsClarification, true);
          assert.equal(bill?.clarification?.questionKey, 'ask_time');
        }

        resetStorageForTests();
      }
    }
  } finally {
    resetStorageForTests();
    if (oldFeature === undefined) delete process.env.MAYBESITTER_FEATURE_CAPTURE_KINDS;
    else process.env.MAYBESITTER_FEATURE_CAPTURE_KINDS = oldFeature;
    if (oldKill === undefined) delete process.env.MAYBESITTER_KILL_SWITCH_CAPTURE_KINDS;
    else process.env.MAYBESITTER_KILL_SWITCH_CAPTURE_KINDS = oldKill;
  }
});
