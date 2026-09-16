/**
 * A WhatsApp chat export, turned back into the messages it was made from
 * (UC-3.5, #189).
 *
 * ── Why a parser and not a paragraph ─────────────────────────────
 *
 * An export is not prose. It is one line per message with a machine-written
 * header on the front, media replaced by a placeholder, and a handful of
 * announcements nobody wrote. Handing that to the extractor verbatim reads
 * "[15/09/2026, 20:45:12] Messages and calls are end-to-end encrypted." as
 * something a person committed to.
 *
 * So the export is split back into messages, and everything that is not one is
 * counted and dropped. What the rest of the channel works with is a list of
 * bodies — the only thing in the file a person actually typed.
 *
 * ── The two header shapes, and what is not a guess inside them ───
 *
 *   iOS      ‎[15/09/2026, 20:45:12] Dana: bring the documents tomorrow
 *   Android  15/09/2026, 20:45 - Dana: bring the documents tomorrow
 *
 *  - **U+200E / U+200F.** iOS writes a LEFT-TO-RIGHT MARK before the `[`, and
 *    again before a media placeholder. An Arabic or Hebrew export has them on
 *    nearly every line, so a parser anchored on `^\[` misses every message of
 *    an RTL export — which is the majority of this product's users.
 *  - **12- and 24-hour clocks**, with `AM`/`PM`, with the Arabic «ص»/«م» and
 *    the Hebrew «לפנה"צ»/«אחה"צ», and with U+202F NARROW NO-BREAK SPACE in
 *    front of them, which is what iOS 17 and later write instead of a space.
 *  - **Multi-line messages.** A message containing a newline continues on
 *    lines with no header. They belong to the message above and are joined
 *    with a space rather than a newline: `splitInput` in the capture boundary
 *    breaks on `\n`, so a two-line message left as two lines becomes two
 *    commitments sharing one piece of evidence.
 *
 * ── Dates are read but never resolved to an instant ──────────────
 *
 * `15/09/2026` is the fifteenth of September in most of the world and a
 * malformed date in the United States, and nothing in the file says which
 * WhatsApp meant: it follows the *exporting* device's locale, which is not the
 * sharing device's and is not carried. So the order is inferred from the export
 * as a whole and the result is kept as the wall clock it was written as, never
 * converted into a UTC instant. Converting would mean inventing a zone for a
 * message and then reasoning about "past" from the invention.
 */

/** ASCII, Arabic-Indic and Persian digits. WhatsApp writes all three. */
const DIGIT = '0-9\\u0660-\\u0669\\u06f0-\\u06f9';
/**
 * Every space WhatsApp puts inside a header.
 *
 * Just `\s`, and stated rather than assumed: JavaScript's `\s` already
 * includes U+00A0 NO-BREAK SPACE and U+202F NARROW NO-BREAK SPACE, which is
 * what iOS 17 and later write in front of `AM`/`PM`. Listing those two
 * explicitly beside it — which this did — reads like a guard and is not one:
 * removing them changes nothing, so nobody editing this line could tell which
 * half was load-bearing.
 */
const SPACE = '\\s';
/** The separators a written phone number uses, spaces included. */
const PHONE_GAP = '\\-.()\\u0020\\u00a0\\u202f';
/** The bidi controls iOS sprinkles through an RTL export. */
const BIDI = /[‎‏‪-‮⁦-⁩﻿]/g;

const DATE = `([${DIGIT}]{1,4})[./-]([${DIGIT}]{1,2})[./-]([${DIGIT}]{2,4})`;
const MERIDIEM = `([APap]\\.?[Mm]\\.?|[\\u0635\\u0645]|\\u05dc\\u05e4\\u05e0\\u05d4"\\u05e6|\\u05d0\\u05d7\\u05d4"\\u05e6)`;
const TIME = `([${DIGIT}]{1,2}):([${DIGIT}]{2})(?::([${DIGIT}]{2}))?(?:[${SPACE}]*${MERIDIEM})?`;

