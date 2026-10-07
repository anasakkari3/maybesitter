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
import { TOMORROW, beginModel, beginRules, chat, edit, editOf, end, modelFirstAnswer, modelItem, modelRefAnswer, type Answer, type Proposal } from '../acceptance/m2b/support.ts';

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
    // Before a verb the «و» stays (no lexicon tells «واتصل» from «ورد»), and
    // the summary says it too; before a request it goes.
    assert.ok(titles.includes('واتصل بالبنك'), `the bank's title changed: ${JSON.stringify(titles)}`);
    assert.ok(titles.some((title) => title.startsWith('لازم') || title.startsWith('أشتري')), `the gift keeps its joiner: ${JSON.stringify(titles)}`);
    assertSummaryMatchesStored(proposal, 'load pass');
  } finally {
    end();
  }
});

test('F3-007: a seed said after a commitment keeps the person\'s segment verbatim, and its line says the same', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا، ويمكن أقدّم عالماجستير السنة الجاية', { locale: 'ar' });
    const proposal = body.proposal as Proposal;
    assert.ok(proposal.seeds.length > 0, `no seed: ${JSON.stringify(proposal)}`);
    // A seed's summary is its capture evidence, verbatim (intentContracts.ts).
    assert.ok(proposal.seeds.some((seed) => seed.summary.startsWith('ويمكن')), `the seed was rewritten: ${JSON.stringify(proposal.seeds)}`);
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
  // Before a verb: kept — «ورد» (roses) would read as «رد» (reply) (F3-009).
  assert.equal(withoutClauseJoiner('واتصل بالبنك'), 'واتصل بالبنك');
  assert.equal(withoutClauseJoiner('وأشتري خبز'), 'وأشتري خبز');
  assert.equal(withoutClauseJoiner('ورد لأمي'), 'ورد لأمي');
  // Before a request or an intent: certain, so dropped.
  assert.equal(withoutClauseJoiner('وسجّل موعد دكتور'), 'سجّل موعد دكتور');
  assert.equal(withoutClauseJoiner('ولازم أشتري هدية'), 'لازم أشتري هدية');
  assert.equal(withoutClauseJoiner('وعم بفكر أتعلم عود'), 'عم بفكر أتعلم عود');
  assert.equal(withoutClauseJoiner('and buy bread'), 'buy bread');
  // An attached Hebrew «ו» goes only before a request or an intent (F3-008).
  assert.equal(withoutClauseJoiner('ותקנה לחם'), 'ותקנה לחם');
  assert.equal(withoutClauseJoiner('וטרינר לחתול'), 'וטרינר לחתול');
  assert.equal(withoutClauseJoiner('וצריך לקנות לחם'), 'צריך לקנות לחם');
  // A verb after «و» — its own («وصّل») or a joined one («ووصّل») — is never read.
  assert.equal(withoutClauseJoiner('وصّل أمي عالدكتور'), 'وصّل أمي عالدكتور');
  assert.equal(withoutClauseJoiner('ووصّل أمي عالدكتور'), 'ووصّل أمي عالدكتور');
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
  // Every opener the intent reader knows, at the very start (F3-005)…
  assert.equal(withoutClauseJoiner('وبستنى رد الدكتور'), 'بستنى رد الدكتور');
  assert.equal(withoutClauseJoiner('وربما أغيّر شغلي'), 'ربما أغيّر شغلي');
  assert.equal(withoutClauseJoiner('وناوي أتعلم عزف'), 'ناوي أتعلم عزف');
  assert.equal(withoutClauseJoiner('ويوم من الأيام بدي أسافر'), 'يوم من الأيام بدي أسافر');
  assert.equal(withoutClauseJoiner('ואנחנו מחכים לתשובה'), 'אנחנו מחכים לתשובה');
  // …but not one later in a word's own clause.
  assert.equal(withoutClauseJoiner('وزارة بستنى ردها'), 'وزارة بستنى ردها');
  // The conjunction's own vowel mark goes with it (F3-006).
  assert.equal(withoutClauseJoiner('وَلازم أشتري هدية'), 'لازم أشتري هدية');
  // Marks inside the opener are folded for reading and kept in the words (F3-010).
  assert.equal(withoutClauseJoiner('وَلَازِم أشتري'), 'لَازِم أشتري');
  assert.equal(withoutClauseJoiner('וְצָרִיךְ לקנות'), 'צָרִיךְ לקנות');
  assert.equal(withoutClauseJoiner('וְצריך לקנות לחם'), 'צריך לקנות לחם');
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
    const own = await chat(uid, 'ولازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const ownTitles = (own.proposal?.items ?? []).map((item) => item.title);
    assert.ok(!ownTitles.some((title) => title.startsWith('لازم')), `a first clause lost its own «و»: ${JSON.stringify(ownTitles)}`);
  } finally {
    end();
  }
});

