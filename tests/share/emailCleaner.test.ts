/**
 * What the email cleaner removes, and what it must not (UC-3.8, #192 step 3).
 *
 * Every assertion here is about a *substring that is gone*. That is the shape
 * all of #192's privacy criteria take — no quoted history, no signature, no
 * disclaimer, no address, no phone number — and it is also the shape the
 * failure takes: a cleaner that half works leaves the one line with a phone
 * number in it and looks fine in a diff.
 *
 * The other half of the file is the opposite: sentences that must survive. A
 * cleaner is trivially correct if it returns the empty string, so every removal
 * rule is paired with the ordinary message it must leave alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMAIL_MASK,
  MAX_EMAIL_BODY_CHARACTERS,
  PHONE_MASK,
  cleanEmail,
  maskContactDetails,
  paragraphsOf,
  parseSentAt,
} from '../../lib/services/share/emailCleaner.ts';
import { ShareInputError } from '../../lib/services/share/shareTypes.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'share', 'email');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');
}

/* ── Headers ───────────────────────────────────────────────────── */

test('the subject and the date are kept and every other header is dropped', () => {
  const cleaned = cleanEmail(fixture('school_en'));
  assert.equal(cleaned.subject, 'Year 4 museum trip - consent form');
  assert.equal(cleaned.sentAt?.toISOString(), '2026-09-10T06:14:00.000Z');
  for (const dropped of ['From:', 'To:', 'Date:', 'Year 4 Parents']) {
    assert.ok(!cleaned.body.includes(dropped), `${dropped} survived into the body`);
  }
});

test('Arabic and Hebrew header names are headers', () => {
  assert.equal(cleanEmail(fixture('school_ar')).subject, 'استمارة رحلة المتحف');
  assert.equal(cleanEmail(fixture('work_he')).subject, 'דוח רבעוני');
  assert.ok(!cleanEmail(fixture('school_ar')).body.includes('أولياء الأمور'));
});

test('a localised Date header is not an anchor, and does not become a wrong one', () => {
  // «الخميس، ١٠ أيلول ٢٠٢٦» is not a format `new Date` reads. Null is the
  // answer; a `new Date('...')` that returned Invalid Date and got used anyway
  // would anchor every relative phrase in the message to NaN.
  assert.equal(cleanEmail(fixture('school_ar')).sentAt, null);
  assert.equal(parseSentAt('الخميس، ١٠ أيلول ٢٠٢٦'), null);
  assert.equal(parseSentAt(null), null);
  assert.equal(parseSentAt('   '), null);
  assert.equal(parseSentAt('Thu, 10 Sep 2026 09:14:00 +0300')?.toISOString(), '2026-09-10T06:14:00.000Z');
});

test('a pasted fragment with no headers at all is left alone', () => {
  const cleaned = cleanEmail('Please bring the form on Tuesday.');
  assert.equal(cleaned.subject, null);
  assert.equal(cleaned.sentAt, null);
  assert.equal(cleaned.body, 'Please bring the form on Tuesday.');
  assert.deepEqual(cleaned.removed, { quoted: 0, signature: false, disclaimer: false });
});

/* ── Quoted history ────────────────────────────────────────────── */

test('an English reply marker cuts, and the thread under it is gone', () => {
  const cleaned = cleanEmail(fixture('thread_with_quotes_en'));
  assert.ok(cleaned.body.includes('nursery registration form on Tuesday'));
  for (const quoted of ['invoice', 'deposit', 'Wednesday', 'parent meeting', 'transfer']) {
    assert.ok(!cleaned.body.includes(quoted), `"${quoted}" came back from the quoted thread`);
  }
});

test('the quoted count is the number of earlier messages, not the number of patterns that hit', () => {
  // The Outlook block carries both `-----Original Message-----` and a
  // `From:`/`Sent:` pair, and both patterns match it. Two, not three.
  assert.equal(cleanEmail(fixture('thread_with_quotes_en')).removed.quoted, 2);
});

test('the Arabic and Hebrew reply markers cut too', () => {
  const arabic = cleanEmail('لازم ترجّع الاستمارة بكرا.\n\nفي ٨ أيلول، سامي كتب:\nادفع الرسوم اليوم.');
  assert.ok(arabic.body.includes('ترجّع الاستمارة'));
  assert.ok(!arabic.body.includes('ادفع الرسوم'));
  assert.equal(arabic.removed.quoted, 1);

  const hebrew = cleanEmail(fixture('work_he'));
  assert.ok(hebrew.body.includes('הדוח הרבעוני'));
  assert.ok(!hebrew.body.includes('לשלם את החשבון'));
  assert.equal(hebrew.removed.quoted, 1);
});

