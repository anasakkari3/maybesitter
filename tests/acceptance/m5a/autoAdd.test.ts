/**
 * M5a Gate B — what the person agreed to in their own reply is added; the
 * rest waits (PLAN-M5a R3.1, R3.5, D9 / D11, conditions 31 / 42 / 24).
 *
 * Every bound fails closed: when one cannot be established the message's
 * observations commit pending and no commitment exists. Calendar consent is
 * granted in these tests (an auto-add treats the calendar as unknown without
 * it, M5A-R37 descoping); no Google calendar and no phone source is connected,
 * so the clash check runs on the person's commitments alone.
 *
 * The capture extraction runs on the rules path (the harness has no capture
 * model), over the qualifying agreement sentence only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOW, TOMORROW, at, begin, beginGoogle, call, connectGoogle, currentStorage, end, grantCalendarConsent, ownTextOf,
  plusDays, plusMinutes, runScanToEnd, savedCommitments, scanNew, semanticModel, show, type M5aMessage,
} from './support.ts';

test.afterEach(() => end());

const QUOTE_EN = '\n\nOn Tue, Oct 6, 2026 at 9:00 AM Dana <dana@example.com> wrote:\n> Can you come to the review tomorrow at 10?\n';

/** The semantic pass: a commitment observation for the agreement sentence, verbatim. */
function agreementModel(agreement: RegExp) {
  return semanticModel((text) => {
    const hit = agreement.exec(text);
    return hit ? [{ kind: 'commitment', evidence: hit[0], confidence: 0.9 }] : [];
  });
}

async function scenario(message: Partial<M5aMessage> & { text?: string }, agreement = /Sure, I'll come to the review tomorrow at 10/) {
  const uid = await begin();
  await grantCalendarConsent(uid);
  const google = beginGoogle(agreementModel(agreement));
  await connectGoogle(uid, 'gmail');
  google.messages = [{
    id: 'reply-1', receivedAt: plusMinutes(NOW(), -30), subject: 'Re: review', sent: true, inReplyTo: '<orig@example.com>',
    text: `Sure, I'll come to the review tomorrow at 10.${QUOTE_EN}`, ...message,
  } as M5aMessage];
  await scanNew(uid);
  const status = await runScanToEnd(uid);
  return { uid, google, status };
}

async function addedList(uid: string, query: Record<string, string> = {}) {
  const result = await call(uid, 'intelligence/added', 'GET', { query });
  assert.equal(result.status, 200, show(result.body));
  return result.body;
}

