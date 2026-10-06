/**
 * M2a Task B, criterion 4 (End time) and 4a's timezone half — condition 2 of
 * the 2026-10-06 audit: «من ٤ إلى ٨» keeps the 8.
 *
 * Contract v3: `item.endTime` is the ISO instant of the LOCAL end clock the
 * person said, on the item's local date and timezone (next-day ranges allowed;
 * a nonexistent local end moves forward to the first valid minute, an
 * ambiguous one takes the earlier offset), present only when a deterministic
 * range parse of the item's own words found it; the confirmed command's
 * `timeSpec.endAt` is the same instant. Spelled-out Arabic hours are clock
 * evidence only, never before a count unit (M2A-R3-004).
 *
 * Acceptance gate written independently of the builder: every test here must
 * fail on 0620a7b2 for the reason its criterion names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatPrompt } from '../../../lib/services/captureChat/chatPrompt.ts';
import {
  REFERENCE,
  TODAY,
  TOMORROW,
  TZ,
  at,
  beginModel,
  beginRules,
  chat,
  clarify,
  confirmAndReadTimeSpecs,
  end,
  modelAnswer,
  modelItem,
  type Item,
} from './support.ts';

function only(items: Item[] | undefined, label: string): Item {
  assert.equal(items?.length, 1, `${label}: not one item: ${JSON.stringify(items)}`);
  return items![0]!;
}

for (const message of ['اجتماع من 4 لـ 8 المسا', 'Meeting from 4 to 8pm', 'اجتماع من أربعة لثمانية المسا']) {
  test(`B4 end time (rules): «${message}» is 16:00 to 20:00 today`, async () => {
    const uid = beginRules();
    try {
      const body = await chat(uid, message);
      const item = only(body.proposal?.items, message);
      assert.equal(item.resolvedTime, at(TODAY, '16:00'), `«${message}» does not start at 16:00`);
      assert.equal(item.endTime, at(TODAY, '20:00'), `«${message}» lost its end: endTime is ${item.endTime}`);
    } finally {
      end();
    }
  });
}

test('B4 end time (model path): the end is read from the person\'s own words — the said range gets 20:00, the item with no range gets none', async () => {
  const uid = beginModel(modelAnswer(
    'فهمت: اجتماع اليوم من 4 لـ 8 المسا، وتتصل بأمك الساعة 9 المسا. أكّد من تحت.',
    'propose',
    [
      // The model's items carry no end at all: it comes from the evidence.
      modelItem('اجتماع', TODAY, '16:00', { kind: 'commitment' }),
      modelItem('اتصل بأمي', TODAY, '21:00', { kind: 'commitment' }),
    ],
  ));
  try {
    const body = await chat(uid, 'اجتماع اليوم من 4 لـ 8 المسا، واتصل بأمي الساعة 9 المسا', { locale: 'ar' });
    assert.equal(body.engine, 'model');
    const meeting = body.proposal?.items.find((item) => item.title.includes('اجتماع'));
    const call = body.proposal?.items.find((item) => item.title.includes('أمي'));
    assert.ok(meeting && call, `missing an item: ${JSON.stringify(body.proposal?.items)}`);
    assert.equal(meeting!.resolvedTime, at(TODAY, '16:00'));
    assert.equal(meeting!.endTime, at(TODAY, '20:00'), `the said end was not read: endTime is ${meeting!.endTime}`);
    assert.equal(call!.endTime, undefined, 'an end nobody said was given to the call');
  } finally {
    end();
  }
});

test('B4 end time (rules, M2A-R3-004): spelled-out hours before a count unit are no range, while «من أربعة لثمانية المسا» is', async () => {
  const uid = beginRules();
  try {
    const ranged = await chat(uid, 'اجتماع من أربعة لثمانية المسا');
    const item = only(ranged.proposal?.items, 'spelled-out range');
    assert.equal(item.endTime, at(TODAY, '20:00'), `«من أربعة لثمانية المسا» is not read as 16:00–20:00: ${JSON.stringify(item)}`);
  } finally {
    end();
  }
  for (const unit of ['أشخاص', 'مرات', 'أيام', 'ساعات', 'دقايق']) {
    const message = `اجتماع من أربعة لثمانية ${unit}`;
    const uid = beginRules();
    try {
      const body = await chat(uid, message);
      for (const item of body.proposal?.items ?? []) {
        assert.equal(item.endTime, undefined, `«${message}» was read as a time range`);
        for (const hour of ['04:00', '16:00']) {
          assert.notEqual(item.resolvedTime, at(TODAY, hour), `«${message}» was read as a clock (${hour})`);
          assert.notEqual(item.resolvedTime, at(TOMORROW, hour), `«${message}» was read as a clock (${hour})`);
        }
      }
    } finally {
      end();
    }
  }
});

for (const [optionId, start, finish] of [['pm', '16:00', '20:00'], ['am', '04:00', '08:00']] as const) {
  test(`B4 end time (rules): a bare early range asks morning/evening once and keeps the end after «${optionId}» — proposal and stored command agree (${start}–${finish})`, async () => {
    const uid = beginRules();
    try {
      const first = await chat(uid, 'اجتماع بكرا من 4 لـ 8', { locale: 'ar' });
      const asking = first.proposal?.items.filter((item) => item.needsClarification) ?? [];
      assert.equal(asking.length, 1, `not one question: ${JSON.stringify(first.proposal?.items)}`);
      const answered = await clarify(uid, first.proposal!, asking[0]!, { optionId });
      const item = only(answered.items, 'after the answer');
      assert.equal(item.needsClarification, false, 'the half of the day was asked again');
      assert.equal(item.resolvedTime, at(TOMORROW, start));
      assert.equal(item.endTime, at(TOMORROW, finish), `the end was lost after the answer: endTime is ${item.endTime}`);
      const stored = await confirmAndReadTimeSpecs(uid, answered, [item.itemId]);
      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.timeSpec.dueAt, at(TOMORROW, start));
      assert.equal(stored[0]!.timeSpec.endAt, item.endTime, 'the stored command\'s timeSpec.endAt is not the proposal\'s endTime');
    } finally {
      end();
    }
  });
}

test('B4 end time (rules): the confirmed command stores the said end as timeSpec.endAt, the same instant as endTime', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, 'اجتماع بكرا من 4 لـ 8 المسا', { locale: 'ar' });
    const item = only(body.proposal?.items, 'evening range');
    assert.equal(item.endTime, at(TOMORROW, '20:00'), `endTime is ${item.endTime}`);
    const stored = await confirmAndReadTimeSpecs(uid, body.proposal!, [item.itemId]);
    assert.equal(stored[0]!.timeSpec.endAt, at(TOMORROW, '20:00'));
  } finally {
    end();
  }
});

test('B4 end time (rules): a next-day range "from 10pm to 2am" ends at 02:00 the following day', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, 'Party tomorrow from 10pm to 2am', { locale: 'en' });
    const item = only(body.proposal?.items, 'overnight range');
    assert.equal(item.resolvedTime, at(TOMORROW, '22:00'), `the start is ${item.resolvedTime}`);
    assert.equal(item.endTime, at('2026-10-09', '02:00'), `the overnight end is ${item.endTime}`);
  } finally {
    end();
  }
});

test('B4 end time (rules, DST backward): «من 1 لـ 3 الصبح» on Jerusalem\'s fall-back night ends at 03:00 local (01:00Z), not start + 2h', async () => {
  // 2026-10-25: 02:00 IDT → 01:00 IST. 03:00 local is UTC+2.
  const uid = beginRules();
  try {
    const body = await chat(uid, 'شغل بكرا من 1 لـ 3 الصبح', { locale: 'ar', referenceTime: '2026-10-24T07:00:00.000Z' });
    const item = only(body.proposal?.items, 'fall-back range');
    assert.equal(item.endTime, '2026-10-25T01:00:00.000Z', `the end across the fall-back is ${item.endTime}`);
  } finally {
    end();
  }
});

test('B4 end time (rules, DST forward): an end inside Jerusalem\'s spring gap (02:30) moves forward to the first valid minute, 03:00 local (00:00Z)', async () => {
  // 2027-03-26: 02:00 IST → 03:00 IDT; 02:30 does not exist.
  const uid = beginRules();
  try {
    const body = await chat(uid, 'شغل بكرا من 1 لـ 2:30 الصبح', { locale: 'ar', referenceTime: '2027-03-25T07:00:00.000Z' });
    const item = only(body.proposal?.items, 'spring-gap range');
    assert.equal(item.endTime, '2027-03-26T00:00:00.000Z', `the end in the spring gap is ${item.endTime}`);
  } finally {
    end();
  }
});

test('B4 end time: the contradictory prompt line «Do not ask whether it is morning or evening» for a bare range is replaced', () => {
  const prompt = buildChatPrompt([{ role: 'user', text: 'اجتماع من 4 لـ 8' }], [], { now: new Date(REFERENCE), timezone: TZ }, { replyLanguage: 'ar' });
  const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
  // The old line (chatPrompt.ts:65 at 0620a7b2), hard-coded because it must go.
  assert.ok(
    !text.includes('A range "from 10 to 4", «من 10 لـ 4» is the start and the end: the item is at the start (10:00), the end is later the same day (16:00). Do not ask whether it is morning or evening.'),
    'the prompt still tells the model never to ask morning/evening for a bare early range',
  );
});

test('B4a clarification timezone: a clarification sent from another zone resolves in the stored item\'s timezone', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, 'موعد الدكتور بكرا الساعة 4', { locale: 'ar' });
    const asking = first.proposal?.items.find((item) => item.needsClarification && item.clarification);
    assert.ok(asking, `nothing asks: ${JSON.stringify(first.proposal?.items)}`);
    const answered = await clarify(uid, first.proposal!, asking!, { optionId: 'pm' }, { timezone: 'America/New_York' });
    const item = only(answered.items, 'after the answer');
    assert.equal(item.resolvedTime, at(TOMORROW, '16:00', TZ), `16:00 was read on the request's clock, not the item's: ${item.resolvedTime}`);
  } finally {
    end();
  }
});

test('B4a clarification timezone (DST boundary): proposed in Jerusalem before its fall-back, answered from New York — 16:00 Jerusalem on 2026-10-25 is 14:00Z', async () => {
  const uid = beginRules();
  try {
    const referenceTime = '2026-10-24T07:00:00.000Z';
    const first = await chat(uid, 'موعد الدكتور بكرا الساعة 4', { locale: 'ar', referenceTime });
    const asking = first.proposal?.items.find((item) => item.needsClarification && item.clarification);
    assert.ok(asking, `nothing asks: ${JSON.stringify(first.proposal?.items)}`);
    const answered = await clarify(uid, first.proposal!, asking!, { optionId: 'pm' }, { timezone: 'America/New_York', referenceTime });
    const item = only(answered.items, 'after the answer');
    assert.equal(item.resolvedTime, '2026-10-25T14:00:00.000Z', `resolved as ${item.resolvedTime}`);
  } finally {
    end();
  }
});
