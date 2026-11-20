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
import { clockTimesIn } from '../../src/extraction/ruleBasedExtractor.ts';

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

function reply(text: string, extra: { userTurns?: string[]; conflicts?: unknown[]; items?: unknown[]; language?: 'ar' | 'en' } = {}) {
  const items = (extra.items ?? [{ ...CARD, ...(extra.conflicts ? { conflicts: extra.conflicts } : {}) }]) as never[];
  return safeChatReply(text, {
    language: extra.language ?? 'ar',
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

/* ── review round (2026-11-20): the half of the day, spoken minutes, questions, clashes ── */

/** A card at `local` (HH:MM) today in Jerusalem, as the unit helper's items. */
function cardAt(local: string, extra: Record<string, unknown> = {}) {
  const [hour, minute] = local.split(':').map(Number) as [number, number];
  // Jerusalem is UTC+2 in November.
  const utc = new Date(Date.UTC(2026, 10, 20, hour - 2, minute)).toISOString();
  return [{ ...CARD, resolvedTime: utc, ...extra }];
}
const LINE = (time: string) => `«آخد الدوا» اليوم الساعة ${LRI}${time}${PDI}.`;

test('review 1: a half of the day the reply names must be the card\'s — «3:39 الصبح» is not 15:39', () => {
  assert.equal(reply('الدوا الساعة 3:39 الصبح.', { items: cardAt('15:39') }), LINE('15:39'));
  assert.equal(reply('الدوا الساعة 5:39 المسا.', { items: cardAt('05:39') }), LINE('05:39'));
  assert.equal(reply('الدوا الساعة 17:39.', { items: cardAt('05:39') }), LINE('05:39'));
});

test('review 1: the right half of the day, or none at all, keeps the sentence', () => {
  for (const [text, card] of [
    ['الدوا الساعة 3:39 العصر.', '15:39'],
    ['الدوا الساعة 3:39.', '15:39'],
    ['الدوا الساعة 15:39.', '15:39'],
    ['الدوا الساعة 10 بالليل.', '22:00'],
    ['الدوا الساعة 2 بالليل.', '02:00'],
    ['الدوا الساعة 12 الضهر.', '12:00'],
  ] as const) {
    assert.equal(reply(text, { items: cardAt(card) }), text, `${text} for ${card}`);
  }
});

test('review 1: English "PM"/"AM" are read too', () => {
  const items = [{ ...cardAt('17:00')[0], title: 'Take my medicine' }];
  assert.equal(reply('Take your medicine at 5 PM.', { items, language: 'en' }), 'Take your medicine at 5 PM.');
  assert.equal(reply('Take your medicine at 5 AM.', { items, language: 'en' }), '"Take my medicine" is today at 17:00.');
});

test('review 2: clockTimesIn reads spoken minutes and spoken English hours', () => {
  assert.deepEqual(clockTimesIn('الساعة خمسة ونص الصبح'), [{ hour: 5, minute: 30 }]);
  assert.deepEqual(clockTimesIn('الساعة 5 ونص'), [{ hour: 5, minute: 30 }]);
  assert.deepEqual(clockTimesIn('الساعة 5 وربع'), [{ hour: 5, minute: 15 }]);
  assert.deepEqual(clockTimesIn('الساعة 5 إلا ربع'), [{ hour: 4, minute: 45 }]);
  assert.deepEqual(clockTimesIn('take it at half past five'), [{ hour: 5, minute: 30 }]);
  assert.deepEqual(clockTimesIn('take it at five.'), [{ hour: 5, minute: 0 }]);
  assert.deepEqual(clockTimesIn('at five people came'), [], 'a count is not a clock');
  assert.deepEqual(clockTimesIn('3 ونص كيلو رز'), [], 'a quantity is not a clock');
});

test('review 2: a spoken half hour is compared by its minutes', () => {
  assert.equal(reply('الدوا الساعة خمسة ونص الصبح.', { items: cardAt('05:30') }), 'الدوا الساعة خمسة ونص الصبح.');
  assert.equal(reply('الدوا الساعة 5 ونص.', { items: cardAt('05:00') }), LINE('05:00'));
});

test('review 3: a question that restates the card is checked; a question offering another hour is not', () => {
  assert.equal(reply('تمام، يعني الساعة 3:39 الصبح؟'), LINE('05:39'));
  assert.equal(reply('الدوا الساعة 3:39 الصبح، صح؟'), LINE('05:39'));
  const conflicts = [{ title: 'اجتماع', startsAt: '2026-11-20T03:00:00.000Z', endsAt: '2026-11-20T04:00:00.000Z', kind: 'commitment', inProposal: false }];
  const offer = 'هاد بيتعارض مع «اجتماع» اليوم الساعة 5. بدك نخليها الساعة 7 الصبح؟';
  assert.equal(reply(offer, { conflicts }), offer);
});

test('review 3: while an item is still asked about, its question is never checked', () => {
  const items = [{ itemId: 'i1', title: 'آخد الدوا', resolvedTime: null, resolvedDate: '2026-11-20', needsClarification: true, clarification: { questionKey: 'ask_am_pm' } }];
  const text = reply('الدوا الساعة 5 الصبح ولا المسا؟', { items, userTurns: ['بكرا الساعة 5 لازم آخد الدوا'] });
  assert.match(text, /الساعة 5 الصبح ولا المسا؟/);
});

test('review 4: a clash in a sentence that goes is said again from the list, once', () => {
  const conflicts = [{ title: 'Standup', startsAt: '2026-11-20T05:00:00.000Z', endsAt: '2026-11-20T05:30:00.000Z', kind: 'commitment', inProposal: false }];
  const items = cardAt('07:00', { conflicts });
  const text = reply('هاد بيتعارض مع Standup الساعة 7، لهيك نقلتها 9:15. أكّد من تحت.', { items });
  assert.doesNotMatch(text, /9:15/);
  assert.ok(text.includes(LINE('07:00')), text);
  assert.match(text, /بيتعارض مع .*Standup/);
  assert.equal(text.split('Standup').length - 1, 1, `the clash is said more than once: ${text}`);
});

test('review 4: the card\'s line is not added when the reply already says its right hour', () => {
  assert.equal(reply('الدوا الساعة 5:39. تمام، الساعة 3:39 لازم تاخده.'), 'الدوا الساعة 5:39.');
});

test('review 7 (M5): a clash\'s end hour is the clash\'s', () => {
  const conflicts = [{ title: null, startsAt: '2026-11-20T03:00:00.000Z', endsAt: '2026-11-20T06:00:00.000Z', kind: 'calendar_busy', inProposal: false }];
  const text = 'تقويمك بيقول إنك مشغول من 5 لـ 8.';
  assert.equal(reply(text, { conflicts }), text);
});

test('review 7 (M5b): a card\'s end hour is the card\'s', () => {
  const items = [{ ...cardAt('09:00')[0], title: 'اجتماع', endTime: new Date(Date.UTC(2026, 10, 20, 9, 0)).toISOString() }];
  const text = 'الاجتماع من 9 لـ 11.';
  assert.equal(reply(text, { items, userTurns: ['اجتماع'] }), text);
});

test('review 7 (M6): the minutes are compared — «5» is not 05:39', () => {
  assert.equal(reply('الدوا الساعة 5.'), LINE('05:39'));
});

test('review 7 (M22): a card with no time is not the card a wrong clock is about', () => {
  const items = [CARD, { itemId: 'i2', title: 'اتصل بأحمد', resolvedTime: null, needsClarification: false }];
  assert.equal(reply('الساعة 3:39 الصبح.', { items }), LINE('05:39'));
});

/* ── mutation round: each check below fails when its line is taken out ── */

test('mutation: an offer that names the card is still an offer, and stays', () => {
  const conflicts = [{ title: 'اجتماع', startsAt: '2026-11-20T03:00:00.000Z', endsAt: '2026-11-20T04:00:00.000Z', kind: 'commitment', inProposal: false }];
  const offer = 'هاد بيتعارض مع «اجتماع» اليوم الساعة 5. بدك نخلي الدوا الساعة 7 الصبح؟';
  assert.equal(reply(offer, { conflicts }), offer);
});

test('mutation: a half of the day said before the first clock counts — «الصبح الساعة 3:39» is not 15:39', () => {
  assert.equal(reply('الدوا الصبح الساعة 3:39.', { items: cardAt('15:39') }), LINE('15:39'));
});

test('mutation: an hour the person said without its half is theirs in either half', () => {
  const items = cardAt('15:00');
  const text = 'الدوا الساعة 3 العصر، والتذكير الساعة 4 المسا.';
  assert.equal(reply(text, { items, userTurns: ['ذكرني الساعة 4 بالدوا اللي الساعة 3'] }), text);
});

test('mutation: a range\'s end the card does not have takes the sentence out', () => {
  const items = [{ ...cardAt('09:00')[0], title: 'اجتماع', endTime: new Date(Date.UTC(2026, 10, 20, 9, 0)).toISOString() }];
  assert.equal(reply('الاجتماع من 9 لـ 12.', { items, userTurns: ['اجتماع'] }), `«اجتماع» اليوم الساعة ${LRI}09:00${PDI}.`);
});

const ASKED = { itemId: 'i2', title: 'اتصل بأحمد', resolvedTime: null, resolvedDate: '2026-11-20', needsClarification: true, clarification: { questionKey: 'ask_time', params: { date: '2026-11-20' } } };

test('review 3: the ask for a missing hour is never checked, even when it names its item and offers hours', () => {
  const text = reply('أي ساعة لـ«اتصل بأحمد»، 9 ولا 10؟', { items: [CARD, ASKED] });
  assert.match(text, /أي ساعة لـ«اتصل بأحمد»، 9 ولا 10؟$/);
});

test('review 3: while another item is asked about, a question restating a card with a wrong clock is still checked', () => {
  const text = reply('يعني الدوا الساعة 3:39 الصبح؟ أي ساعة بدك «اتصل بأحمد»؟', { items: [CARD, ASKED] });
  assert.doesNotMatch(text, /3:39/);
  assert.ok(text.includes(LINE('05:39')), text);
});

test('review 3: a question restating a card with no time is checked, and never answered with another card\'s hour', () => {
  const untimed = { itemId: 'i2', title: 'اتصل بأحمد', resolvedTime: null, needsClarification: false };
  assert.equal(reply('يعني «اتصل بأحمد» الساعة 4:20؟ أكّد من تحت.', { items: [CARD, untimed] }), 'أكّد من تحت.');
});
