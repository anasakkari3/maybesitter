import test from 'node:test';
import assert from 'node:assert/strict';
import { decideExtractionDisposition } from '../../src/extraction/extractionPolicy.ts';
import { extractAndMap } from '../../src/extraction/extractionService.ts';
import { mapExtractionToCommand } from '../../src/extraction/mapExtractionToCommand.ts';
import { extract } from '../../src/extraction/ruleBasedExtractor.ts';

const context = { now: new Date('2026-04-08T08:00:00.000Z'), timezone: 'UTC' };

const cases = [
  // "tomorrow" with no hour. This used to auto-confirm 18:00 — an hour nobody
  // said — and now asks instead (#162).
  ['Remind me to call Maya tomorrow', 'task', 'needs_clarification', ['CreateDraft']],
  ['Remind me to call Maya tomorrow at 6pm', 'task', 'auto_confirm', ['CreateDraft', 'ConfirmCommitment']],
  ['Remind me to send invoice today at 4pm', 'task', 'auto_confirm', ['CreateDraft', 'ConfirmCommitment']],
  ['Follow up with Daniel about lease tomorrow at 4pm', 'follow_up', 'pending_confirmation', ['CreateDraft']],
  ['Call mom', 'task', 'needs_clarification', ['CreateDraft']],
  ['Please remind me to email Alex at 3pm', 'task', 'auto_confirm', ['CreateDraft', 'ConfirmCommitment']],
  ['I need to submit report Friday at 5pm', 'task', 'pending_confirmation', ['CreateDraft']],
  ['Maya is waiting on the invoice', 'informational_context', 'store_note', []],
  ['I should probably call Amir', 'task', 'store_note', []],
  ['Remind me to text Sam tonight', 'task', 'auto_confirm', ['CreateDraft', 'ConfirmCommitment']],
  ['Follow up with Noa tomorrow at 11am', 'follow_up', 'pending_confirmation', ['CreateDraft']],
  // Not a task. The user asked *not* to be reminded, and answering that with a
  // task — even a stored-note one — is the product doing the thing it was told
  // not to do (#166).
  ["Don't remind me to call mom tomorrow", 'unknown', 'store_note', []],
] as const;

test('extraction: 10 sample inputs map to expected commands', () => {
  for (const [input, expectedType, expectedDisposition, expectedCommands] of cases) {
    const result = extract(input, context);
    const disposition = decideExtractionDisposition(result);
    const commands = mapExtractionToCommand(result, '2026-04-08T08:00:00.000Z');

    assert.equal(result.type, expectedType, input);
    assert.equal(disposition, expectedDisposition, input);
    assert.deepEqual(commands.map((command) => command.type), expectedCommands, input);
  }
});

test('extraction: informational input is not mapped to a task draft', () => {
  const result = extract('Maya is waiting on the invoice', context);
  const commands = mapExtractionToCommand(result, '2026-04-08T08:00:00.000Z');

  assert.equal(result.type, 'informational_context');
  assert.deepEqual(commands, []);
});

test('extraction: Arabic reminder timing cleans title and maps explicit priority', () => {
  const result = extract('ذكرني ادفع الفاتورة بكرا الصبح ضروري', context);
  const reminder = new Date(result.remindAt || '');

  assert.equal(result.type, 'task');
  assert.equal(result.title, 'ادفع الفاتورة');
  assert.equal(result.priority.level, 'high');
  assert.equal(result.priority.source, 'user_explicit');
  assert.equal(result.explicitReminderRequest, true);
  // timezone: 'UTC' → tomorrow 9:00 UTC exactly (host-timezone independent).
  assert.equal(reminder.toISOString(), '2026-04-09T09:00:00.000Z');
  assert.equal(decideExtractionDisposition(result), 'auto_confirm');
});

