import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTimeExpressions } from '../../src/extraction/ruleBasedExtractor';
import { proposeCapture } from '../../lib/services/captureBoundary/captureBoundaryService';
import { MemoryCaptureProposalStore } from '../../lib/services/captureBoundary/proposalStore';

const NOW = new Date('2026-08-22T06:00:00.000Z');

function dependencies() {
  return {
    store: new MemoryCaptureProposalStore(),
    persistence: {
      apply: async () => ({ persistedItemIds: [] as string[] }),
    } as never,
  };
}

async function propose(text: string) {
  return proposeCapture(
    text,
    { now: NOW, timezone: 'Asia/Jerusalem', scopeId: 'default', requestedEngine: 'rules' },
    dependencies(),
  );
}

test('counting clock times ignores period words and does not double-count a mention', () => {
  // 'at 9am' matches both the am-suffixed and the bare-hour shape; one mention.
  assert.equal(countTimeExpressions('Doctor at 9am, university at 2pm, then visit at 7pm'), 3);
  assert.equal(countTimeExpressions('بكرة الساعة 9 عندي دكتور وبعدها الساعة 2 عالجامعة'), 2);
  assert.equal(countTimeExpressions('Remind me to call Ahmad tomorrow at 3 PM'), 1);
  // Period words alone are not clock times: counting them would ask for
  // clarification on ordinary single-commitment input.
  assert.equal(countTimeExpressions('Pick up the kids, then buy groceries'), 0);
  assert.equal(countTimeExpressions('بكرة بدي أمرق عأمي بعد الشغل'), 0);
});

test('counting is stable across calls', () => {
  const text = 'Doctor at 9am, university at 2pm, then visit my uncle at 7pm';
  assert.equal(countTimeExpressions(text), countTimeExpressions(text));
});

test('Arabic input naming two times: no time is claimed that the words did not settle', async () => {
  const proposal = await propose('بكرة الساعة 9 عندي دكتور وبعدها الساعة 2 لازم أروح عالجامعة');
  assert.equal(proposal.items.length, 2, 'each clause is its own item');
  // The valve reads each clause against its own items (QA audit NAPI-A8.2):
  // the doctor's 9 is accounted for and stays; the university's bare 2 is
  // asked, with a question.
  assert.equal(proposal.items[0]!.needsClarification, false);
  assert.ok(proposal.items[0]!.resolvedTime);
  assert.equal(proposal.items[1]!.needsClarification, true);
  assert.ok(proposal.items[1]!.clarification);
});

test('English input naming three times that yields fewer asks, clause by clause, instead of claiming', async () => {
  const proposal = await propose('Doctor at 9am, university at 2pm, then visit my uncle at 7pm');
  // "Doctor at 9am, university at 2pm" is one clause naming two times and
  // read as one item: that item asks. "visit my uncle at 7pm" lost nothing
  // and keeps its hour (NAPI-A8.2: one clause's loss is not the list's).
  const merged = proposal.items.find((item) => /doctor/i.test(item.title))!;
  const uncle = proposal.items.find((item) => /uncle/i.test(item.title))!;
  assert.equal(merged.needsClarification, true, 'times were dropped and the item still claimed confidence');
  assert.ok(merged.clarification, 'the item that asks has a question');
  assert.equal(uncle.needsClarification, false);
  assert.ok(uncle.resolvedTime);
});

test('input naming no clock time is left alone by the valve', async () => {
  const proposal = await propose('Pick up the kids, then buy groceries before the shop closes');
  assert.ok(proposal.items.length > 0);
  // Whatever the extractor decided stands; the valve has no opinion here.
  assert.equal(
    proposal.items.some((item) => item.resolvedTime !== null) ||
      proposal.items.every((item) => item.needsClarification),
    true,
  );
});

test('a single time fully accounted for is not forced to clarify', async () => {
  const proposal = await propose('Remind me to call Ahmad tomorrow at 3 PM');
  assert.equal(proposal.items.length, 1);
  assert.equal(
    proposal.items[0].needsClarification,
    false,
    'the valve asked for clarification on input it fully understood',
  );
  assert.ok(proposal.items[0].resolvedTime, 'expected a resolved time');
});

