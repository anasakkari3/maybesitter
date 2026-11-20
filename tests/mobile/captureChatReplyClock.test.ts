/**
 * QA v3 staging recheck (2026-11-20): the capture chat's reply said the hour
 * on the wrong clock.
 *
 *   POST /api/mobile/capture/chat «بعد ساعتين لازم آخد الدوا», Asia/Jerusalem,
 *   at 01:39Z (03:39 in Jerusalem): the card was right — 05:40 Jerusalem —
 *   and the reply said «تمام، يعني الساعة 3:39 الصبح لازم تاخد الدوا.»: a
 *   clock the card does not have, two hours off for the person.
 *
 * The hour in the reply was the model's own writing; nothing compared it with
 * the card. Now a sentence of the reply that states a clock the list does not
 * hold — no card's hour, no clash's, none the person said — is taken out, and
 * the hour is said from the card itself, on the person's clock.
 *
 * Replayed with a scripted model (no model is called), in three zones and
 * across local midnight.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { beginModel, chat, end, modelFirstAnswer, modelItem, show } from '../acceptance/m2b/support.ts';
import { localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';
import { safeChatReply } from '../../lib/services/captureChat/chatReply.ts';

const MEDICINE = 'بعد ساعتين لازم آخد الدوا';
const LRI = '⁦';
const PDI = '⁩';

/** The clock the card holds, on the person's clock. */
function cardClock(resolvedTime: string | null | undefined, zone: string): { date: string; time: string } {
  assert.ok(resolvedTime, 'the card has no time');
  const local = localTimeSpecFor(new Date(resolvedTime!), zone);
  assert.ok(local, 'the card time does not read in the zone');
  return { date: local!.date, time: local!.time };
}

interface Case {
  label: string;
  zone: string;
  /** The person's clock now, as the phone sends it. */
  referenceTime: string;
  /** The reply the model wrote, with a clock on the wrong clock. */
  modelReply: string;
  /** The wrong clock, as it must no longer appear. */
  wrong: RegExp;
  locale: 'ar' | 'en';
  message: string;
  /** The day word the card's line says. */
  day: RegExp;
}

const CASES: Case[] = [
  {
    label: 'Jerusalem, the staging run: 01:39Z is 03:39 local, the card 05:39',
    zone: 'Asia/Jerusalem',
    referenceTime: '2026-11-20T01:39:00.000Z',
    modelReply: 'تمام، يعني الساعة 3:39 الصبح لازم تاخد الدوا. أكّد من تحت.',
    wrong: /3:39/,
    locale: 'ar',
    message: MEDICINE,
    day: /اليوم/,
  },
  {
    label: 'Los Angeles at 23:30 local: two hours on is 01:30 tomorrow',
    zone: 'America/Los_Angeles',
    referenceTime: '2026-11-20T07:30:00.000Z',
    modelReply: 'تمام، يعني الساعة 9:30 الصبح لازم تاخد الدوا. أكّد من تحت.',
    wrong: /9:30/,
    locale: 'ar',
    message: MEDICINE,
    day: /بكرا/,
  },
  {
    label: 'UTC at 22:50: two hours on is 00:50 tomorrow, and the model said 2:50',
    zone: 'UTC',
    referenceTime: '2026-11-20T22:50:00.000Z',
    modelReply: 'Okay, so at 2:50 AM you take the medicine. Confirm below.',
    wrong: /2:50/,
    locale: 'en',
    message: 'in 2 hours I need to take my medicine',
    day: /tomorrow/,
  },
];

for (const scenario of CASES) {
  test(`reply clock: ${scenario.label} — the reply says the card's hour, never another`, async () => {
    const uid = beginModel(modelFirstAnswer(scenario.modelReply, 'propose', [
      { ...modelItem(scenario.locale === 'ar' ? 'آخد الدوا' : 'Take my medicine', null, null), source: scenario.message },
    ]));
    try {
      const answer = await chat(uid, scenario.message, { timezone: scenario.zone, referenceTime: scenario.referenceTime, locale: scenario.locale });
      const item = answer.proposal?.items[0];
      assert.ok(item, `no card: ${show(answer.proposal)}`);
      const card = cardClock(item!.resolvedTime, scenario.zone);
      // The card is now plus two hours on the person's clock (V3-F04-04).
      const expected = new Date(Date.parse(scenario.referenceTime) + 2 * 3_600_000);
      assert.deepEqual(card, cardClock(expected.toISOString(), scenario.zone), `the card moved: ${show(item)}`);

      assert.doesNotMatch(answer.reply, scenario.wrong, `the reply still says the wrong clock: ${answer.reply}`);
      assert.ok(answer.reply.includes(card.time), `the reply does not say the card's hour ${card.time}: ${answer.reply}`);
      assert.match(answer.reply, scenario.day, `the reply does not say the card's day: ${answer.reply}`);
    } finally {
      end();
    }
  });
}