test('extraction: Arabic low-priority timing stays soft and uses the right date phrase', () => {
  const result = extract('ذكرني اقرأ فصل بعد بكرا المسا يمكن', context);
  const reminder = new Date(result.remindAt || '');

  assert.equal(result.type, 'task');
  assert.equal(result.title, 'اقرأ فصل');
  assert.equal(result.priority.level, 'low');
  assert.equal(result.priority.source, 'inferred');
  assert.equal(result.flexibility, 'soft');
  // day after tomorrow, 18:00 UTC.
  assert.equal(reminder.toISOString(), '2026-04-10T18:00:00.000Z');
  assert.equal(decideExtractionDisposition(result), 'pending_confirmation');
});

test('extraction: Arabic clock phrases and digits are kept out of the title', () => {
  const result = extract('ذكرني اروح النادي الساعة ٥ مساء', context);
  const reminder = new Date(result.remindAt || '');

  assert.equal(result.type, 'task');
  assert.equal(result.title, 'اروح النادي');
  // 5 PM today in UTC.
  assert.equal(reminder.toISOString(), '2026-04-08T17:00:00.000Z');
  assert.equal(decideExtractionDisposition(result), 'auto_confirm');
});

test('extraction: 24-hour ranges use the start time and keep the action title clean', () => {
  const result = extract('Remind me to go to work from 17:00 to 22:00', context);
  const reminder = new Date(result.remindAt || '');

  assert.equal(result.type, 'task');
  assert.equal(result.title, 'go to work');
  assert.equal(reminder.toISOString(), '2026-04-08T17:00:00.000Z');
  assert.equal(decideExtractionDisposition(result), 'auto_confirm');
});

test('extraction: relative times resolve identically regardless of host timezone (regression)', () => {
  // The same phrase in two different context timezones must produce the
  // correct absolute instants, independent of the machine's local timezone.
  const utcResult = extract('Remind me to call Maya tomorrow at 10am', { now: new Date('2026-08-10T08:00:00.000Z'), timezone: 'UTC' });
  const jerusalemResult = extract('Remind me to call Maya tomorrow at 10am', { now: new Date('2026-08-10T08:00:00.000Z'), timezone: 'Asia/Jerusalem' });

  assert.equal(utcResult.remindAt, '2026-08-11T10:00:00.000Z');
  // 10:00 Asia/Jerusalem (UTC+3 in August) == 07:00 UTC.
  assert.equal(jerusalemResult.remindAt, '2026-08-11T07:00:00.000Z');
  // And the two must differ by exactly 3 hours.
  const deltaMs = Date.parse(utcResult.remindAt || '') - Date.parse(jerusalemResult.remindAt || '');
  assert.equal(deltaMs, 3 * 60 * 60 * 1_000);
});

test('extractionService: valid LLM output is primary', async () => {
  const output = {
    type: 'task',
    action: 'call Maya',
    title: 'Call Maya',
    person: 'Maya',
    dueAt: '2026-04-09T18:00:00.000Z',
    remindAt: '2026-04-09T18:00:00.000Z',
    priority: {
      level: 'normal',
      source: 'default',
      pressureAllowed: false,
      pressureImplied: false,
    },
    flexibility: 'movable',
    confidence: {
      overall: 0.92,
      type: 0.95,
      action: 0.95,
      time: 0.95,
      priority: 0.8,
    },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: true,
    explicitPressureRequest: false,
  };

  // The input names the hour the fixture returns. It used to say only
  // "tomorrow" while the fixture answered 18:00, so the reconciler would now
  // strip that time as invented — correctly, but this test is about the model
  // answer being preferred, not about time parsing (#162).
  const mapped = await extractAndMap('Remind me to call Maya tomorrow at 6pm', context, {
    llmProvider: async () => JSON.stringify(output),
  });

  assert.equal(mapped.engine, 'ollama');
  assert.equal(mapped.fallbackReason, null);
  assert.equal(mapped.result.parserVersion, 'capture-v2');
  assert.equal(mapped.disposition, 'auto_confirm');
  assert.deepEqual(mapped.commands.map((command) => command.type), ['CreateDraft', 'ConfirmCommitment']);
});

test('extractionService: invalid JSON falls back to rule-based', async () => {
  const mapped = await extractAndMap('Remind me to call Maya tomorrow at 6pm', context, {
    llmProvider: async () => 'not-json',
  });

  assert.equal(mapped.engine, 'rule-based');
  assert.match(mapped.fallbackReason || '', /JSON/);
  assert.equal(mapped.result.parserVersion, 'rule-v1-core');
  assert.deepEqual(mapped.commands.map((command) => command.type), ['CreateDraft', 'ConfirmCommitment']);
});

