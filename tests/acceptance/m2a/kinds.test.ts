/**
 * M2a Task B, criterion 1 (Kinds) — conditions 3 and 4 of the 2026-10-06
 * audit: a commitment, a goal, an idea and a consideration are told apart, and
 * «عم بفكر» is not a commitment. Only `commitment` becomes an item; the rest
 * become seeds in the person's own words. A clause with a concrete schedule
 * stays a commitment on both paths (B-004).
 *
 * Acceptance gate written independently of the builder: every test here must
 * fail on 0620a7b2 for the reason its criterion names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_PROMPT_VERSION } from '../../../lib/services/captureChat/chatPrompt.ts';
import {
  TOMORROW,
  assertUnderstoodValid,
  beginModel,
  beginRules,
  chat,
  end,
  modelFirstAnswer,
  modelItem,
} from './support.ts';

/** The time question the old reply asked a goal or a thought (chatReply.ts TEMPLATES.ar.ask, at 0620a7b2). */
const OLD_WHEN_QUESTION = 'إيمتى بدك';

test('B1 kinds (rules): «عم بفكر أسافر الصيف الجاي» is a consideration seed in the person\'s words, no item, no time question', async () => {
  const uid = beginRules();
  try {
    const message = 'عم بفكر أسافر الصيف الجاي';
    const body = await chat(uid, message, { locale: 'ar' });
    assert.ok(body.proposal, 'the consideration was dropped: no proposal');
    assert.equal(body.proposal!.items.length, 0, `a consideration became an item: ${JSON.stringify(body.proposal!.items)}`);
    assert.deepEqual(body.proposal!.seeds.map((seed) => seed.kind), ['consideration']);
    assert.ok(body.proposal!.seeds[0]!.summary.includes('أسافر الصيف الجاي'), 'the seed is not in the person\'s words');
    // «شو بدك تعمل وإيمتى؟» (TEMPLATES.ar.nothing) asks when — a time question for a thought.
    assert.ok(!/إيمتى|ايمتى|أي ساعة|أي يوم/.test(body.reply), `a consideration was asked for a time: ${body.reply}`);
  } finally {
    end();
  }
});

test('B1 kinds (rules): «حابب أنزل بالوزن» is a possible_goal seed, not a timed item', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, 'حابب أنزل بالوزن', { locale: 'ar' });
    assert.ok(body.proposal, 'the goal was dropped: no proposal');
    assert.deepEqual(
      body.proposal!.items.map((item) => item.title),
      [],
      'a goal statement became a commitment item',
    );
    assert.deepEqual(body.proposal!.seeds.map((seed) => seed.kind), ['possible_goal']);
    assert.ok(body.proposal!.seeds[0]!.summary.includes('أنزل بالوزن'), 'the seed is not in the person\'s words');
    assert.ok(!body.reply.includes(OLD_WHEN_QUESTION), `the goal was asked «إيمتى بدك…»: ${body.reply}`);
  } finally {
    end();
  }
});

test('B1 kinds (rules, guard B-004): a goal verb with a concrete schedule stays a commitment while the bare goal becomes a seed', async () => {
  // The positive half (the bare goal → seed) is what fails today; the
  // scheduled halves are the guard that the new goal-verb list must not
  // swallow a real schedule.
  const bare = beginRules();
  try {
    const body = await chat(bare, 'حابب أنزل بالوزن', { locale: 'ar' });
    assert.equal(body.proposal?.items.length ?? 0, 0, 'the bare goal «حابب أنزل بالوزن» is still an item');
    assert.deepEqual(body.proposal?.seeds.map((seed) => seed.kind), ['possible_goal']);
  } finally {
    end();
  }
  for (const scheduled of ['بدي أتعوّد أمشي كل يوم الساعة 7', 'حابب أتعلم إنجليزي بكرا الساعة 6']) {
    const uid = beginRules();
    try {
      const body = await chat(uid, scheduled, { locale: 'ar' });
      assert.ok(body.proposal, `«${scheduled}» gave no proposal`);
      assert.equal(body.proposal!.items.length, 1, `«${scheduled}» is not one commitment: ${JSON.stringify(body.proposal)}`);
      assert.equal(body.proposal!.seeds.length, 0, `«${scheduled}» became a seed`);
    } finally {
      end();
    }
  }
});