/** `[15/09/2026, 20:45:12] ` — iOS, and the shape a `.txt` share carries. */
const IOS_HEADER = new RegExp(`^\\[${DATE}[,\\u060c]?[${SPACE}]+${TIME}[${SPACE}]*\\][${SPACE}]*`);
/** `15/09/2026, 20:45 - ` — Android. The dash is a hyphen or an en dash. */
const ANDROID_HEADER = new RegExp(`^${DATE}[,\\u060c]?[${SPACE}]+${TIME}[${SPACE}]*[-\\u2013][${SPACE}]*`);

/**
 * `Dana: ` at the front of a message body.
 *
 * Bounded at 64 characters because the alternative — the first colon anywhere —
 * turns "Messages and calls are end-to-end encrypted: no one outside…" into a
 * message from somebody called "Messages and calls are end-to-end encrypted".
 * A WhatsApp display name cannot exceed 25 characters; 64 leaves room for a
 * phone number written with brackets and spaces.
 */
const SENDER = new RegExp(`^([^:\\n]{1,64}?):[${SPACE}]`);

/**
 * Text that is WhatsApp talking rather than a person.
 *
 * Matched against the whole line after the header — sender included — because
 * Android writes "Messages and calls are end-to-end encrypted: no one outside…"
 * with a colon in it, which any sender rule short enough to be useful will
 * read as a name.
 *
 * Every entry is a line a person never typed, in the three languages this
 * product ships. They are dropped and counted, never shown to a model:
 * "Messages and calls are end-to-end encrypted" contains "messages", "calls"
 * and "end", and the extractor has read worse as a task.
 */