test('extractionService: Ollama unavailable falls back to rule-based', async () => {
  const mapped = await extractAndMap('Remind me to call Maya tomorrow', context, {
    llmProvider: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });

  assert.equal(mapped.engine, 'rule-based');
  assert.match(mapped.fallbackReason || '', /ECONNREFUSED/);
  assert.equal(mapped.result.parserVersion, 'rule-v1-core');
});

test('extractionService: negation blocks auto-confirm even if LLM claims reminder', async () => {
  const output = {
    type: 'task',
    action: 'call mom',
    title: 'Call mom',
    person: null,
    dueAt: '2026-04-09T18:00:00.000Z',
    remindAt: '2026-04-09T18:00:00.000Z',
    priority: {
      level: 'normal',
      source: 'default',
      pressureAllowed: true,
      pressureImplied: false,
    },
    flexibility: 'movable',
    confidence: {
      overall: 0.99,
      type: 0.99,
      action: 0.99,
      time: 0.99,
      priority: 0.8,
    },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: true,
    explicitPressureRequest: false,
  };

  const mapped = await extractAndMap("Don't remind me to call mom tomorrow", context, {
    llmProvider: async () => JSON.stringify(output),
  });

  assert.equal(mapped.engine, 'ollama');
  assert.equal(mapped.result.explicitReminderRequest, false);
  assert.equal(mapped.result.priority.pressureAllowed, false);
  assert.equal(mapped.disposition, 'store_note');
  assert.deepEqual(mapped.commands, []);
});

test('extractionService: informational LLM output creates no commands', async () => {
  const output = {
    type: 'informational_context',
    action: null,
    title: 'Maya is waiting on the invoice',
    person: 'Maya',
    dueAt: null,
    remindAt: null,
    priority: {
      level: 'normal',
      source: 'default',
      pressureAllowed: false,
      pressureImplied: false,
    },
    flexibility: 'soft',
    confidence: {
      overall: 0.9,
      type: 0.9,
      action: 0.1,
      time: 0.1,
      priority: 0.5,
    },
    missingFields: ['action', 'time'],
    ambiguityFlags: ['informational_without_action'],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
  };

  const mapped = await extractAndMap('Maya is waiting on the invoice', context, {
    llmProvider: async () => JSON.stringify(output),
  });

  assert.equal(mapped.engine, 'ollama');
  assert.equal(mapped.disposition, 'store_note');
  assert.deepEqual(mapped.commands, []);
});

test('extractionService: malformed LLM output falls back', async () => {
  const mapped = await extractAndMap('Remind me to call Maya tomorrow', context, {
    llmProvider: async () => JSON.stringify({ type: 'calendar_magic', title: 'Call Maya' }),
  });

  assert.equal(mapped.engine, 'rule-based');
  assert.match(mapped.fallbackReason || '', /Invalid or missing extraction type/);
  assert.equal(mapped.result.parserVersion, 'rule-v1-core');
});

test('extractionService: invalid LLM dates fall back', async () => {
  const mapped = await extractAndMap('Remind me to call Maya tomorrow', context, {
    llmProvider: async () => JSON.stringify({
      type: 'task',
      action: 'call Maya',
      title: 'Call Maya',
      person: 'Maya',
      dueAt: 'not-a-date',
      remindAt: '2026-04-09T18:00:00.000Z',
      priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
      flexibility: 'movable',
      confidence: { overall: 0.9, type: 0.9, action: 0.9, time: 0.9, priority: 0.8 },
      missingFields: [],
      ambiguityFlags: [],
      explicitReminderRequest: true,
      explicitPressureRequest: false,
    }),
  });

  assert.equal(mapped.engine, 'rule-based');
  assert.match(mapped.fallbackReason || '', /dueAt must be a valid date/);
});