test('Outlook\'s underscore divider cuts', () => {
  const cleaned = cleanEmail('Bring the form on Tuesday.\n\n________________________________\nPay the deposit today.');
  assert.ok(cleaned.body.includes('Bring the form'));
  assert.ok(!cleaned.body.includes('Pay the deposit'));
  assert.equal(cleaned.removed.quoted, 1);
});

test('a > quoted block above the cut is removed and counted once', () => {
  const cleaned = cleanEmail('Yes.\n\n> can you bring the form\n> and the fee\n\nSee you Tuesday.');
  assert.ok(!cleaned.body.includes('bring the form'));
  assert.ok(cleaned.body.includes('See you Tuesday'));
  // One block, not two lines.
  assert.equal(cleaned.removed.quoted, 1);
});

test('a forwarded message keeps its body once, rather than being cut at the divider', () => {
  // A parent forwarding the school's email to themselves is sharing that
  // message. Cutting at the divider would leave nothing at all.
  const cleaned = cleanEmail([
    'From: Anas <anas@example.com>',
    'Subject: Fwd: Sports day',
    '',
    '---------- Forwarded message ---------',
    'From: Office <office@school.example>',
    'Subject: Sports day',
    'Date: Wed, 9 Sep 2026 08:00:00 +0300',
    '',
    'Please send a hat with your child on Tuesday.',
  ].join('\n'));
  assert.ok(cleaned.body.includes('send a hat with your child on Tuesday'));
  // The forwarded headers describe what was actually shared, so they win.
  assert.equal(cleaned.subject, 'Sports day');
  assert.equal(cleaned.sentAt?.toISOString(), '2026-09-09T05:00:00.000Z');
  assert.ok(!cleaned.body.includes('Forwarded message'));
});

/* ── Signatures ────────────────────────────────────────────────── */

test('the RFC separator cuts the signature', () => {
  const cleaned = cleanEmail('Bring the form on Tuesday.\n\n-- \nDana Levy\nOffice Manager');
  assert.equal(cleaned.body, 'Bring the form on Tuesday.');
  assert.equal(cleaned.removed.signature, true);
});

test('a sign-off with a short block under it cuts, in three languages', () => {
  for (const [name, text, kept, gone] of [
    ['en', 'Return the form by Monday.\n\nBest regards,\nDana Levy\nOffice Manager\nGreenfield School', 'Return the form', 'Dana Levy'],
    ['ar', 'رجّع الاستمارة قبل الاثنين.\n\nمع التحية،\nدانا ليفي\nإدارة المدرسة', 'رجّع الاستمارة', 'دانا ليفي'],
    ['he', 'תעביר את הדוח עד יום חמישי.\n\nבברכה,\nמיכל בר', 'תעביר את הדוח', 'מיכל בר'],
  ] as const) {
    const cleaned = cleanEmail(text);
    assert.ok(cleaned.body.includes(kept), `${name}: the request was cut`);
    assert.ok(!cleaned.body.includes(gone), `${name}: the signature survived`);
    assert.equal(cleaned.removed.signature, true, `${name}: the removal was not reported`);
  }
});

test('a sign-off in the middle of a sentence is not a signature', () => {
  // "Thanks" is how half of all messages end and how the other half of their
  // paragraphs begin. A cut here loses the request that follows it.
  const cleaned = cleanEmail('Thanks for sorting the bus.\n\nPlease also return the signed consent form by Monday, and bring the fee in an envelope on the day.');
  assert.ok(cleaned.body.includes('return the signed consent form by Monday'));
  assert.equal(cleaned.removed.signature, false);
});

test('a long block under a sign-off is a message, not a signature', () => {
  const cleaned = cleanEmail('Thanks\n\nWe still need you to return the signed consent form by Monday because the museum requires the numbers a week in advance.');
  assert.ok(cleaned.body.includes('consent form by Monday'));
  assert.equal(cleaned.removed.signature, false);
});

/* ── Disclaimers ───────────────────────────────────────────────── */

