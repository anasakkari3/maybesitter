/**
 * What is left of an email once the parts nobody committed to are gone
 * (UC-3.8, #192 step 3).
 *
 * ── Why a cleaner at all ─────────────────────────────────────────
 *
 * An email is mostly not the message. A reply carries the whole thread under
 * it; a school newsletter carries a legal disclaimer; every message carries a
 * signature with a name, an address and a phone number. Handed whole to an
 * extractor, a two-line note about a consent form becomes four proposals, two
 * of them things somebody else asked for a week ago and one of them "call
 * +972 3 555 0134".
 *
 * So the cleaner's job is subtraction, and the acceptance criteria are all
 * statements about what is *not* in its output:
 *
 *  - nothing sourced from quoted history,
 *  - no signature or disclaimer text in a title or in evidence,
 *  - no address and no phone number, anywhere, ever reaching the model.
 *
 * ── The order the steps run in is load-bearing ───────────────────
 *
 * Disclaimers are removed **before** the signature is cut, not after. Real mail
 * puts the legal paragraph below the signature, so a signature cut that ran
 * first would take the disclaimer with it — and `removed.disclaimer` would be
 * false on every message that had one, which is a counter that reads clean
 * precisely when it is wrong. Running it first makes both counts true of the
 * message rather than true of the order.
 *
 * Masking runs **last**, over whatever survived, so an address in a part this
 * did not recognise is still masked. Addresses first, then phones: an address
 * can contain digits, and a phone pattern that ran first would eat half of one.
 *
 * ── It never throws on shape ─────────────────────────────────────
 *
 * A pasted fragment with no headers, no greeting and no signature is a valid
 * email body and comes back unchanged with every counter at zero. The one thing
 * this refuses is a MIME multipart container (a raw `.eml` with base64 parts),
 * because what it would otherwise return is an encoded blob presented as prose.
 */
import { ShareInputError } from './shareTypes';

/** The most of a cleaned body that is worth reading. #192 step 3. */
export const MAX_EMAIL_BODY_CHARACTERS = 12_000;

/** What the cleaner took out, as counts the preview can put in a sentence. */
export interface EmailRemovals {
  /** Reply markers and `>`-quoted blocks that were cut. */
  readonly quoted: number;
  readonly signature: boolean;
  readonly disclaimer: boolean;
}

/** What masking replaced, for telemetry and for the assertion that it ran. */
export interface EmailMasking {
  readonly emails: number;
  readonly phones: number;
}

export interface CleanedEmail {
  /** The `Subject:` value, or null when the share carried no header block. */
  readonly subject: string | null;
  /** The `Date:` value as an instant, or null when it was absent or unparseable. */
  readonly sentAt: Date | null;
  /** The message, masked, with quoted history, signature and boilerplate gone. */
  readonly body: string;
  readonly removed: EmailRemovals;
  readonly masked: EmailMasking;
}

/** The replacement tokens. Fixed strings, so a test can assert on them. */
export const EMAIL_MASK = '[email]';
export const PHONE_MASK = '[phone]';

/* ── Headers ───────────────────────────────────────────────────── */

/** A `Name: value` line at the top of the message, in three languages. */
const HEADER = /^[ \t]*([A-Za-z-]{2,20}|من|إلى|الى|الموضوع|التاريخ|مرسل|נשלח|מאת|אל|נושא|תאריך)[ \t]*:[ \t]*(.*)$/;
/** A folded header continuation: RFC 5322 indents it. */
const CONTINUATION = /^[ \t]+\S/;
const SUBJECT_FIELD = /^(subject|الموضوع|נושא)$/i;
const DATE_FIELD = /^(date|sent|التاريخ|תאריך|נשלח)$/i;

/**
 * A raw `.eml` whose body is not text at all.
 *
 * #192 puts `.eml` out of scope for launch and the client says so. A file that
 * reaches here anyway is refused rather than read: a multipart container's body
 * is base64, and handing the model base64 would produce confident proposals
 * about a string of letters.
 */
const MIME_MULTIPART = /^[ \t]*content-type[ \t]*:[ \t]*multipart\//im;

interface HeaderScan {
  readonly subject: string | null;
  readonly sentAt: Date | null;
  readonly rest: string;
}

/**
 * Reads the header block off the front, keeping only Subject and Date.
 *
 * Only the front. Headers appear again inside quoted blocks and forwarded
 * bodies, and the ones down there describe somebody else's message — taking a
 * `Subject:` from there would title the proposal with the wrong thread.
 */