test('extraction: an embedded Arabic day phrase leaves no hole in the title', () => {
  // Arabic puts the day inside the sentence — «يوم الأحد الجاي» — where English
  // trails it. Removing only the day name used to leave «يوم ... الجاي» behind,
  // so the user saw their own sentence come back with a word missing.
  const result = extract('عندي محاضرة إحصاء يوم الأحد الجاي', context);

  assert.equal(result.title, 'عندي محاضرة إحصاء');
  // «يوم الأحد الجاي» names a day and no hour, so there is no instant to
  // resolve — inventing one is what #162 removed. The day itself survives on
  // `localTimeSpec`, which is what the clarification step asks about.
  assert.equal(result.remindAt, null);
  assert.equal(result.timeEvidence, 'day_only');
  assert.equal(new Date(`${result.localTimeSpec?.date}T00:00:00Z`).getUTCDay(), 0, 'still resolves to Sunday');
});

test('extraction: a trailing Arabic day phrase still cleans the title', () => {
  const result = extract('ذكرني أسلّم التقرير يوم الخميس الجاي', context);

  assert.equal(result.title, 'أسلّم التقرير');
  assert.equal(result.remindAt, null);
  assert.equal(new Date(`${result.localTimeSpec?.date}T00:00:00Z`).getUTCDay(), 4, 'still resolves to Thursday');
});

test('extraction: spoken Arabic hour words resolve like digits', () => {
  // Speech-to-text returns «الساعة تسعة», never «الساعة ٩». If only digits
  // parse, every voice capture loses its time.
  const spoken = extract('ذكرني أراجع إحصاء الساعة تسعة الصبح', context);
  const digits = extract('ذكرني أراجع إحصاء الساعة ٩ الصبح', context);

  assert.equal(spoken.remindAt, digits.remindAt);
  assert.equal(new Date(spoken.remindAt || '').getUTCHours(), 9);
});

test('extraction: a spoken evening hour takes the PM branch', () => {
  const result = extract('ذكرني أسلّم التقرير الساعة ثلاثة المسا', context);

  assert.equal(new Date(result.remindAt || '').getUTCHours(), 15);
});

test('extraction: a spoken hour is kept out of the title, like a digit is', () => {
  const result = extract('ذكرني أراجع إحصاء بكرا الساعة تسعة الصبح', context);

  assert.equal(result.title, 'أراجع إحصاء');
});

test('extraction: spoken Hebrew hour words resolve like digits', () => {
  // Speech-to-text returns «בשעה תשע», never «בשעה 9». If only digits
  // parse, every voice capture loses its time (#512).
  const spoken = extract('תזכיר לי לחזור על החומר בשעה תשע בבוקר', context);
  const digits = extract('תזכיר לי לחזור על החומר בשעה 9 בבוקר', context);

  assert.equal(spoken.remindAt, digits.remindAt);
  assert.equal(new Date(spoken.remindAt || '').getUTCHours(), 9);
});

test('extraction: a spoken Hebrew evening hour takes the PM branch', () => {
  const result = extract('תזכיר לי להגיש את הדוח בשעה שלוש בצהריים', context);

  assert.equal(new Date(result.remindAt || '').getUTCHours(), 15);
});

test('extraction: a spoken Hebrew hour is kept out of the title, like a digit is', () => {
  const result = extract('תזכיר לי לחזור על החומר מחר בשעה תשע בבוקר', context);

  assert.equal(result.title, 'לחזור על החומר');
});

test('extraction: short Hebrew capture with time auto-confirms instead of asking clarification', () => {
  const result = extract('תזכיר לי לחזור על החומר בשעה תשע בבוקר', context);
  const disposition = decideExtractionDisposition(result);

  assert.equal(disposition, 'auto_confirm');
});

test('extraction: Hebrew weekday phrase resolves to expected day and cleans title', () => {
  const result = extract('תזכיר לי לחזור על החומר ביום ראשון בשעה תשע בבוקר', context);

  assert.equal(result.title, 'לחזור על החומר');
  assert.equal(new Date(result.remindAt || '').getUTCDay(), 0, 'resolves to Sunday');
  assert.equal(new Date(result.remindAt || '').getUTCHours(), 9);
});


