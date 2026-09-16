/**
 * Reading a WhatsApp export (UC-3.5, #189).
 *
 * The acceptance criteria this file is the evidence for:
 *
 *  - the parser handles Arabic, Hebrew and English system lines, 12- and
 *    24-hour timestamps, `U+200E`, and multi-line messages;
 *  - media placeholders are recognised and counted, never read as a message;
 *  - phone numbers are removed from the sender and from the body, and a date is
 *    not mistaken for one.
 *
 * Nothing here compares anything to the wall clock. The parser is a pure
 * function on a string, and every assertion is about the structure it returns
 * (#382).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeWhatsAppExport,
  parseWhatsAppExport,
  redactPhoneNumbers,
  REDACTED_PHONE,
} from '../../lib/services/share/whatsappParser.ts';
import {
  ALL_PAST,
  ANDROID_EN_DASH,
  ANDROID_ENGLISH,
  IOS_ARABIC,
  IOS_ENGLISH,
  IOS_HEBREW,
  IOS_TWELVE_HOUR,
  LRM,
  NNBSP,
  RLM,
  WITH_PHONE_NUMBERS,
} from '../fixtures/whatsapp/exports.ts';

/* ── The two header shapes ───────────────────────────────────────── */

test('an iOS export becomes messages, with the system line and the media placeholder counted apart', () => {
  const transcript = parseWhatsAppExport(IOS_ENGLISH);
  assert.equal(transcript.systemLines, 1);
  assert.equal(transcript.mediaPlaceholders, 1);
  assert.deepEqual(
    transcript.messages.map((message) => message.text),
    ['bring the documents tomorrow', 'I will pay the electricity bill and I will pick up the kids after'],
  );
  assert.deepEqual(transcript.messages.map((message) => message.sender), ['Dana', 'Sami']);
});

test('an Android export is read by the same parser', () => {
  const transcript = parseWhatsAppExport(ANDROID_ENGLISH);
  assert.equal(transcript.systemLines, 1);
  assert.deepEqual(
    transcript.messages.map((message) => message.text),
    ['bring the documents tomorrow', 'I will pay the electricity bill'],
  );
});

/**
 * The rule that catches an announcement nothing has a pattern for.
 *
 * WhatsApp writes dozens of system messages and this file knows perhaps twenty.
 * The backstop is that an announcement has no "Name: " on it, so a header with
 * no sender is dropped rather than guessed at. Every other fixture here also
 * matches one of the named patterns, which makes that backstop untested — so
 * this line is deliberately one no pattern in `SYSTEM_LINE` matches.
 */
test('a system line in a wording nothing has a pattern for is still not a message', () => {
  const line = `${LRM}[15/09/2026, 20:45:12] ${LRM}You blocked this contact`;
  const transcript = parseWhatsAppExport(`${line}\n${LRM}[15/09/2026, 20:46:00] Dana: call the dentist`);
  assert.deepEqual(transcript.messages.map((message) => message.text), ['call the dentist']);
  assert.equal(transcript.systemLines, 1);
});

/**
 * The en dash, which some locales write instead of a hyphen.
 *
 * A separate fixture rather than a variant of the last one: without it the
 * `[-–]` in the Android header is a character class nothing exercises, and
 * narrowing it back to `[-]` would leave the whole suite green.
 */
test('an Android export written with an en dash is read the same way', () => {
  const transcript = parseWhatsAppExport(ANDROID_EN_DASH);
  assert.ok(ANDROID_EN_DASH.includes('\u2013'), 'the fixture lost its en dash');
  assert.equal(transcript.systemLines, 1);
  assert.deepEqual(
    transcript.messages.map((message) => message.text),
    ['bring the documents tomorrow', 'pay the electricity bill on Sunday'],
  );
});

/**
 * The Android encryption notice has a colon in it.
 *
 * "Messages and calls are end-to-end encrypted: no one outside…" is 42
 * characters before the colon, which any sender rule loose enough to accept a
 * written-out phone number will read as a name. It is dropped because the
 * system patterns are tested against the whole line, before the sender is split
 * off — a parser that split first would report a message from somebody called
 * "Messages and calls are end-to-end encrypted".
 */
