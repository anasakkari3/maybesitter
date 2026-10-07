/**
 * Load pass F3 (2026-10-07): «هيك فهمت» said «اتصل بالبنك» while review and
 * the saved commitment said «واتصل بالبنك». The summary dropped the «و» that
 * joined the clause to the one before it; the title kept it. One rule now
 * makes both: a joined «و» goes when what is left still reads as a point, and
 * stays when it is part of the word («وصّل أمي»).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutClauseJoiner } from '../../src/extraction/clauseSplitter.ts';
import { tidyTitle } from '../../lib/services/captureBoundary/proposalShape.ts';
import { beginRules, chat, end, type Proposal } from '../acceptance/m2a/support.ts';

const LOAD_PASS = 'بكرا الساعة 10 الصبح اجتماع مع المدير، واتصل بالبنك بكرا الساعة 12، ولازم أشتري هدية لخالد بكرا الساعة 6 المسا';

test('F3: the literal load-pass capture saves the titles «هيك فهمت» shows, without the joining «و»', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, LOAD_PASS, { locale: 'ar' });
    const proposal = body.proposal as Proposal;
    assert.ok(proposal, 'no proposal');
    const titles = proposal.items.map((item) => item.title);
    assert.ok(titles.includes('اتصل بالبنك'), `the bank's title keeps its joiner: ${JSON.stringify(titles)}`);
    assert.ok(!titles.some((title) => /^و/.test(title) && title !== 'وصّل'), `a joined «و» is left on a title: ${JSON.stringify(titles)}`);
    // Every commitment line of the summary says exactly its card's title.
    for (const point of proposal.understood ?? []) {
      if (point.kind !== 'commitment') continue;
      const item = proposal.items.find((candidate) => candidate.itemId === point.itemId);
      assert.ok(item, 'a summary line without its card');
      assert.equal(point.text, item!.title, 'the summary and the card say different words');
    }
  } finally {
    end();
  }
});

test('F3: the joiner rule keeps a «و» that belongs to the word, and one before a non-point', () => {
  assert.equal(withoutClauseJoiner('واتصل بالبنك'), 'اتصل بالبنك');
  assert.equal(withoutClauseJoiner('وأشتري خبز'), 'أشتري خبز');
  assert.equal(withoutClauseJoiner('وسجّل موعد دكتور'), 'سجّل موعد دكتور');
  assert.equal(withoutClauseJoiner('and buy bread'), 'buy bread');
  // «وصّل» is the verb itself; «ووصّل» loses only the joining one.
  assert.equal(withoutClauseJoiner('وصّل أمي عالدكتور'), 'وصّل أمي عالدكتور');
  assert.equal(withoutClauseJoiner('ووصّل أمي عالدكتور'), 'وصّل أمي عالدكتور');
  // What is left is not a point: the «و» stays.
  assert.equal(withoutClauseJoiner('ووقت الغدا'), 'ووقت الغدا');
  assert.equal(withoutClauseJoiner('وزارة الداخلية'), 'وزارة الداخلية');
  assert.equal(withoutClauseJoiner('و'), 'و');
});

test('F3: the saved title is tidied by the same rule', () => {
  assert.equal(tidyTitle('واتصل بالبنك'), 'اتصل بالبنك');
  assert.equal(tidyTitle('and gym'), 'gym');
  assert.equal(tidyTitle('وزارة الداخلية'), 'وزارة الداخلية');
});
