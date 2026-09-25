/**
 * A message that asks for nothing creates nothing (UC-2.6, #166).
 *
 * "Nothing" is a list, and it is the whole point of this file: no commitment, no
 * command, no confirmable item, no note with the sentence as its title, and no
 * event beyond the audit line that already existed. Each of those is asserted
 * separately, because "no commitment" was true before this issue while three of
 * the others were not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessageKind, createsNothing } from '../../src/extraction/messageKind.ts';
import { extract } from '../../src/extraction/ruleBasedExtractor.ts';
import { decideExtractionDisposition } from '../../src/extraction/extractionPolicy.ts';
import { mapExtractionToCommand } from '../../src/extraction/mapExtractionToCommand.ts';
import { proposeCapture, MemoryCaptureProposalStore, TransactionalCapturePersistenceAdapter, confirmCapture } from '../../lib/services/captureBoundary/index.ts';
import { guardedMobileExtract, NegatedRequestError } from '../../lib/services/mobile/safety.ts';
import { createEmptyDomainState, type Command } from '../../src/domain/stateMachine.ts';
import type { AuditEventEnvelope } from '../../src/contracts/v1/runtimeControls.ts';

const context = { now: new Date('2026-09-14T10:00:00+03:00'), timezone: 'Asia/Jerusalem' };

/** One case per kind, in each of the three languages plus a mix. */
const NOTHING: Array<[string, string, string]> = [
  ['greeting en', 'good morning', 'greeting_or_chat'],
  ['greeting ar', 'صباح الخير', 'greeting_or_chat'],
  ['greeting he', 'בוקר טוב', 'greeting_or_chat'],
  ['chat en', 'hey how are you', 'greeting_or_chat'],
  ['chat ar', 'كيفك شو الأخبار', 'greeting_or_chat'],
  ['question en', "what's the weather tomorrow?", 'question'],
  ['question ar', 'شو الطقس بكرا؟', 'question'],
  ['question he', 'מה השעה?', 'question'],
  ['question mixed', 'شو رأيك بالـ app؟', 'question'],
  ['question ar no mark', 'متى الاجتماع', 'question'],
  ['question he no mark', 'מתי הפגישה', 'question'],
  ['feeling en', 'feeling pretty tired lately', 'informational'],
  ['feeling ar', 'حسّيت بضغط اليوم من الشغل', 'informational'],
  ['feeling he', 'אני מרגיש עייף היום', 'informational'],
  ['news ar', 'الأسعار زادت هالشهر', 'informational'],
  ['past en', 'i met Ahmad yesterday at 7', 'past_event'],
  ['past ar', 'مبارح شفت أحمد بالسوق', 'past_event'],
  ['past he', 'אתמול ראיתי את דוד', 'past_event'],
  ['forwarded', 'FWD: the meeting was cancelled last week', 'past_event'],
  ['negated en', "don't remind me anymore", 'negated_request'],
  ['negated ar', 'لا تذكرني بالجيم بعد اليوم', 'negated_request'],
  ['negated ar fem', 'لا تذكريني بالجيم بعد اليوم', 'negated_request'],
  ['negated ar dialect', 'ما بدي تذكير بهالموضوع', 'negated_request'],
  ['negated he', 'אל תזכיר לי יותר על החדר כושר', 'negated_request'],
  ['negated he fem', 'אל תזכירי לי יותר על החדר כושר', 'negated_request'],
  ['negated mixed', 'תזכיר לי not to worry about it', 'negated_request'],
];

/** Things that must still become commitments. The other half of the promise. */
const SOMETHING: string[] = [
  'remind me tomorrow at 4pm to email the landlord',
  'ذكرني بكرة الساعة ٧ مساءً أحكي مع أحمد',
  'תזכיר לי מחר בערב לשלם את החשבון',
  'buy milk',
  'call the clinic tomorrow at 9',
  // A request phrased as a question is a request. Reading it as a question
  // would silently create nothing for the most natural way to ask.
  'can you remind me to call the clinic tomorrow at 9?',
  'صباح الخير، ذكرني بكرة الساعة ٩ عندي دكتور',
];

test('createNothing: every kind is classified, in three languages', () => {
  for (const [label, message, expected] of NOTHING) {
    assert.equal(classifyMessageKind(message), expected, `${label}: ${message}`);
    assert.equal(createsNothing(classifyMessageKind(message)), true, label);
  }
});

test('createNothing: a request stays a request, however it is phrased', () => {
  for (const message of SOMETHING) {
    assert.equal(classifyMessageKind(message), 'request', message);
  }
});

test('createNothing: the extractor produces no title and no time', () => {
  for (const [label, message] of NOTHING) {
    const result = extract(message, context);

    assert.ok(result.type === 'informational_context' || result.type === 'unknown', `${label} type=${result.type}`);
    // Echoing the sentence back as a title is how «صباح الخير» became a
    // commitment titled "الخير".
    assert.equal(result.title, null, `${label} kept a title`);
    assert.equal(result.action, null, `${label} kept an action`);
    assert.equal(result.dueAt, null, label);
    assert.equal(result.remindAt, null, label);
    assert.equal(result.localTimeSpec, null, label);
  }
});

test('createNothing: no command is produced, so there is nothing to persist', () => {
  for (const [label, message] of NOTHING) {
    const result = extract(message, context);
    const commands = mapExtractionToCommand(result, context.now.toISOString());
    assert.deepEqual(commands, [], `${label} produced ${commands.length} command(s)`);
  }
});

test('createNothing: none of them asks a clarification question', () => {
  // Answering "don't remind me about the gym" with a question about the gym is
  // the product doing the thing it was told not to do.
  for (const [label, message] of NOTHING) {
    const disposition = decideExtractionDisposition(extract(message, context));
    assert.notEqual(disposition, 'needs_clarification', `${label} asks a question`);
    assert.notEqual(disposition, 'auto_confirm', `${label} auto-confirms`);
  }
});