test('a system line with a colon in it is not read as somebody’s name', () => {
  const transcript = parseWhatsAppExport(
    '15/09/2026, 20:45 - Messages and calls are end-to-end encrypted: no one outside of this chat can read them.',
  );
  assert.equal(transcript.messages.length, 0);
  assert.equal(transcript.systemLines, 1);
});

/* ── Clocks ──────────────────────────────────────────────────────── */

test('12-hour timestamps resolve, including both noons and iOS 17’s narrow space', () => {
  const transcript = parseWhatsAppExport(IOS_TWELVE_HOUR);
  assert.ok(IOS_TWELVE_HOUR.includes(NNBSP), 'the fixture lost its narrow no-break space');
  assert.deepEqual(
    transcript.messages.map((message) => message.timestamp),
    ['2026-09-15 08:05', '2026-09-15 20:06', '2026-09-15 00:07', '2026-09-15 12:08'],
  );
});

test('24-hour timestamps are left alone', () => {
  const transcript = parseWhatsAppExport(IOS_ENGLISH);
  assert.deepEqual(
    transcript.messages.map((message) => message.timestamp),
    ['2026-09-15 20:46', '2026-09-15 20:47'],
  );
});

/**
 * Which field is the day is a property of the file.
 *
 * `05/09` is unreadable on its own. A later `15/09` settles it for every line,
 * and a `09/15` settles it the other way — which is why the decision is made
 * over the whole export rather than per header.
 */
test('the day/month order is inferred from the export as a whole', () => {
  const dayFirst = parseWhatsAppExport(
    '05/09/2026, 10:00 - Dana: one\n15/09/2026, 10:01 - Dana: two',
  );
  assert.deepEqual(dayFirst.messages.map((message) => message.timestamp), ['2026-09-05 10:00', '2026-09-15 10:01']);

  const monthFirst = parseWhatsAppExport(
    '09/05/2026, 10:00 - Dana: one\n09/15/2026, 10:01 - Dana: two',
  );
  assert.deepEqual(monthFirst.messages.map((message) => message.timestamp), ['2026-09-05 10:00', '2026-09-15 10:01']);
});

test('a two-digit year is read as this century', () => {
  const transcript = parseWhatsAppExport('15/09/26, 10:00 - Dana: one\n16/09/26, 10:01 - Dana: two');
  assert.deepEqual(transcript.messages.map((message) => message.timestamp), ['2026-09-15 10:00', '2026-09-16 10:01']);
});

/* ── Arabic and Hebrew ───────────────────────────────────────────── */

test('an Arabic export parses: Arabic-Indic digits, the Arabic comma, «ص»/«م» and its own media placeholder', () => {
  // The notice carries a colon, so the sender rule would claim it as a message
  // from somebody called «الرسائل والمكالمات مشفّرة بالكامل» if the Arabic
  // system patterns were not there. That is what makes this line a test of
  // them rather than of the "a header with no sender is an announcement" rule.
  assert.ok(IOS_ARABIC.includes(':'), 'the Arabic fixture lost its colon-bearing notice');
  const transcript = parseWhatsAppExport(IOS_ARABIC);
  assert.equal(transcript.systemLines, 1, 'the Arabic encryption notice was read as a message');
  assert.equal(transcript.mediaPlaceholders, 1, '«تم استبعاد الوسائط» was read as a message');
  assert.deepEqual(transcript.messages.map((message) => message.text), ['لازم نروح عالطبيب بكرا']);
  assert.deepEqual(transcript.messages.map((message) => message.timestamp), ['2026-09-15 20:46']);
});

test('a Hebrew export parses: the dotted date, «אחה"צ» and its own media placeholder', () => {
  // As above: the notice has a colon in it, so the Hebrew system patterns are
  // what keep it out of the messages rather than the no-sender rule.
  assert.ok(IOS_HEBREW.includes(':'), 'the Hebrew fixture lost its colon-bearing notice');
  const transcript = parseWhatsAppExport(IOS_HEBREW);
  assert.equal(transcript.systemLines, 1, 'the Hebrew encryption notice was read as a message');
  assert.equal(transcript.mediaPlaceholders, 1);
  assert.deepEqual(transcript.messages.map((message) => message.text), ['תביא את המסמכים מחר']);
  assert.deepEqual(transcript.messages.map((message) => message.timestamp), ['2026-09-15 20:46']);
});