const SYSTEM_LINE: readonly RegExp[] = [
  /end-to-end encrypted/i,
  /messages and calls/i,
  /\byou (?:created|added|removed|left|joined|changed)\b/i,
  /\bcreated (?:this )?group\b/i,
  /\bchanged (?:the )?(?:subject|group|their phone number|this group's)/i,
  /\bjoined using this group's invite link\b/i,
  /\bsecurity code (?:changed|with)\b/i,
  /\bmissed (?:voice|video) call\b/i,
  /\b(?:this message was deleted|you deleted this message)\b/i,
  /\bwaiting for this message\b/i,
  // ar
  /مشف|التشفير/,
  /الرسائل والمكالمات/,
  /حذف هذه الرسالة|حذفت هذه الرسالة/,
  /أنشأت? المجموعة|رمز الأمان/,
  /انضم عبر رابط الدعوة/,
  // he
  /מוצפנ|הצפנה מקצה לקצה/,
  /הודעות ושיחות/,
  /ההודעה הזו נמחקה|מחקת את ההודעה/,
  /יצר[ת]? את הקבוצה|קוד האבטחה/,
  /הצטרף באמצעות קישור ההזמנה/,
];

/**
 * A body that stands in for a file WhatsApp did not export.
 *
 * Counted apart from the system lines because it answers a different question:
 * "this export mentioned media" is what says the media path was never taken,
 * and folding the two numbers together would hide it.
 */
const MEDIA_BODY: readonly RegExp[] = [
  /^<media omitted>$/i,
  /^(?:image|video|audio|sticker|document|gif|contact card|photo)\s+omitted$/i,
  /^<attached:.*>$/i,
  /^.+\.(?:jpg|jpeg|png|webp|opus|mp4|m4a|pdf|vcf|3gp|aac)\s*\(file attached\)$/i,
  /^<?تم استبعاد الوسائط>?$/,
  /^(?:صورة|فيديو|ملصق|مقطع صوتي|مستند)\s*(?:مستبعد|محذوف)ة?$/,
  /^<?המדיה הושמטה>?$/,
  /^(?:תמונה|סרטון|מדבקה|הודעה קולית|מסמך)\s*הושמט[הת]?$/,
];

/** One message a person wrote. */
export interface WhatsAppMessage {
  /** Its position among the messages, from zero. What the model names. */
  readonly index: number;
  /** `YYYY-MM-DD HH:MM`, as written, in whatever zone the export was made in. */
  readonly timestamp: string | null;
  /** The display name, already redacted. Null when the header carried none. */
  readonly sender: string | null;
  /** The body, newlines folded to spaces, already redacted. */
  readonly text: string;
}

export interface WhatsAppTranscript {
  readonly messages: readonly WhatsAppMessage[];
  /** Lines WhatsApp wrote itself. A count; never the line. */
  readonly systemLines: number;
  /** Messages that were a file. Counted here and never read off disk. */
  readonly mediaPlaceholders: number;
}

/**
 * The most lines this will read out of one file.
 *
 * The route caps a share at 25 MB and the device caps a `.txt` at 1 MB, but a
 * 1 MB file of newlines is still a million iterations on a request thread.
 */
const MAX_LINES = 20_000;

function stripBidi(raw: string): string {
  return raw.replace(BIDI, '');
}

/** The ASCII value of a digit in any of the three scripts WhatsApp writes. */
function toAscii(digits: string): string {
  let out = '';
  for (const character of digits) {
    const code = character.codePointAt(0)!;
    if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else out += character;
  }
  return out;
}

interface Header {
  readonly first: number;
  readonly second: number;
  readonly year: number;
  readonly hour: number;
  readonly minute: number;
  readonly meridiem: string | null;
  readonly rest: string;
}

/** The header on a line, or null when the line is a continuation. */
function headerOf(line: string): Header | null {
  const match = IOS_HEADER.exec(line) ?? ANDROID_HEADER.exec(line);
  if (!match) return null;
  return {
    first: Number(toAscii(match[1]!)),
    second: Number(toAscii(match[2]!)),
    year: Number(toAscii(match[3]!)),
    hour: Number(toAscii(match[4]!)),
    minute: Number(toAscii(match[5]!)),
    meridiem: match[7] ?? null,
    rest: line.slice(match[0].length),
  };
}

/** Whether the first bytes of a share look like an export rather than prose. */
export function looksLikeWhatsAppExport(raw: string): boolean {
  const head = stripBidi(raw).split(/\r?\n/).slice(0, 40);
  // Two, not one: a single "15/09/2026, 20:45 - " shaped line turns up inside a
  // pasted calendar invite, and claiming that share would take it from a
  // channel that reads it properly.
  let headed = 0;
  for (const line of head) {
    if (headerOf(line) !== null) headed += 1;
    if (headed >= 2) return true;
  }
  return false;
}

/**
 * `YYYY-MM-DD HH:MM` from a header, given which field is the day.
 *
 * Not a `Date`. See the module header: the export does not say which zone it
 * was written in, and a `Date` would be this parser asserting one.
 */
function stampOf(header: Header, dayFirst: boolean): string {
  const day = dayFirst ? header.first : header.second;
  const month = dayFirst ? header.second : header.first;
  const year = header.year < 100 ? 2000 + header.year : header.year;
  let hour = header.hour;
  const meridiem = (header.meridiem ?? '').toLowerCase().replace(/\./g, '');
  const afternoon = meridiem === 'pm' || meridiem === 'p' || header.meridiem === 'م' || header.meridiem === 'אחה"צ';
  const morning = meridiem === 'am' || meridiem === 'a' || header.meridiem === 'ص' || header.meridiem === 'לפנה"צ';
  if (afternoon && hour < 12) hour += 12;
  if (morning && hour === 12) hour = 0;
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(header.minute)}`;
}

/**
 * Whether this export writes the day before the month.
 *
 * Decided from the export as a whole rather than per line: `05/09` is
 * unreadable alone and `15/09` three lines later settles it for the file.
 * Day-first when nothing settles it, because that is what every locale this
 * product ships in uses.
 */
function dayFirstIn(headers: readonly Header[]): boolean {
  if (headers.some((header) => header.first > 12)) return true;
  if (headers.some((header) => header.second > 12)) return false;
  return true;
}

/**
 * A phone number, in every shape WhatsApp writes one.
 *
 * ── Why shapes and not "seven digits in a row" ───────────────────
 *
 * The obvious rule — any long enough run of separated digits — eats
 * `2026-09-15 20:45` and `order 4051234` alike, and redacting the date out of
 * "الاجتماع 15/09/2026" destroys the one thing the extractor needed. These
 * three are what a phone number actually looks like:
 *
 *   +972 50-123-4567 · +1 (415) 555-0123   international, always a leading `+`
 *   050-123-4567 · 0501234567              a trunk-prefixed national mobile
 *   972501234567                           a bare run of nine or more
 *
 * None of them is a date: a date has a separator between two-digit groups and
 * no `+`, does not begin with `0` followed by eight more digits, and is not
 * nine digits in a row.
 */
const PHONE_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\+[${DIGIT}][${DIGIT}${PHONE_GAP}]{6,20}[${DIGIT}]`, 'g'),
  new RegExp(`(?<![${DIGIT}])0[${DIGIT}]{1,2}[-.\\u0020\\u00a0\\u202f]?[${DIGIT}]{3}[-.\\u0020\\u00a0\\u202f]?[${DIGIT}]{4}(?![${DIGIT}])`, 'g'),
  new RegExp(`(?<![${DIGIT}+])[${DIGIT}]{9,15}(?![${DIGIT}])`, 'g'),
];