async function propose(text: string, audit?: (event: AuditEventEnvelope) => void) {
  const store = new MemoryCaptureProposalStore();
  const persisted: Command[][] = [];
  const contract = await proposeCapture(text, {
    now: context.now,
    timezone: context.timezone,
    scopeId: 'nothing-test',
    requestedEngine: 'rules',
  }, {
    store,
    persistence: {
      persistAtomically: async (commands) => {
        persisted.push([...commands]);
        return { state: createEmptyDomainState() };
      },
      snapshot: async () => createEmptyDomainState(),
    },
    extractor: guardedMobileExtract,
    ...(audit ? { audit } : {}),
  });
  return { contract, store, persisted };
}

test('createNothing: the boundary answers no_commitment with a reason, and no items', async () => {
  for (const [label, message, kind] of NOTHING) {
    const { contract } = await propose(message);

    assert.equal(contract.status, 'no_commitment', `${label} status=${contract.status}`);
    assert.deepEqual(contract.items, [], label);
    assert.equal(contract.noCommitmentReason, kind, `${label} reason=${contract.noCommitmentReason}`);
  }
});

test('createNothing: a no_commitment proposal cannot be confirmed', async () => {
  const { contract, store, persisted } = await propose('good morning');

  const result = await confirmCapture({
    proposalId: contract.proposalId,
    scopeId: 'nothing-test',
    // There is nothing to select, so this is the strongest form of the attempt:
    // a client asking to confirm an id that does not exist on it.
    selectedItemIds: ['anything'],
    idempotencyKey: 'k1',
  }, {
    store,
    persistence: {
      persistAtomically: async () => ({ state: createEmptyDomainState() }),
      snapshot: async () => createEmptyDomainState(),
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'proposal_rejected');
  assert.deepEqual(result.persistedItemIds, []);
  assert.deepEqual(persisted, [], 'nothing may be persisted');
});

test('createNothing: the only record is the audit line that already existed', async () => {
  const events: AuditEventEnvelope[] = [];
  await propose('حسّيت بضغط اليوم من الشغل', (event) => events.push(event));

  // One module_execution line, carrying a hash and a length — never the text.
  assert.equal(events.length, 1);
  const fields = events[0]!.fields as unknown as Record<string, unknown>;
  assert.equal(events[0]!.eventType, 'module_execution');
  // `fell_back` because this run asked for rules outright; either is an
  // ordinary outcome and neither is a rejection.
  assert.ok(fields.outcome === 'succeeded' || fields.outcome === 'fell_back', `outcome=${fields.outcome}`);
  assert.equal(fields.reasonCode, 'no_commitment');
  assert.equal(fields.itemCount, 0);
  assert.equal(typeof fields.inputHash, 'string');
  assert.equal(typeof fields.inputLength, 'number');

  // Nothing anywhere in the envelope may carry what the person wrote.
  const serialized = JSON.stringify(events[0]);
  for (const fragment of ['حسّيت', 'بضغط', 'الشغل']) {
    assert.ok(!serialized.includes(fragment), `the audit event carries "${fragment}"`);
  }
});

test('createNothing: a negated request is refused by type, not by message', async () => {
  // The boundary has to tell "understood and refused" from "malformed", and a
  // bare Error could not carry that.
  await assert.rejects(
    () => guardedMobileExtract("don't remind me anymore", context),
    (error: unknown) => {
      assert.ok(error instanceof NegatedRequestError, `got ${(error as Error)?.name}`);
      return true;
    },
  );
});

test('createNothing: a negated request is refused in Arabic, Hebrew, and English (#401)', async () => {
  const dummyExtractor = async (text: string) => ({
    result: {
      ...extract(text, context),
      type: 'task' as const,
      action: text,
      title: text,
      confidence: { overall: 0.9, type: 0.9, action: 0.9, time: 0.9, priority: 0.9 },
      ambiguityFlags: [],
    },
    engine: 'ollama' as const,
    fallbackReason: null,
  });

  for (const text of [
    "don't remind me anymore",
    'لا تذكرني بالجيم بعد اليوم',
    'لا تذكريني بالجيم بعد اليوم',
    'ما بدي تذكير بهالموضوع',
    'אל תזכיר לי יותר על החדר כושר',
    'אל תזכירי לי יותר על החדר כושר',
    'תזכיר לי not to worry about it',
  ]) {
    await assert.rejects(
      () => guardedMobileExtract(text, context, {}, dummyExtractor),
      (error: unknown) => {
        assert.ok(error instanceof NegatedRequestError, `${text}: got ${(error as Error)?.name}`);
        return true;
      },
    );
  }

  const innocentAr = await guardedMobileExtract('ذكرني بالجيم بكرا', context, {}, dummyExtractor);
  assert.equal(innocentAr.result.title, 'ذكرني بالجيم بكرا');

  const innocentHe = await guardedMobileExtract('תזכיר לי מחר על החדר כושר', context, {}, dummyExtractor);
  assert.equal(innocentHe.result.title, 'תזכיר לי מחר על החדר כושר');
});

test('createNothing: a greeting that also carries a request keeps the request', async () => {
  // The failure mode in both directions: a greeting must not swallow the ask,
  // and the ask must not make the greeting a task.
  const { contract } = await propose('صباح الخير، ذكرني بكرة الساعة ٩ عندي دكتور');

  assert.equal(contract.status, 'proposed');
  assert.equal(contract.items.length, 1);
  assert.ok(!contract.items[0]!.title.includes('صباح'), `title kept the greeting: ${contract.items[0]!.title}`);
});
