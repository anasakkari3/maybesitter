/**
 * Whether a piece of shared text is an email (UC-3.8, #192 step 2).
 *
 * ── Two signals, never one ───────────────────────────────────────
 *
 * Any single email-ish thing is also an ordinary thing somebody types. A line
 * starting «من:» is a header and is also the Arabic word "from" at the start of
 * a sentence. An address in the text is a header and is also "email me at
 * dana@…". «مع التحية» is a sign-off and is also how a message to a teacher
 * ends. One signal would route half the clipboard through an email cleaner that
 * would then cut a real sentence off at a sign-off it invented.
 *
 * So four independent signals, two of which must hold. The greeting and the
 * sign-off count as **one** signal together for the same reason: each alone is
 * a way people write anything.
 *
 * ── This file has a twin ─────────────────────────────────────────
 *
 * `mobile/src/features/share/emailTextDetector.ts` is the same predicate for
 * the RN client, which cannot import across the workspace boundary. The two are
 * kept honest by `tests/share/exportEmailDetectorCases.test.ts`, which writes
 * the hand-declared case list to `mobile/src/features/share/__fixtures__/`;
 * both suites assert against the same expectations, so a change to one
 * implementation and not the other fails CI rather than a user's paste.
 *
 * **If you edit a pattern here, edit the same pattern there.** The cases are
 * the contract; the regexes are two copies of one answer to it.
 */

/**
 * A header line: a known field name at the start of a line, then a colon.
 *
 * Anchored with `m` so it is a *line*, not a word. `Subject:` in the middle of
 * a sentence is somebody talking about a subject.
 */
const HEADER_LINE =
  /^[ \t]*(?:from|to|cc|bcc|subject|date|sent|reply-to|من|إلى|الى|الموضوع|التاريخ|נשלח|מאת|אל|נושא|תאריך)[ \t]*:/im;

/**
 * "On … wrote:" and its Arabic, Hebrew and Outlook spellings.
 *
 * The body may be wrapped, so the span between the opener and the verb crosses
 * lines — Gmail breaks exactly there when the quoted sender's address is long.
 * Bounded at 200 characters so a runaway match cannot swallow a page.
 */
const REPLY_MARKER =
  /^[ \t]*(?:on\b[\s\S]{0,200}?\bwrote[ \t]*:|-{2,}[ \t]*original message[ \t]*-{2,}|_{5,}[ \t]*$|في[\s\S]{0,200}?كتب[ \t]*:|ב[-–][\s\S]{0,200}?כתב[ \t]*:|בתאריך[\s\S]{0,200}?כתב[ \t]*:|-{2,}[ \t]*הודעה מקורית[ \t]*-{2,}|-{2,}[ \t]*الرسالة الأصلية[ \t]*-{2,})/im;

/** Gmail's forward divider, in the three languages this product speaks. */
const FORWARD_MARKER =
  /^[ \t]*-{3,}[ \t]*(?:forwarded message|رسالة معاد توجيهها|رسالة محولة|הודעה שהועברה)[ \t]*-{3,}/im;

/** A mailto-style address. The one signal that needs no line anchor. */
const ADDRESS = /(?:mailto:)?[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** How a message opens. */
const GREETING =
  /^[ \t]*(?:dear\b|hi\b|hello\b|good (?:morning|afternoon|evening)\b|أهلا|أهلاً|مرحبا|مرحباً|السلام عليكم|عزيزي|عزيزتي|حضرة|שלום|היי|אהלן)/im;

/**
 * How a message closes: a sign-off alone on its line.
 *
 * Alone on its line matters. "thanks for the form" is not a sign-off, and a
 * pattern that matched it would end every grateful sentence in a signature cut.
 */
const SIGN_OFF =
  /^[ \t]*(?:best regards|kind regards|warm regards|regards|best wishes|all the best|sincerely|yours sincerely|yours truly|many thanks|thanks|thank you|cheers|مع التحية|مع الشكر|تحياتي|مع خالص التقدير|وتفضلوا بقبول فائق الاحترام|شكرا|شكراً|בברכה|בכבוד רב|תודה רבה|תודה|כל טוב)[ \t]*[,.!،؛]?[ \t]*$/im;

/**
 * Which of the four signals this text carries.
 *
 * Exported so a test can say *why* a case was classified the way it was. A
 * boolean alone makes a regression look like a different boolean rather than
 * like a signal that stopped firing.
 */
export function emailSignals(text: string): readonly string[] {
  const found: string[] = [];
  if (HEADER_LINE.test(text)) found.push('headers');
  if (GREETING.test(text) && SIGN_OFF.test(text)) found.push('greeting_signoff');
  if (REPLY_MARKER.test(text) || FORWARD_MARKER.test(text)) found.push('reply_marker');
  if (ADDRESS.test(text)) found.push('address');
  return found;
}

/** True when at least two independent signals say this is an email. */
export function looksLikeEmail(text: string): boolean {
  if (typeof text !== 'string' || text.trim() === '') return false;
  return emailSignals(text).length >= 2;
}