function scanHeaders(lines: readonly string[]): HeaderScan {
  let subject: string | null = null;
  let dateValue: string | null = null;
  let index = 0;
  let sawHeader = false;
  /** Which of the two kept fields a folded continuation belongs to. */
  let folding: 'subject' | 'date' | null = null;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === '') {
      // A blank line ends the block — but only once a header has been seen, so
      // a body that happens to start with a blank line is not eaten.
      if (sawHeader) { index += 1; break; }
      index += 1;
      continue;
    }
    if (sawHeader && CONTINUATION.test(line)) {
      if (folding === 'subject' && subject !== null) subject += ` ${line.trim()}`;
      if (folding === 'date' && dateValue !== null) dateValue += ` ${line.trim()}`;
      index += 1;
      continue;
    }
    const match = HEADER.exec(line);
    if (!match) break;
    sawHeader = true;
    const field = match[1]!.trim();
    const value = match[2]!.trim();
    folding = null;
    if (SUBJECT_FIELD.test(field) && subject === null) { subject = value; folding = 'subject'; }
    if (DATE_FIELD.test(field) && dateValue === null) { dateValue = value; folding = 'date'; }
    index += 1;
  }
  return {
    subject: subject === null || subject === '' ? null : subject,
    sentAt: parseSentAt(dateValue),
    rest: lines.slice(index).join('\n'),
  };
}

/**
 * The instant a `Date:` value names, or null.
 *
 * `new Date` reads RFC 2822 and ISO 8601, which is every value a mail client
 * writes. It does **not** read «الخميس، ١٠ أيلول ٢٠٢٦», and that is the
 * ordinary case for a message a user retyped or a client that localised the
 * header — so null is a normal answer and the channel falls back to the
 * device's reference time rather than inventing an anchor.
 */