test('B1 kinds (model path, guard): a clause the model mislabels `commitment` is a consideration seed unless it carries a schedule', async () => {
  const message = 'عم بفكر أسافر الصيف الجاي، وحابب أتعلم إنجليزي بكرا الساعة 6 المسا';
  // Both mislabeled: the model calls the thought a commitment too.
  const uid = beginModel(modelFirstAnswer(
    'فهمت: بتفكر تسافر الصيف الجاي، وبدك تتعلم إنجليزي بكرا الساعة 6 المسا. أكّد من تحت.',
    'propose',
    [
      modelItem('أسافر الصيف الجاي', null, null, { kind: 'commitment' }),
      modelItem('أتعلم إنجليزي', TOMORROW, '18:00', { kind: 'commitment' }),
    ],
  ));
  try {
    const body = await chat(uid, message, { locale: 'ar' });
    assert.equal(body.engine, 'model');
    assert.ok(body.proposal, 'no proposal');
    assert.deepEqual(
      body.proposal!.items.map((item) => item.title),
      ['أتعلم إنجليزي'],
      'the guard did not take «عم بفكر أسافر» off the items, or it took the scheduled lesson with it',
    );
    assert.deepEqual(body.proposal!.seeds.map((seed) => seed.kind), ['consideration']);
    assert.ok(body.proposal!.seeds[0]!.summary.includes('أسافر الصيف الجاي'), 'the seed is not in the person\'s words');
  } finally {
    end();
  }
});

test('B1 kinds (model path): a model item of kind possible_goal / consideration / idea / waiting_for is a seed of that kind, never an item', async () => {
  const message = 'بكرا الساعة 5 المسا لازم اتصل بأمي، وحابب أنزل بالوزن، وعم بفكر أغيّر شغلي، وحلو لو نعمل رحلة للبحر، ومستني رد من المدير';
  const uid = beginModel(modelFirstAnswer(
    'فهمت خمس أشياء. أكّد من تحت.',
    'propose',
    [
      modelItem('اتصل بأمي', TOMORROW, '17:00', { kind: 'commitment' }),
      modelItem('أنزل بالوزن', null, null, { kind: 'possible_goal' }),
      modelItem('أغيّر شغلي', null, null, { kind: 'consideration' }),
      modelItem('رحلة للبحر', null, null, { kind: 'idea' }),
      modelItem('رد من المدير', null, null, { kind: 'waiting_for' }),
    ],
  ));
  try {
    const body = await chat(uid, message, { locale: 'ar' });
    assert.equal(body.engine, 'model');
    assert.ok(body.proposal, 'no proposal');
    assert.deepEqual(body.proposal!.items.map((item) => item.title), ['اتصل بأمي'], 'a non-commitment kind became an item');
    assert.deepEqual(
      body.proposal!.seeds.map((seed) => seed.kind).sort(),
      ['consideration', 'idea', 'possible_goal', 'waiting_for'],
    );
    for (const words of ['أنزل بالوزن', 'أغيّر شغلي', 'رحلة للبحر', 'رد من المدير']) {
      assert.ok(body.proposal!.seeds.some((seed) => seed.summary.includes(words)), `no seed in the person's words «${words}»`);
    }
    assertUnderstoodValid(body.proposal);
  } finally {
    end();
  }
});

test('B1 kinds: the chat prompt version is bumped past capture-chat-v5', () => {
  assert.notEqual(CHAT_PROMPT_VERSION, 'capture-chat-v5', 'the model item schema changed (kind) but the prompt version did not');
});