test('reply clock: a reply that says the card\'s own hour is kept word for word', async () => {
  const zone = 'Asia/Jerusalem';
  const reply = 'تمام، يعني الساعة 5:39 الصبح لازم تاخد الدوا. أكّد من تحت.';
  const uid = beginModel(modelFirstAnswer(reply, 'propose', [{ ...modelItem('آخد الدوا', null, null), source: MEDICINE }]));
  try {
    const answer = await chat(uid, MEDICINE, { timezone: zone, referenceTime: '2026-11-20T01:39:00.000Z', locale: 'ar' });
    assert.equal(cardClock(answer.proposal?.items[0]?.resolvedTime, zone).time, '05:39');
    assert.equal(answer.reply, reply);
  } finally {
    end();
  }
});

/* ── the reply's own check, unit by unit ─────────────────────────────── */

const NOW = new Date('2026-11-20T01:39:00.000Z');
const ZONE = 'Asia/Jerusalem';
const CARD = { itemId: 'i1', title: 'آخد الدوا', resolvedTime: '2026-11-20T03:39:00.000Z', resolvedDate: '2026-11-20', needsClarification: false };

function reply(text: string, extra: { userTurns?: string[]; conflicts?: unknown[]; items?: unknown[] } = {}) {
  const items = (extra.items ?? [{ ...CARD, ...(extra.conflicts ? { conflicts: extra.conflicts } : {}) }]) as never[];
  return safeChatReply(text, {
    language: 'ar',
    proposal: { items },
    timezone: ZONE,
    grounds: { userTurns: extra.userTurns ?? [MEDICINE], items, now: NOW, timezone: ZONE },
  }).reply;
}

test('reply clock (unit): a clock no card has is taken out and the card\'s hour said in its place', () => {
  const text = reply('تمام، يعني الساعة 3:39 الصبح لازم تاخد الدوا. أكّد من تحت.');
  assert.doesNotMatch(text, /3:39/);
  assert.equal(text, `«آخد الدوا» اليوم الساعة ${LRI}05:39${PDI}. أكّد من تحت.`);
});

test('reply clock (unit): the card\'s hour in 12-hour words is the card\'s hour', () => {
  const text = 'تمام، الساعة 5:39 الصبح لازم تاخد الدوا. أكّد من تحت.';
  assert.equal(reply(text), text);
});

test('reply clock (unit): an hour the person said is theirs to repeat', () => {
  const items = [{ ...CARD, resolvedTime: '2026-11-20T15:00:00.000Z' }];
  const text = 'تمام، الدوا الساعة 5 المسا، والتذكير قبلها بساعة الساعة 4. أكّد من تحت.';
  assert.equal(reply(text, { userTurns: ['ذكرني الساعة 4 آخد الدوا اللي الساعة 5'], items }), text);
});

test('reply clock (unit): a clash\'s hour is the clash\'s, and stays', () => {
  const conflicts = [{ title: 'اجتماع', startsAt: '2026-11-20T03:00:00.000Z', endsAt: '2026-11-20T04:00:00.000Z', kind: 'commitment', inProposal: false }];
  const text = 'هاد بيتعارض مع «اجتماع» اليوم الساعة 5. أكّد من تحت.';
  assert.equal(reply(text, { conflicts }), text);
});

test('reply clock (unit): a question offering an hour is not a statement about the card', () => {
  const conflicts = [{ title: 'اجتماع', startsAt: '2026-11-20T03:00:00.000Z', endsAt: '2026-11-20T04:00:00.000Z', kind: 'commitment', inProposal: false }];
  const text = 'هاد بيتعارض مع «اجتماع» اليوم الساعة 5. بدك نخليها الساعة 7 الصبح؟';
  assert.equal(reply(text, { conflicts }), text);
});

test('reply clock (unit): with two cards, only the card the wrong sentence names is said again', () => {
  const items = [
    CARD,
    { itemId: 'i2', title: 'اتصل بأحمد', resolvedTime: '2026-11-20T10:00:00.000Z', resolvedDate: '2026-11-20', needsClarification: false },
  ];
  const text = reply('الدوا الساعة 3:39 الصبح. أحمد الساعة 12 الظهر. أكّد من تحت.', { items, userTurns: [`${MEDICINE} واتصل بأحمد الساعة 12 الظهر`] });
  assert.equal(text, `«آخد الدوا» اليوم الساعة ${LRI}05:39${PDI}. أحمد الساعة 12 الظهر. أكّد من تحت.`);
});

test('reply clock (unit): one sentence with a wrong clock and a right one says both cards from the list', () => {
  const items = [
    CARD,
    { itemId: 'i2', title: 'اتصل بأحمد', resolvedTime: '2026-11-20T10:00:00.000Z', resolvedDate: '2026-11-20', needsClarification: false },
  ];
  const text = reply('الدوا الساعة 3:39 الصبح وأحمد الساعة 12 الظهر. أكّد من تحت.', { items, userTurns: [`${MEDICINE} واتصل بأحمد الساعة 12 الظهر`] });
  assert.equal(text, `«آخد الدوا» اليوم الساعة ${LRI}05:39${PDI}. «اتصل بأحمد» اليوم الساعة ${LRI}12:00${PDI}. أكّد من تحت.`);
});

test('reply clock (unit): nothing left but the wrong clock is the card\'s line, never an empty reply', () => {
  const text = reply('الساعة 3:39 الصبح.');
  assert.equal(text, `«آخد الدوا» اليوم الساعة ${LRI}05:39${PDI}.`);
});