test('a from-to range names one time, not two', () => {
  // The start and the end of a range are one appointment. Counting both made
  // the valve strip the time from "meeting from 14:00 to 15:00" and ask about
  // a sentence that was already clear.
  assert.equal(countTimeExpressions('meeting from 14:00 to 15:00'), 1);
  assert.equal(countTimeExpressions('meeting from 2pm to 3pm'), 1);
  assert.equal(countTimeExpressions('اجتماع من الساعة 2 للساعة 4'), 1);
});

test('a range plus a separate time is still two', () => {
  assert.equal(countTimeExpressions('from 9:00 to 10:00 gym, then dinner at 8pm'), 2);
});

test('a from-to range is proposed at its start instead of sent back for clarification', async () => {
  const p = await propose('meeting from 14:00 to 15:00');
  assert.equal(p.status, 'proposed');
  assert.equal(p.items[0].needsClarification, false);
  assert.ok(p.items[0].resolvedTime);
});

test('Hebrew extraction failure stays fail-safe rather than becoming confident', async () => {
  const proposal = await propose('מחר בשמונה רופא ואחר כך בשתיים אוניברסיטה');
  for (const item of proposal.items) {
    if (!item.needsClarification) {
      assert.ok(item.resolvedTime, 'a confident item must carry the time it claims');
    }
  }
});

test('spoken Arabic hours are counted like typed ones', () => {
  // Speech-to-text writes «الساعة تسعة», not «الساعة 9». Counting digits only
  // saw no time at all, so a voice sentence naming two times could come back
  // as one confident commitment.
  assert.equal(countTimeExpressions('بكرا الساعة تسعة دكتور وبعدين الساعة تلاتة الجامعة'), 2);
});

test('splitInput: Arabic and Hebrew connectors separate two commitments (#162)', async () => {
  const { proposeCapture, MemoryCaptureProposalStore, TransactionalCapturePersistenceAdapter } =
    await import('../../lib/services/captureBoundary/index.ts');
  const { createEmptyDomainState } = await import('../../src/domain/stateMachine.ts');

  // «وبعدين» is "and then". Before #162 only English connectors were read, so
  // this arrived as one segment, the extractor's non-global time match kept the
  // first time and dropped the second, and the safety valve turned the whole
  // capture into a clarification — safe, but the product failing to read an
  // entirely ordinary sentence.
  const proposal = await proposeCapture(
    'بكرة الساعة 9 الصبح عندي دكتور وبعدين الساعة 3 العصر عندي جامعة',
    { now: new Date('2026-09-13T06:00:00.000Z'), timezone: 'Asia/Jerusalem', scopeId: 'seg', requestedEngine: 'rules' },
    {
      store: new MemoryCaptureProposalStore(),
      persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
    },
  );

  assert.equal(proposal.items.length, 2, 'two appointments, two items');
  assert.equal(
    proposal.items.filter((item) => item.resolvedTime !== null).length,
    2,
    'both times survived segmentation',
  );
});

test('splitInput: a bare «و» is not a connector (#162)', async () => {
  const { proposeCapture, MemoryCaptureProposalStore, TransactionalCapturePersistenceAdapter } =
    await import('../../lib/services/captureBoundary/index.ts');
  const { createEmptyDomainState } = await import('../../src/domain/stateMachine.ts');

  // «و» joins words far more often than clauses. Splitting on it would turn one
  // errand into two commitments with half a sentence each.
  const proposal = await proposeCapture(
    'بكرة الساعة 5 العصر بدي أحكي مع أحمد وسامي',
    { now: new Date('2026-09-13T06:00:00.000Z'), timezone: 'Asia/Jerusalem', scopeId: 'seg2', requestedEngine: 'rules' },
    {
      store: new MemoryCaptureProposalStore(),
      persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
    },
  );

  assert.equal(proposal.items.length, 1, 'one errand naming two people is one commitment');
});