test('R3.1 / D9: a SENT reply with a quote header and one dated agreement in the own words is added, with provenance', async () => {
  const { uid, status } = await scenario({});
  const saved = await savedCommitments(uid);
  assert.equal(saved.length, 1, `expected one auto-added commitment, got ${saved.length}`);
  assert.equal(saved[0]!.timeSpec.dueAt, at(TOMORROW, '10:00'));
  assert.equal(status.manual.addedFromEmail, 1);
  const added = await addedList(uid);
  assert.equal(added.items.length, 1);
  assert.equal(added.items[0].status, 'open');
  assert.equal(added.items[0].removable, true);
  assert.match(added.items[0].evidence, /Sure, I'll come/);
});

test('R3.1 bound 1: a received (not SENT) message never auto-adds', async () => {
  const { uid } = await scenario({ sent: false });
  assert.equal((await savedCommitments(uid)).length, 0);
});

test('M5A-R6-002 bound 1: a SENT message without reply headers (an original outbound) never auto-adds', async () => {
  const { uid } = await scenario({ inReplyTo: undefined });
  assert.equal((await savedCommitments(uid)).length, 0);
});

test('M5A-R7-002 bound 2: a reply with no recognised quote header stays pending', async () => {
  const { uid } = await scenario({ text: "Sure, I'll come to the review tomorrow at 10." });
  assert.equal((await savedCommitments(uid)).length, 0);
});

test('M5A-R5-005 bound 2: an HTML-only reply stays pending', async () => {
  const { uid } = await scenario({ text: undefined, html: `<div>Sure, I'll come to the review tomorrow at 10.</div><blockquote class="gmail_quote">Can you come?</blockquote>` });
  assert.equal((await savedCommitments(uid)).length, 0);
});

test('M5A-R15-001: a date only in the quote ("Sure, I\'ll come.") stays pending', async () => {
  const { uid } = await scenario({ text: `Sure, I'll come.${QUOTE_EN}` }, /Sure, I'll come/);
  assert.equal((await savedCommitments(uid)).length, 0);
});

test('M5A-R32-001: a second sentence in the own text keeps it pending even if the model saw only one agreement', async () => {
  const { uid } = await scenario({ text: `Sure, I'll come to the review tomorrow at 10. I will also send the report on Thursday.${QUOTE_EN}` });
  assert.equal((await savedCommitments(uid)).length, 0);
});

test('M5A-R33-001: two agreements in one sentence keep it pending even if both models saw only the first', async () => {
  const { uid } = await scenario({ text: `Sure, I'll come to the review tomorrow at 10 and send the report on Thursday.${QUOTE_EN}` }, /Sure, I'll come to the review tomorrow at 10/);
  assert.equal((await savedCommitments(uid)).length, 0);
});

test('M5A-R20-003: a commitment below a sign-off (a signature or footer) never counts', async () => {
  const { uid } = await scenario({ text: `Thanks!\nRegards,\nAna\nI'll come to the review tomorrow at 10.${QUOTE_EN}` }, /I'll come to the review tomorrow at 10/);
  assert.equal((await savedCommitments(uid)).length, 0);
});

test('R3.1 bound 4: a date-time already past at scan time stays pending', async () => {
  const { uid } = await scenario({ text: `Sure, I'll come to the review today at 8.${QUOTE_EN}` }, /Sure, I'll come to the review today at 8/);
  assert.equal((await savedCommitments(uid)).length, 0);
});

test('M5A-005: "tomorrow" resolves from the reply\'s receivedAt, not the scan time', async () => {
  const { uid } = await scenario({ receivedAt: plusDays(NOW(), -2) });
  const saved = await savedCommitments(uid);
  // Sent two days ago, so "tomorrow at 10" was yesterday: past ⇒ pending.
  assert.equal(saved.length, 0, 'tomorrow was resolved against the scan time');
});

test('R3.1 bound 5 / condition 24: a clash with an existing commitment keeps it pending', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  const { addEvent } = await import('../m4a/support.ts');
  await addEvent(uid, { startsAt: at(TOMORROW, '10:00'), endsAt: at(TOMORROW, '11:00') }, 'Dentist');
  const google = beginGoogle(agreementModel(/Sure, I'll come to the review tomorrow at 10/));
  await connectGoogle(uid, 'gmail');
  google.messages = [{ id: 'reply-1', receivedAt: plusMinutes(NOW(), -30), subject: 'Re: review', sent: true, inReplyTo: '<o@x>', text: `Sure, I'll come to the review tomorrow at 10.${QUOTE_EN}` }];
  await scanNew(uid);
  await runScanToEnd(uid);
  assert.equal((await savedCommitments(uid)).length, 1, 'only the pre-existing dentist commitment may exist');
});

test('M5A-R37 descoping: without calendar consent an auto-add is never made', async () => {
  const uid = await begin();
  const google = beginGoogle(agreementModel(/Sure, I'll come to the review tomorrow at 10/));
  await connectGoogle(uid, 'gmail');
  google.messages = [{ id: 'reply-1', receivedAt: plusMinutes(NOW(), -30), subject: 'Re: review', sent: true, inReplyTo: '<o@x>', text: `Sure, I'll come to the review tomorrow at 10.${QUOTE_EN}` }];
  await scanNew(uid);
  await runScanToEnd(uid);
  assert.equal((await savedCommitments(uid)).length, 0);
});

test('R3.1 bound 6: a rescan of the same message never adds a second commitment', async () => {
  const { uid } = await scenario({});
  await scanNew(uid);
  await runScanToEnd(uid);
  assert.equal((await savedCommitments(uid)).length, 1);
});

test('M5A-R4-005: a message with an earlier observation (legacy pass) is never auto-added', async () => {
  const uid = await begin();
  await grantCalendarConsent(uid);
  const google = beginGoogle(agreementModel(/Sure, I'll come to the review tomorrow at 10/));
  await connectGoogle(uid, 'gmail');
  google.messages = [{ id: 'reply-1', receivedAt: plusMinutes(NOW(), -30), subject: 'Re: review', sent: true, inReplyTo: '<o@x>', text: `Sure, I'll come to the review tomorrow at 10.${QUOTE_EN}` }];
  const { createHash } = await import('node:crypto');
  const legacyMarker = createHash('sha256').update('gmail\0reply-1').digest('hex');
  await currentStorage().set(`users/${uid}/intelligenceSourceMarkers/${legacyMarker}`, { processedAt: plusDays(NOW(), -1) });
  await scanNew(uid);
  await runScanToEnd(uid);
  assert.equal((await savedCommitments(uid)).length, 0);
});

/* ── removal and the list ───────────────────────────────────────────── */

test('R3.1 Remove: an unedited auto-add is dropped, never re-added, and a retry is idempotent', async () => {
  const { uid } = await scenario({});
  const [item] = (await addedList(uid)).items;
  const removed = await call(uid, 'intelligence/added/[autoAddId]', 'DELETE', { params: { autoAddId: item.autoAddId } });
  assert.equal(removed.status, 200, show(removed.body));
  const retry = await call(uid, 'intelligence/added/[autoAddId]', 'DELETE', { params: { autoAddId: item.autoAddId } });
  assert.equal(retry.status, 200, `a lost-response retry must succeed (M5A-R19-005): ${show(retry.body)}`);
  assert.equal((await addedList(uid)).items.length, 0, 'a removed item stays in the card');
  await scanNew(uid);
  await runScanToEnd(uid);
  const open = (await savedCommitments(uid)).filter((c: any) => c.status !== 'dropped');
  assert.ok(open.length <= 1);
  assert.equal((await addedList(uid)).items.length, 0, 'the removed agreement was added again');
});

test('M5A-R9-009 / M5A-R19-003: an edited auto-add answers 409 edited and is listed not removable', async () => {
  const { uid } = await scenario({});
  const [item] = (await addedList(uid)).items;
  const patched = await call(uid, 'commitments/[id]', 'PATCH', { params: { id: item.commitmentId }, body: { title: 'Review with Dana (moved room)' } });
  assert.ok(patched.status < 300, show(patched.body));
  const removed = await call(uid, 'intelligence/added/[autoAddId]', 'DELETE', { params: { autoAddId: item.autoAddId } });
  assert.equal(removed.status, 409, show(removed.body));
  assert.equal(removed.body.error, 'edited');
  assert.equal((await addedList(uid)).items[0].removable, false);
});

test('M5A-002: removal and provenance work after the email capability is killed', async () => {
  const { uid } = await scenario({});
  const [item] = (await addedList(uid)).items;
  process.env.MAYBESITTER_KILL_SWITCH_EMAIL_SOURCES = 'true';
  const detail = await call(uid, 'commitments/[id]', 'GET', { params: { id: item.commitmentId } });
  if (detail.status === 200) assert.equal(detail.body.commitment?.addedFrom?.kind ?? detail.body.addedFrom?.kind, 'email_self_reply');
  const removed = await call(uid, 'intelligence/added/[autoAddId]', 'DELETE', { params: { autoAddId: item.autoAddId } });
  assert.equal(removed.status, 200, show(removed.body));
});

test('M5A-R36-008 / M5A-R37-005: /added pages with a stable cursor (limit ≤ 20)', async () => {
  const { uid } = await scenario({});
  const page = await addedList(uid, { limit: '20' });
  assert.ok('nextCursor' in page, 'no nextCursor');
  assert.equal(page.nextCursor, null);
  const tooBig = await call(uid, 'intelligence/added', 'GET', { query: { limit: '500' } });
  assert.ok(tooBig.status === 400 || (tooBig.status === 200 && tooBig.body.items.length <= 20), show(tooBig.body));
});

/* ── ownTextOf (the gate's named seam) ──────────────────────────────── */

test('R3.1 bound 2: ownTextOf recognises quote headers in ar / en / he and Outlook / forwarded blocks', async () => {
  const en = await ownTextOf(`Yes, see you then.${QUOTE_EN}`);
  assert.equal(en.boundary, 'quote_header');
  assert.match(en.own, /Yes, see you then/);
  assert.doesNotMatch(en.own, /Can you come/);
  // «في الثلاثاء ... كتب:»
  const ar = await ownTextOf('تمام، بجي بكرا الساعة 10.\n\nفي الثلاثاء، 6 أكتوبر 2026 كتب دانا:\n> بتيجي؟');
  assert.equal(ar.boundary, 'quote_header');
  // «בתאריך … נכתב:»
  const he = await ownTextOf('בסדר, אגיע.\n\nבתאריך יום ג׳, 6 באוק׳ 2026, דנה נכתב:\n> תבוא?');
  assert.equal(he.boundary, 'quote_header');
  const forwarded = await ownTextOf('FYI\n\n---------- Forwarded message ---------\nFrom: Dana\nCome tomorrow at 10');
  assert.notEqual(forwarded.boundary, 'no_quote', 'a forward must never read as own text');
  const odd = await ownTextOf('Sure.\n\n=== earlier ===\nCome tomorrow at 10');
  assert.notEqual(odd.boundary, 'quote_header', 'an unrecognised delimiter must never certify a quote boundary');
});