test('a legal footer is removed in three languages', () => {
  for (const name of ['school_en', 'school_ar'] as const) {
    const cleaned = cleanEmail(fixture(name));
    assert.equal(cleaned.removed.disclaimer, true, `${name}: no disclaimer reported`);
  }
  assert.ok(!cleanEmail(fixture('school_en')).body.includes('confidential'));
  assert.ok(!cleanEmail(fixture('school_ar')).body.includes('سرية'));

  const hebrew = cleanEmail('צריך להעביר את הדוח עד יום חמישי.\n\nהודעה זו מיועדת אך ורק לנמען, והיא חסויה. אם קיבלת אותה בטעות יש למחוק אותה מיד.');
  assert.equal(hebrew.removed.disclaimer, true);
  assert.ok(!hebrew.body.includes('חסויה'));
  assert.ok(hebrew.body.includes('הדוח'));
});

test('a disclaimer below the signature is still counted, because it is removed first', () => {
  // Real mail puts the legal paragraph under the signature. A signature cut
  // that ran first would take it too, and report `disclaimer: false` on every
  // message that had one — a counter that reads clean exactly when it is wrong.
  const cleaned = cleanEmail(fixture('school_en'));
  assert.deepEqual(cleaned.removed, { quoted: 0, signature: true, disclaimer: true });
});

test('a short sentence with the word confidential in it is not a legal footer', () => {
  const cleaned = cleanEmail('The report is confidential.\n\nSend it by Monday.');
  assert.equal(cleaned.removed.disclaimer, false);
  assert.ok(cleaned.body.includes('The report is confidential.'));
});

/* ── Masking ───────────────────────────────────────────────────── */

test('addresses and phone numbers are replaced wherever they are', () => {
  const cleaned = cleanEmail(fixture('school_en'));
  assert.ok(!cleaned.body.includes('@'), cleaned.body);
  assert.ok(!/\+?972/.test(cleaned.body));
  assert.ok(cleaned.body.includes(EMAIL_MASK));
  assert.ok(cleaned.body.includes(PHONE_MASK));
  assert.equal(cleaned.masked.emails, 1);
  assert.equal(cleaned.masked.phones, 1);
});

test('Arabic-Indic digits are digits', () => {
  // An Arabic keyboard produces ٠١٢٣٤٥٦٧٨٩. A phone pattern that only knew
  // ASCII would leave every number an Arabic speaker typed in the clear.
  const cleaned = cleanEmail(fixture('school_ar'));
  assert.ok(cleaned.body.includes(PHONE_MASK), cleaned.body);
  assert.ok(!cleaned.body.includes('٥٥٥'));
  assert.equal(cleaned.masked.phones, 1);
});

test('a fee, a year and a clock time are not phone numbers', () => {
  const { text, masked } = maskContactDetails('The fee of 40 shekels is due at 09:14 on 10/09/2026, room 12.');
  assert.equal(text, 'The fee of 40 shekels is due at 09:14 on 10/09/2026, room 12.');
  assert.equal(masked.phones, 0);
});

test('a subject carrying an address is masked too', () => {
  const cleaned = cleanEmail('Subject: reply to office@school.example\n\nSend the form.');
  assert.equal(cleaned.subject, `reply to ${EMAIL_MASK}`);
});

/* ── Shape and limits ──────────────────────────────────────────── */

test('a MIME multipart container is refused rather than read as prose', () => {
  const eml = 'From: a@b.com\nContent-Type: multipart/mixed; boundary="x"\n\n--x\nContent-Transfer-Encoding: base64\n\nUGxlYXNl\n';
  assert.throws(
    () => cleanEmail(eml),
    (error: unknown) => error instanceof ShareInputError && error.status === 415 && error.reason === 'email_mime_unsupported',
  );
});

test('a very long body is read as far as the limit', () => {
  const long = `Subject: notes\n\n${'x'.repeat(MAX_EMAIL_BODY_CHARACTERS + 500)}`;
  assert.equal(cleanEmail(long).body.length, MAX_EMAIL_BODY_CHARACTERS);
});

test('CRLF is normalised, so a desktop paste is not a blank line per break', () => {
  const cleaned = cleanEmail('Subject: form\r\n\r\nBring it Tuesday.\r\n\r\n-- \r\nDana');
  assert.equal(cleaned.body, 'Bring it Tuesday.');
  assert.equal(cleaned.removed.signature, true);
});

test('paragraphs are the blank-line-separated pieces, with the blanks normalised', () => {
  assert.deepEqual(paragraphsOf('one\n\n\n  \n\ntwo\nstill two'), ['one', 'two\nstill two']);
  assert.deepEqual(paragraphsOf('   '), []);
});