/* ── the model's path (production): Codex inspection F3-003 ── */

test('F3-003: on the model path a new follower point loses a certain «و», and the summary says what is stored', async () => {
  const message = 'لازم اتصل بأمي بكرا الساعة 5 المسا، ولازم أدفع الفاتورة بكرا الساعة 12 الظهر، وعم بفكر أسافر الصيف الجاي';
  const uid = beginModel(modelFirstAnswer('تمام', 'propose', [
    modelItem('أتصل بأمي', TOMORROW, '17:00'),
    modelItem('ولازم أدفع الفاتورة', TOMORROW, '12:00'),
    modelItem('وعم بفكر أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
  ]));
  try {
    const body = await chat(uid, message, { locale: 'ar' });
    const proposal = body.proposal as Proposal;
    assert.ok(proposal, 'no proposal');
    const titles = proposal.items.map((item) => item.title);
    assert.ok(!titles.some((title) => title.startsWith('و')), `a model item keeps its joiner: ${JSON.stringify(titles)}`);
    for (const seed of proposal.seeds) assert.ok(seed.summary.startsWith('و'), `a model seed was rewritten: ${seed.summary}`);
    assertSummaryMatchesStored(proposal, 'model first turn');
  } finally {
    end();
  }
});

test('F3-003: a later model update that writes «و» into an existing point keeps the person\'s words', async () => {
  const uid = beginModel(
    modelFirstAnswer('تمام', 'propose', [modelItem('أتصل بأمي', TOMORROW, '17:00'), modelItem('ادفع الفاتورة', TOMORROW, '18:00')]),
    // The v5 answer with the citation every changing op carries on a later turn.
    { ...modelRefAnswer('تمام.', 'update'), open: [{ ref: 'i2', op: 'update', fields: modelItem('ولازم أدفع فاتورة الكهربا', TOMORROW, '18:00'), source: 'سمّي الفاتورة ولازم أدفع فاتورة الكهربا' }] },
  );
  try {
    const first = await chat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا، وادفع الفاتورة بكرا الساعة 6 المسا', { locale: 'ar' }) as Answer;
    // Said after another clause, so only "existing point" keeps the «و» here.
    const later = await chat(uid, 'الاتصال زي ما هو، وسمّي الفاتورة ولازم أدفع فاتورة الكهربا', { conversationId: first.conversationId, locale: 'ar' }) as Answer;
    const titles = (later.proposal as Proposal).items.map((item) => item.title);
    assert.ok(titles.includes('ولازم أدفع فاتورة الكهربا'), `the update did not apply as written: ${JSON.stringify(titles)}`);
    assertSummaryMatchesStored(later.proposal as Proposal, 'model update');
  } finally {
    end();
  }
});

test('F3-005/F3-007: a follower wait keeps its words verbatim and its line says the same', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا، وبستنى رد الدكتور', { locale: 'ar' });
    const proposal = body.proposal as Proposal;
    assert.ok(proposal.seeds.length > 0, `no seed: ${JSON.stringify(proposal)}`);
    assert.ok(proposal.seeds.some((seed) => seed.summary === 'وبستنى رد الدكتور'), `the wait was rewritten: ${JSON.stringify(proposal.seeds)}`);
    assertSummaryMatchesStored(proposal, 'wait');
  } finally {
    end();
  }
});

test('F3-004: the splitter keeps a Hebrew word\'s own «ו»; a joining one goes only at a follower', async () => {
  const uid = beginRules();
  try {
    const own = await chat(uid, 'ויזה חדשה צריך לחדש מחר בשעה 10 בבוקר', { locale: 'he' });
    const ownTitles = (own.proposal?.items ?? []).map((item) => item.title);
    assert.ok(!ownTitles.some((title) => title.startsWith('יזה')), `a first Hebrew word lost its letter: ${JSON.stringify(ownTitles)}`);
    assert.ok(splitCaptureClauseDetails('להתקשר לאמא מחר ב-5, ויזה חדשה צריך לחדש מחר').every((clause) => !clause.text.startsWith('יזה')));
    assert.ok(splitCaptureClauseDetails('להתקשר לאמא מחר ב-5, ותקנה לחם מחר').some((clause) => clause.text.startsWith('ותקנה')),
      'the splitter cut a Hebrew «ו» itself');
    const vet = await chat(uid, 'להתקשר לאמא מחר בשעה 5 אחר הצהריים, וטרינר לחתול מחר בשעה 9 בבוקר', { locale: 'he' });
    const vetTitles = (vet.proposal?.items ?? []).map((item) => item.title);
    assert.ok(!vetTitles.some((title) => title.startsWith('טרינר')), `a follower Hebrew word lost its letter: ${JSON.stringify(vetTitles)}`);
  } finally {
    end();
  }
});