/** What a redacted number becomes. A fixed token, never a partial number. */
export const REDACTED_PHONE = '[phone]';

/**
 * Every phone number in a string, replaced by a token (#189).
 *
 * Applied to the sender as well as the body: in a group chat with an unsaved
 * contact the sender *is* a phone number, which is the case a body-only
 * redaction misses and the one most likely to be in a real export.
 */
export function redactPhoneNumbers(text: string): string {
  let out = text;
  for (const pattern of PHONE_PATTERNS) out = out.replace(pattern, REDACTED_PHONE);
  return out;
}

/** The messages in an export, and the counts of what was not one. */
export function parseWhatsAppExport(raw: string): WhatsAppTranscript {
  const lines = stripBidi(raw).split(/\r?\n/).slice(0, MAX_LINES);
  // Two passes: the day/month order is a property of the file, not of a line.
  const parsed = lines.map((line) => ({ line, header: headerOf(line) }));
  const dayFirst = dayFirstIn(
    parsed.map((entry) => entry.header).filter((header): header is Header => header !== null),
  );

  interface Draft { timestamp: string; parts: string[] }
  const drafts: Draft[] = [];
  for (const { line, header } of parsed) {
    if (header === null) {
      // A continuation. A blank line inside a message contributes nothing: the
      // parts are joined with a single space below.
      if (drafts.length > 0 && line.trim() !== '') drafts[drafts.length - 1]!.parts.push(line.trim());
      continue;
    }
    drafts.push({ timestamp: stampOf(header, dayFirst), parts: [header.rest] });
  }

  const messages: WhatsAppMessage[] = [];
  let systemLines = 0;
  let mediaPlaceholders = 0;
  for (const draft of drafts) {
    // Newlines folded to spaces here rather than at the join: see the header.
    const whole = draft.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (whole === '') continue;
    // Tested against sender *and* body, before the sender is split off, so an
    // announcement with a colon in it is not read as somebody's name.
    if (SYSTEM_LINE.some((pattern) => pattern.test(whole))) {
      systemLines += 1;
      continue;
    }
    const senderMatch = SENDER.exec(whole);
    // A header with no "Name: " is WhatsApp announcing something in a wording
    // this does not have a pattern for. Dropped rather than guessed at.
    if (senderMatch === null) {
      systemLines += 1;
      continue;
    }
    const body = whole.slice(senderMatch[0].length).trim();
    if (body === '') continue;
    if (MEDIA_BODY.some((pattern) => pattern.test(body))) {
      mediaPlaceholders += 1;
      continue;
    }
    messages.push({
      index: messages.length,
      timestamp: draft.timestamp,
      sender: redactPhoneNumbers(senderMatch[1]!.trim()),
      text: redactPhoneNumbers(body),
    });
  }
  return { messages, systemLines, mediaPlaceholders };
}