export function parseSentAt(value: string | null): Date | null {
  if (value === null || value.trim() === '') return null;
  const parsed = new Date(value.trim());
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/* ── Quoted history ────────────────────────────────────────────── */

/**
 * Everything below one of these belongs to an earlier message.
 *
 * Global and multiline: the *first* one is where the body ends, and the count
 * of all of them is what the preview means by "2 earlier replies".
 */
const REPLY_MARKERS: readonly RegExp[] = [
  /^[ \t]*on\b[\s\S]{0,200}?\bwrote[ \t]*:[ \t]*$/gim,
  /^[ \t]*-{2,}[ \t]*original message[ \t]*-{2,}[ \t]*$/gim,
  /^[ \t]*-{2,}[ \t]*(?:הודעה מקורית|الرسالة الأصلية)[ \t]*-{2,}[ \t]*$/gim,
  /^[ \t]*_{5,}[ \t]*$/gim,
  /^[ \t]*في[\s\S]{0,200}?كتب[ \t]*:[ \t]*$/gim,
  /^[ \t]*ב[-–][\s\S]{0,200}?כתב[ \t]*:[ \t]*$/gim,
  /^[ \t]*בתאריך[\s\S]{0,200}?כתב[ \t]*:[ \t]*$/gim,
  /^[ \t]*from[ \t]*:[\s\S]{0,300}?^[ \t]*(?:sent|date)[ \t]*:.*$/gim,
];

/**
 * Gmail's forward divider.
 *
 * Not a cut. #192 step 3 keeps the forwarded body once — a parent who forwards
 * the school's email to themselves is sharing *that* message, and cutting at
 * the divider would leave nothing at all. The divider and the header block
 * under it are dropped; the message below them is the body.
 */
const FORWARD_MARKER =
  /^[ \t]*-{3,}[ \t]*(?:forwarded message|رسالة معاد توجيهها|رسالة محولة|הודעה שהועברה)[ \t]*-{3,}[ \t]*$/im;

/** A line somebody's mail client quoted. */
const QUOTED_LINE = /^[ \t]*>+/;

interface QuoteCut {
  readonly text: string;
  readonly quoted: number;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/** A line that is a header field rather than something somebody wrote. */
const HEADERISH = /^[ \t]*(?:[A-Za-z-]{2,20}|من|إلى|الى|الموضوع|التاريخ|مرسل|נשלח|מאת|אל|נושא|תאריך)[ \t]*:/;

/**
 * How many *earlier messages* these markers describe, not how many patterns hit.
 *
 * An Outlook quote carries `-----Original Message-----` and then `From:` and
 * `Sent:`, and both the divider pattern and the `From:…Sent:` pattern match it.
 * Counting each would tell the user "3 earlier replies removed" about a thread
 * with two, which is a number that looks authoritative and is wrong.
 *
 * So two markers separated by nothing but blank lines and header lines are one
 * quoted message. Anything a person wrote between them makes them two.
 */
function separateMessages(raw: string, spans: readonly Span[]): Span[] {
  const kept: Span[] = [];
  let lastEnd = -1;
  for (const span of spans) {
    if (span.start < lastEnd) continue;
    if (kept.length > 0) {
      const gap = raw.slice(lastEnd, span.start);
      const wrote = gap.split('\n').some((line) => line.trim() !== '' && !HEADERISH.test(line));
      if (!wrote) { lastEnd = Math.max(lastEnd, span.end); continue; }
    }
    kept.push(span);
    lastEnd = span.end;
  }
  return kept;
}

/**
 * Cuts the thread off, and says how many messages of it there were.
 *
 * The count is taken over the *whole* input before the cut, because that is
 * what the user sees: a message with two replies under it had two replies
 * removed, whether the cut happened at the first or at the second.
 */
function cutQuotedHistory(raw: string): QuoteCut {
  const spans: Span[] = [];
  for (const pattern of REPLY_MARKERS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(raw); match !== null; match = pattern.exec(raw)) {
      spans.push({ start: match.index, end: match.index + match[0].length });
      // A zero-width match cannot happen here — every alternative requires at
      // least two characters — but a runaway loop on one would hang a request.
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const messages = separateMessages(raw, spans);
  let quoted = messages.length;
  const cutAt = messages.length > 0 ? messages[0]!.start : raw.length;
  const head = raw.slice(0, cutAt);

  // Any `>` lines above the cut are quoted too. Counted per contiguous block,
  // so a four-line quote is one removal rather than four.
  const lines = head.split('\n');
  const kept: string[] = [];
  let inQuote = false;
  for (const line of lines) {
    if (QUOTED_LINE.test(line)) {
      if (!inQuote) { quoted += 1; inQuote = true; }
      continue;
    }
    inQuote = false;
    kept.push(line);
  }
  return { text: kept.join('\n'), quoted };
}

/* ── Signatures ────────────────────────────────────────────────── */

/** RFC 3676's signature separator, and the em-dash people type instead. */
const SIGNATURE_SEPARATOR = /^[ \t]*(?:--[ \t]*|—[ \t]*|__[ \t]*)$/;

/** A sign-off alone on its line. The same list the detector uses. */
const SIGN_OFF =
  /^[ \t]*(?:best regards|kind regards|warm regards|regards|best wishes|all the best|sincerely|yours sincerely|yours truly|many thanks|thanks|thank you|cheers|مع التحية|مع الشكر|تحياتي|مع خالص التقدير|وتفضلوا بقبول فائق الاحترام|شكرا|شكراً|בברכה|בכבוד רב|תודה רבה|תודה|כל טוב)[ \t]*[,.!،؛]?[ \t]*$/i;

/** The most lines a signature block may have after the sign-off. #192 step 3. */
const MAX_SIGNATURE_LINES = 6;
/** A signature line is a name, a title, a company — not a sentence. */
const MAX_SIGNATURE_LINE_LENGTH = 60;

/**
 * Cuts the signature, or leaves the message alone.
 *
 * The separator is unambiguous and cuts on sight. A sign-off is not: "Thanks"
 * is how half of all messages end *and* how a paragraph in the middle of one
 * begins. So a sign-off only cuts when what follows it looks like a signature —
 * at most six short lines, and then nothing. "Thanks, and please also bring the
 * form on Tuesday." keeps its request, which is the whole point.
 */
function cutSignature(text: string): { text: string; signature: boolean } {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (SIGNATURE_SEPARATOR.test(line)) {
      return { text: lines.slice(0, index).join('\n'), signature: true };
    }
    if (!SIGN_OFF.test(line)) continue;
    const tail = lines.slice(index + 1).filter((candidate) => candidate.trim() !== '');
    if (tail.length > MAX_SIGNATURE_LINES) continue;
    if (tail.some((candidate) => candidate.trim().length > MAX_SIGNATURE_LINE_LENGTH)) continue;
    return { text: lines.slice(0, index).join('\n'), signature: true };
  }
  return { text, signature: false };
}

/* ── Disclaimers ───────────────────────────────────────────────── */

/**
 * The words a legal footer is made of, in the three languages.
 *
 * Matched against a *paragraph*, and only a long one. "the meeting is
 * confidential" is a sentence a parent might write and a proposal worth making;
 * sixty characters of it with the word "recipient" in is a lawyer's paragraph
 * nobody committed to.
 */
const DISCLAIMER_WORDS =
  /confidential|confidentiality|privileged|intended (?:solely|only|recipient)|intended for the (?:addressee|recipient)|received (?:it|this) in error|do not disclose|unauthoris?ed (?:use|disclosure)|disclaimer|سري|سرية|المرسل إليه|بالخطأ|إخلاء المسؤولية|إخلاء مسؤولية|חסוי|סודי|מיועדת? (?:אך ורק|בלבד)|בטעות/i;
/** Short enough to be a sentence someone meant. */
const MIN_DISCLAIMER_CHARACTERS = 60;

/** The blank-line-separated paragraphs of a body, with their blanks normalised. */
export function paragraphsOf(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}

function dropDisclaimers(text: string): { text: string; disclaimer: boolean } {
  const paragraphs = paragraphsOf(text);
  const kept = paragraphs.filter(
    (paragraph) => !(paragraph.length >= MIN_DISCLAIMER_CHARACTERS && DISCLAIMER_WORDS.test(paragraph)),
  );
  return { text: kept.join('\n\n'), disclaimer: kept.length !== paragraphs.length };
}

/* ── Masking ───────────────────────────────────────────────────── */

const ADDRESS = /(?:mailto:)?[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/**
 * Something with enough digits in it to be a phone number.
 *
 * The separator class deliberately excludes `:` and `/`, so `09:14` and
 * `10/09/2026` are a time and a date rather than half a phone number, and the
 * digit count is checked after the fact: a fee of "40 shekels" and a year of
 * "2026" are not phone numbers and must survive, because the sentence they are
 * in is a commitment.
 */
const PHONE_CANDIDATE = /[+]?[\d٠-٩۰-۹][\d٠-٩۰-۹ ().+-]{5,}[\d٠-٩۰-۹]/g;
const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15;

function digitsIn(value: string): number {
  return (value.match(/[\d٠-٩۰-۹]/g) ?? []).length;
}

/**
 * Replaces every address and every phone number with a fixed token.
 *
 * This is the acceptance criterion "addresses and phone numbers never reach the
 * model", and it is enforced here rather than in the prompt because a prompt is
 * a request and this is a fact about the string. The channel calls it on the
 * body it is about to send and on nothing else, so there is one place to read.
 */
export function maskContactDetails(text: string): { text: string; masked: EmailMasking } {
  let emails = 0;
  const withoutAddresses = text.replace(ADDRESS, () => { emails += 1; return EMAIL_MASK; });
  let phones = 0;
  const masked = withoutAddresses.replace(PHONE_CANDIDATE, (candidate) => {
    const count = digitsIn(candidate);
    if (count < MIN_PHONE_DIGITS || count > MAX_PHONE_DIGITS) return candidate;
    phones += 1;
    return PHONE_MASK;
  });
  return { text: masked, masked: { emails, phones } };
}

/* ── The whole thing ───────────────────────────────────────────── */

/**
 * One email, reduced to the part somebody is being asked to do something about.
 *
 * @throws ShareInputError 415 when handed a MIME multipart container.
 */
export function cleanEmail(raw: string): CleanedEmail {
  const normalized = raw.replace(/\r\n?/g, '\n');
  if (MIME_MULTIPART.test(normalized)) {
    throw new ShareInputError(415, 'email_mime_unsupported', 'select the text of the email and share that');
  }

  const forwarded = FORWARD_MARKER.exec(normalized);
  // A forward keeps its inner message: the divider and the header block under
  // it go, and the scan below re-reads the forwarded Subject and Date, which
  // are the ones that describe what the user actually shared.
  const afterForward = forwarded
    ? normalized.slice(forwarded.index + forwarded[0].length)
    : normalized;

  const headers = scanHeaders(afterForward.split('\n'));
  const quoted = cutQuotedHistory(headers.rest);
  const withoutDisclaimers = dropDisclaimers(quoted.text);
  const signature = cutSignature(withoutDisclaimers.text);
  const masked = maskContactDetails(signature.text);

  return {
    subject: headers.subject === null ? null : maskContactDetails(headers.subject).text,
    sentAt: headers.sentAt,
    body: paragraphsOf(masked.text).join('\n\n').slice(0, MAX_EMAIL_BODY_CHARACTERS),
    removed: {
      quoted: quoted.quoted,
      signature: signature.signature,
      disclaimer: withoutDisclaimers.disclaimer,
    },
    masked: masked.masked,
  };
}