/**
 * The marks are in the fixtures, and out of the output.
 *
 * Asserted on the fixture first: an invisible character is exactly the thing a
 * later edit removes by accident, and a test that stopped exercising U+200E
 * would keep passing while proving nothing.
 */
test('the bidi marks iOS writes are stripped from every message', () => {
  for (const [name, raw] of Object.entries({ IOS_ENGLISH, IOS_ARABIC, IOS_HEBREW })) {
    const marks = /[‎‏]/;
    assert.ok(marks.test(raw), `${name} no longer contains a bidi mark`);
    for (const message of parseWhatsAppExport(raw).messages) {
      assert.ok(!marks.test(message.text), `${name}: a bidi mark survived into a message`);
      assert.ok(!marks.test(message.sender ?? ''), `${name}: a bidi mark survived into a sender`);
    }
  }
});

test('an RTL export whose every line starts with a mark still parses', () => {
  const marked = IOS_ENGLISH.split('\n').map((line) => `${RLM}${line}`).join('\n');
  assert.equal(parseWhatsAppExport(marked).messages.length, parseWhatsAppExport(IOS_ENGLISH).messages.length);
});

/* ── Multi-line ──────────────────────────────────────────────────── */

/**
 * A continuation line joins with a space, not a newline.
 *
 * `splitInput` in the capture boundary breaks on `\n`, so a two-line message
 * left as two lines becomes two commitments — and then the item count and the
 * segment count disagree and every piece of evidence is dropped.
 */
test('a multi-line message is one message with no newline in it', () => {
  const transcript = parseWhatsAppExport(IOS_ENGLISH);
  const multi = transcript.messages[1]!;
  assert.ok(multi.text.includes('pick up the kids'));
  assert.ok(!multi.text.includes('\n'), 'a newline survived into a message');
});

test('a blank line inside a message does not end it', () => {
  const transcript = parseWhatsAppExport(
    `${LRM}[15/09/2026, 20:46:01] Dana: first line\n\nsecond line`,
  );
  assert.deepEqual(transcript.messages.map((message) => message.text), ['first line second line']);
});

/* ── Phone numbers ───────────────────────────────────────────────── */

test('every shape of phone number is removed, from the sender as well as the body', () => {
  const transcript = parseWhatsAppExport(WITH_PHONE_NUMBERS);
  const whole = transcript.messages.map((message) => `${message.sender}|${message.text}`).join('\n');
  for (const number of ['+972 50-123-4567', '050-123-4567', '972501234567', '+1 (415) 555-0123', '٠٥٠١٢٣٤٥٦٧']) {
    assert.ok(!whole.includes(number), `${number} survived redaction:\n${whole}`);
  }
  assert.ok(whole.includes(REDACTED_PHONE), 'nothing was redacted at all');
});

/**
 * The other half of the same rule.
 *
 * A redaction wide enough to catch every number also catches dates and times,
 * and a parser that removes "15/09/2026" has destroyed the one thing the
 * extractor needed out of the message.
 */
test('a date, a time and a short number are not mistaken for a phone number', () => {
  const kept = 'الاجتماع 15/09/2026 الساعة 20:45، الغرفة 412 والطلب 4051234';
  assert.equal(redactPhoneNumbers(kept), kept);
});

/* ── Recognising an export at all ────────────────────────────────── */

test('an export is recognised and prose is not', () => {
  assert.ok(looksLikeWhatsAppExport(IOS_ENGLISH));
  assert.ok(looksLikeWhatsAppExport(ANDROID_ENGLISH));
  assert.ok(looksLikeWhatsAppExport(IOS_ARABIC));
  assert.ok(looksLikeWhatsAppExport(IOS_HEBREW));
  assert.ok(!looksLikeWhatsAppExport('remind me to call the dentist tomorrow at 3pm'));
});

/**
 * One header-shaped line is not an export.
 *
 * A pasted calendar invite begins "15/09/2026, 20:45 - Kickoff". Claiming that
 * share would take it from `plain-text`, which reads it correctly.
 */
test('a single header-shaped line is not claimed as an export', () => {
  assert.ok(!looksLikeWhatsAppExport('15/09/2026, 20:45 - Kickoff meeting in the big room'));
});

test('a chat in which nothing is still to be done still parses into messages', () => {
  const transcript = parseWhatsAppExport(ALL_PAST);
  assert.equal(transcript.messages.length, 3);
  assert.equal(transcript.systemLines, 1);
});
