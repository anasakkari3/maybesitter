/**
 * Load pass F3 (2026-10-07): «هيك فهمت» said «اتصل بالبنك» while review and
 * the saved commitment said «واتصل بالبنك». The summary dropped the «و» that
 * joined the clause to the one before it; the title kept it.
 *
 * Now the «و» is dropped once, where the item or seed is made, and only for a
 * clause that followed another whose very next word opens a point. The
 * summary shows the stored words as they are, so a title written any other
 * way (an edit, a clarification) reads the same on the card and in the
 * summary (Codex inspection F3-001, F3-002).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCaptureClauseDetails, withoutClauseJoiner } from '../../src/extraction/clauseSplitter.ts';
import { beginRules, chat, edit, editOf, end, type Answer, type Proposal } from '../acceptance/m2b/support.ts';

const LOAD_PASS = 'بكرا الساعة 10 الصبح اجتماع مع المدير، واتصل بالبنك بكرا الساعة 12، ولازم أشتري هدية لخالد بكرا الساعة 6 المسا';

/** Every summary line says exactly the words its card or seed stores. */
function assertSummaryMatchesStored(proposal: Proposal, label: string): void {
  for (const point of proposal.understood ?? []) {
    const stored = point.kind === 'commitment'
      ? proposal.items.find((item) => item.itemId === point.itemId)?.title
      : proposal.seeds.find((seed) => seed.seedItemId === (point as { seedItemId: string }).seedItemId)?.summary;
    assert.ok(stored !== undefined, `${label}: a summary line without its card`);
    assert.equal(point.text, stored, `${label}: the summary and the card say different words`);
  }
}

test('F3: the literal load-pass capture stores the titles «هيك فهمت» shows, without the joining «و»', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, LOAD_PASS, { locale: 'ar' });
    const proposal = body.proposal as Proposal;
    assert.ok(proposal, 'no proposal');
    const titles = proposal.items.map((item) => item.title);
    assert.ok(titles.includes('اتصل بالبنك'), `the bank keeps its joiner: ${JSON.stringify(titles)}`);
    assert.ok(titles.some((title) => title.startsWith('لازم') || title.startsWith('أشتري')), `the gift keeps its joiner: ${JSON.stringify(titles)}`);
    assertSummaryMatchesStored(proposal, 'load pass');
  } finally {
    end();
  }
});

test('F3: a seed said after a commitment is stored and shown without its «و»', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا، ويمكن أقدّم عالماجستير السنة الجاية', { locale: 'ar' });
    const proposal = body.proposal as Proposal;
    assert.ok(proposal.seeds.length > 0, `no seed: ${JSON.stringify(proposal)}`);
    for (const seed of proposal.seeds) assert.ok(!seed.summary.startsWith('و'), `the seed keeps its joiner: ${seed.summary}`);
    assertSummaryMatchesStored(proposal, 'seed');
  } finally {
    end();
  }
});

test('F3: an edit that writes a title with «و» reads the same on the card and in the summary', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا، وادفع الفاتورة بكرا الساعة 6 المسا', { locale: 'ar' }) as Answer;
    const second = first.proposal!.items[1]!;
    const after = await edit(uid, first.conversationId, editOf(first, { itemId: second.itemId }, { text: 'واتصل بالبنك' }), { locale: 'ar' });
    assertSummaryMatchesStored(after.proposal as Proposal, 'edited');
  } finally {
    end();
  }
});

test('F3: only a clause that followed another is marked to lose its joiner', () => {
  const clauses = splitCaptureClauseDetails(LOAD_PASS);
  assert.equal(clauses[0]!.follows, undefined);
  assert.ok(clauses.slice(1).every((clause) => clause.follows === true));
});

test('F3: the joiner goes only when the very next word opens a point (F3-001)', () => {
  assert.equal(withoutClauseJoiner('واتصل بالبنك'), 'اتصل بالبنك');
  assert.equal(withoutClauseJoiner('وأشتري خبز'), 'أشتري خبز');
  assert.equal(withoutClauseJoiner('وسجّل موعد دكتور'), 'سجّل موعد دكتور');
  assert.equal(withoutClauseJoiner('ولازم أشتري هدية'), 'لازم أشتري هدية');
  assert.equal(withoutClauseJoiner('وعم بفكر أتعلم عود'), 'عم بفكر أتعلم عود');
  assert.equal(withoutClauseJoiner('and buy bread'), 'buy bread');
  assert.equal(withoutClauseJoiner('ותקנה לחם'), 'תקנה לחם');
  // «وصّل» is the verb; «ووصّل» loses only the joining one.
  assert.equal(withoutClauseJoiner('وصّل أمي عالدكتور'), 'وصّل أمي عالدكتور');
  assert.equal(withoutClauseJoiner('ووصّل أمي عالدكتور'), 'وصّل أمي عالدكتور');
  // A «و» that is the word's own letter stays, even with a request later on.
  assert.equal(withoutClauseJoiner('وزارة الداخلية لازم أراجعها'), 'وزارة الداخلية لازم أراجعها');
  assert.equal(withoutClauseJoiner('وردة لأمي لازم أجيبها'), 'وردة لأمي لازم أجيبها');
  assert.equal(withoutClauseJoiner('ووقت الغدا'), 'ووقت الغدا');
  assert.equal(withoutClauseJoiner('וורד'), 'וורד');
  // "and" is a word of its own, so it always goes.
  assert.equal(withoutClauseJoiner('and the gym'), 'the gym');
  assert.equal(withoutClauseJoiner("and I'm thinking about travelling"), "I'm thinking about travelling");
  assert.equal(withoutClauseJoiner('ואני חושב על נסיעה'), 'אני חושב על נסיעה');
  assert.equal(withoutClauseJoiner('ויזה חדשה'), 'ויזה חדשה');
  assert.equal(withoutClauseJoiner('وظيفة جديدة'), 'وظيفة جديدة');
});

test('F3-001: a first clause is never stripped, whatever follows in it', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, 'وزارة الداخلية لازم أراجعها بكرا الساعة 10 الصبح', { locale: 'ar' });
    const titles = (body.proposal?.items ?? []).map((item) => item.title);
    assert.ok(!titles.some((title) => title.startsWith('زارة')), `a first item lost a letter: ${JSON.stringify(titles)}`);
    // Only provenance says a «و» joined two clauses: a first clause keeps
    // its words even when a verb follows the «و».
    const own = await chat(uid, 'واتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const ownTitles = (own.proposal?.items ?? []).map((item) => item.title);
    assert.ok(ownTitles.some((title) => title.startsWith('واتصل')), `a first clause lost its own «و»: ${JSON.stringify(ownTitles)}`);
  } finally {
    end();
  }
});
