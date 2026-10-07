/**
 * What the capture chat may say to the person, and what it says instead
 * (owner decision 2026-09-30).
 *
 * The model writes the reply; this decides whether it may be shown. A reply is
 * a suggestion's caption, and the proposal is only a suggestion: nothing is
 * saved until the person confirms. So a reply that says otherwise — "I added
 * it to your calendar", «ضفتها», «הוספתי» — is replaced, whole, by a template
 * built from the proposal. So is a reply that is too long, carries a link, or
 * is in another language than the person wrote.
 *
 * A good reply that does not ask for what an item is still missing is kept,
 * and the one question is added after it — the day, the hour, or both, as
 * the item's clarification says (chat UAT, 2026-09-30): replacing it threw
 * away the model's acknowledgement of an edit, and the template asked for
 * "the day and the time" when only the hour was missing.
 *
 * Every check reads at most `CHAT_REPLY_SCAN_LIMIT` characters: a reply longer
 * than that is refused on its length before any pattern sees it.
 */
import { foldInjectionPattern, normalizeForInjectionScan } from '../../../src/extraction/ollamaExtractor';
import type { CaptureProposalContract } from '../../../src/contracts/v1/captureContracts';
import { localTimeSpecFor, statesClock } from '../../../src/extraction/timeLexicon';
import { contentWords, namesOnlyItem, sameWord } from '../captureBoundary/chatEvidence';
import { groundedReply, type ReplyGrounds } from './chatWhy';

export type ChatLanguage = 'ar' | 'en' | 'he';

/** The longest reply the chat shows. */
export const CHAT_REPLY_MAX_CHARACTERS = 400;
/** Past this a reply is refused on its length alone, before any pattern reads it. */
const CHAT_REPLY_SCAN_LIMIT = 2_000;
/** The longest title a template quotes. */
const TEMPLATE_TITLE_MAX = 60;

const ARABIC_LETTER = new RegExp('[\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFC]', 'g');
const HEBREW_LETTER = new RegExp('[\\u0590-\\u05FF\\uFB1D-\\uFB4F]', 'g');
const LATIN_LETTER = /[A-Za-z]/g;

/**
 * The language a message is written in, by its letters; `fallback` when it
 * has none («6», "?"). Arabic first on a tie: the product is Arabic-first.
 */
export function detectChatLanguage(text: string, fallback: ChatLanguage = 'ar'): ChatLanguage {
  const sample = text.slice(0, CHAT_REPLY_SCAN_LIMIT);
  const arabic = sample.match(ARABIC_LETTER)?.length ?? 0;
  const hebrew = sample.match(HEBREW_LETTER)?.length ?? 0;
  const latin = sample.match(LATIN_LETTER)?.length ?? 0;
  if (arabic === 0 && hebrew === 0 && latin === 0) return fallback;
  if (arabic >= hebrew && arabic >= latin) return 'ar';
  if (hebrew >= latin) return 'he';
  return 'en';
}

/** A link of any kind. The chat never sends the person anywhere. */
const URL_PATTERN = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|app|ly|co|me|info|link|to|gl)\b|\bwebcal:/i;

/**
 * A claim that something was kept: saved, added, scheduled, booked, set, or a
 * reminder promised. In the three languages, folded exactly as the injection
 * patterns are (`foldInjectionPattern`), so a hamza, a shadda, niqqud or a
 * tatweel cannot slip a claim past it.
 */
const SAVED_CLAIMS: readonly RegExp[] = [
  // en: "I added / I've saved / we scheduled / I put it"
  /\b(?:i|we)(?:'ve|'d|\s+have|\s+just|\s+already|\s+now)*\s+(?:added|saved|scheduled|booked|created|stored|recorded|logged|entered|reminded|put\s+(?:it|them|that|this))\b/i,
  // en: "I've set it", "I'll remind you", "we will remind you"
  /\b(?:i|we)(?:'ve|\s+have)\s+(?:just\s+|already\s+)?set\b/i,
  /\b(?:i|we)(?:'ll|\s+will)\s+(?:be\s+sure\s+to\s+)?remind\b/i,
  // en: "it's saved / it has been added / they are now scheduled"
  /\b(?:it|they|that|this|these|those|everything|reminders?)(?:'s|'re|\s+is|\s+are|\s+has|\s+have|\s+was|\s+were|\s+been|\s+now|\s+all)+\s+(?:added|saved|scheduled|booked|created|stored|recorded|set)\b/i,
  // en: "added it to your calendar", "saved to the list"
  /\b(?:added|saved|scheduled|booked|put)\b[^.!?\n]{0,20}\b(?:to|on|in|into)\s+(?:your|the)\s+(?:calendar|list|schedule|agenda|reminders?|plan|day)\b/i,
  /\b(?:all set|you're all set)\b/i,
  // ar: «ضفت/ضفتها/أضفت/انضاف/حفظت/انحفظ/سجّلت/انسجل/حطيت/جدولت/ضبطت»
  foldInjectionPattern(new RegExp(
    '(?<![\\p{L}\\p{M}])[وف]?(?:ضفت|ضفتها|ضفتهم|ضفتلك|ضفتلكها|أضفت|أضفتها|أضفتهم|أضفتلك|انضاف|انضافت|انضافو|انضافوا|حفظت|حفظتها|حفظتهم|حفظتلك|انحفظ|انحفظت|انحفظو|سجلت|سجلتها|سجلتهم|سجلتلك|انسجل|انسجلت|اتسجل|اتسجلت|تسجلت|حطيت|حطيتها|حطيتهم|حطيتلك|جدولت|جدولتها|جدولتلك|ضبطت|ضبطتها|ضبطتلك)(?![\\p{L}\\p{M}])',
    'u',
  )),
  // ar: «تم الحفظ», «تمت الإضافة», «صار التسجيل»
  foldInjectionPattern(new RegExp('(?<![\\p{L}\\p{M}])(?:تم|تمت|صار)\\s+(?:ال)?(?:حفظ|إضافة|اضافة|تسجيل|جدولة|تذكير|ضبط)', 'u')),
  // ar: a promised reminder, «رح ذكرك», «بذكرك», «حنبهك»
  foldInjectionPattern(new RegExp(
    '(?<![\\p{L}\\p{M}])(?:(?:رح|راح|ح)\\s*(?:أ|ا|ن)?(?:ذكرك|نبهك)|بذكرك|بنبهك|حذكرك|حنبهك|سأذكرك|سأنبهك)(?![\\p{L}\\p{M}])',
    'u',
  )),
  // he: «הוספתי/שמרתי/קבעתי/רשמתי/נשמר/נוסף/נקבע/אזכיר»
  foldInjectionPattern(new RegExp(
    '(?<![\\p{L}\\p{M}])[וש]?(?:הוספתי|שמרתי|קבעתי|רשמתי|תזמנתי|הכנסתי|שמתי|נשמר|נשמרה|נשמרו|נוסף|נוספה|נוספו|נקבע|נקבעה|נקבעו|נרשם|נרשמה|נרשמו|אזכיר)(?![\\p{L}\\p{M}])',
    'u',
  )),
];

/** Whether a reply claims that something was saved, added, scheduled or will be reminded. */
export function claimsSaved(reply: string): boolean {
  const folded = normalizeForInjectionScan(reply.slice(0, CHAT_REPLY_SCAN_LIMIT)).replace(/\s+/g, ' ');
  return SAVED_CLAIMS.some((pattern) => pattern.test(folded));
}

type TemplateKind = 'proposed' | 'updated' | 'understood' | 'unresolved' | 'ask' | 'nothing' | 'off_topic' | 'cleared' | 'refused' | 'acknowledged' | 'edit_failed' | 'already_saved';

const TEMPLATES: Readonly<Record<ChatLanguage, Readonly<Record<TemplateKind, string>>>> = {
  // Spoken Levantine, not MSA: the product's own voice.
  ar: {
    proposed: 'هيك فهمت. شوف القائمة وإذا كلها تمام أكّدها.',
    updated: 'تمام، غيّرتها. شوف القائمة وإذا كلها تمام أكّدها.',
    understood: 'هيك فهمت لحد هلّق.',
    unresolved: 'فهمت عليك. إذا بدك، منقدر نحولها لخطوة واضحة بعدين.',
    acknowledged: 'تمام، غيّرتها.',
    edit_failed: 'ما قدرت أطبّق التعديل هلّق — عدّله من الكرت تحت.',
    already_saved: 'القائمة انحفظت من قبل.',
    ask: 'إيمتى بدك «{title}»؟ احكيلي اليوم والساعة.',
    nothing: 'شو بدك تعمل وإيمتى؟ احكيلي وأنا بجهزلك ياها لتأكدها.',
    off_topic: 'أنا هون لأساعدك بالمهام والمواعيد تبعك. شو في عندك تعمله؟',
    cleared: 'تمام، شلتها من القائمة. في إشي تاني؟',
    refused: 'بهاد ما بقدر ساعد. احكيلي شو بدك تعمل وإيمتى.',
  },
  en: {
    proposed: "Here's what I understood. Check the list and confirm it if it looks right.",
    updated: 'Okay, I changed that. Check the list and confirm it if it looks right.',
    understood: "Here's what I understood so far.",
    unresolved: 'I understand. If you want, we can turn that into a clear next step later.',
    acknowledged: 'Okay, I changed that.',
    edit_failed: "I couldn't apply that change right now — edit it on the card below.",
    already_saved: 'That list was already saved.',
    ask: 'When do you want to do "{title}"? Tell me the day and the time.',
    nothing: "What do you need to do, and when? Tell me and I'll set it up for you to confirm.",
    off_topic: "I'm here to help with your commitments and plans. What do you need to get done?",
    cleared: 'Okay, I took it off the list. Anything else?',
    refused: "I can't help with that. Tell me what you need to do and when.",
  },
  he: {
    proposed: 'זה מה שהבנתי. אפשר לבדוק את הרשימה ולאשר אם היא נכונה.',
    updated: 'בסדר, שיניתי. אפשר לבדוק את הרשימה ולאשר אם היא נכונה.',
    understood: 'זה מה שהבנתי עד עכשיו.',
    unresolved: 'הבנתי. אם תרצה, נוכל להפוך את זה אחר כך לצעד ברור.',
    acknowledged: 'בסדר, שיניתי.',
    edit_failed: 'לא הצלחתי להחיל את השינוי כרגע — אפשר לערוך אותו בכרטיס למטה.',
    already_saved: 'הרשימה הזאת כבר נשמרה.',
    ask: 'מתי לעשות את "{title}"? מה היום ומה השעה?',
    nothing: 'מה צריך לעשות, ומתי? אכין את זה בשבילך לאישור.',
    off_topic: 'אני כאן כדי לעזור עם המשימות והפגישות שלך. מה צריך לעשות?',
    cleared: 'בסדר, הורדתי את זה מהרשימה. עוד משהו?',
    refused: 'בזה אני לא יכול לעזור. מה צריך לעשות, ומתי?',
  },
};

/** What an item still needs, as its clarification asks it. */
type MissingKind = 'day' | 'hour' | 'am_pm' | 'when' | 'action';

/**
 * One question for exactly what is missing. `when` is the day and the hour
 * together — the old `ask` template, kept word for word.
 */
const QUESTIONS: Readonly<Record<ChatLanguage, Readonly<Record<Exclude<MissingKind, 'when'>, string>>>> = {
  ar: {
    day: 'أي يوم بدك «{title}»؟',
    hour: 'أي ساعة بدك «{title}»؟',
    am_pm: '«{title}» الصبح ولا المسا؟',
    action: 'شو بالزبط بدك تعمل بـ«{title}»؟',
  },
  en: {
    day: 'Which day is "{title}"?',
    hour: 'What time is "{title}"?',
    am_pm: 'Is "{title}" in the morning or the evening?',
    action: 'What exactly do you need to do for "{title}"?',
  },
  he: {
    day: 'באיזה יום "{title}"?',
    hour: 'באיזו שעה "{title}"?',
    am_pm: '"{title}" בבוקר או בערב?',
    action: 'מה בדיוק צריך לעשות ב"{title}"?',
  },
};

const TIME_UNCLEAR: Readonly<Record<ChatLanguage, { lead: string; question: string }>> = {
  ar: { lead: 'الساعة مش واضحة عندي.', question: 'أي ساعة بدك؟' },
  en: { lead: "The time wasn't clear.", question: 'What time should it be?' },
  he: { lead: 'השעה לא הייתה ברורה.', question: 'באיזו שעה זה צריך להיות?' },
};

type ProposalItemLike = Pick<CaptureProposalContract['items'][number], 'title'> & Partial<Pick<CaptureProposalContract['items'][number], 'needsClarification' | 'resolvedDate' | 'clarification' | 'resolvedTime' | 'timeEstimated'>>;
type ProposalLike = { items: readonly ProposalItemLike[]; seeds?: readonly unknown[]; noCommitmentReason?: CaptureProposalContract['noCommitmentReason'] };

/** The first item still asking for its day or time, if any. */
function itemAskingForTime(proposal: ProposalLike | null): ProposalItemLike | null {
  return proposal?.items.find((item) => item.needsClarification) ?? null;
}

/**
 * What the item is missing, by its own question: the day («أي يوم؟»), the
 * hour on a day it has («أي ساعة؟» — never "the day and the time" when the
 * day was said), which half of the day, or both.
 */
function missingKind(item: ProposalItemLike): MissingKind {
  const question = item.clarification;
  switch (question?.questionKey) {
    case 'ask_day': return 'day';
    case 'ask_am_pm': return 'am_pm';
    case 'ask_action': return 'action';
    case 'ask_time': return question.params?.date || item.resolvedDate ? 'hour' : 'when';
    default: return item.resolvedDate ? 'hour' : 'when';
  }
}

/** The one question for what the item is missing, in the person's language. */
export function missingQuestion(language: ChatLanguage, item: ProposalItemLike): string {
  const title = item.title.length > TEMPLATE_TITLE_MAX ? `${item.title.slice(0, TEMPLATE_TITLE_MAX - 1)}…` : item.title;
  const kind = missingKind(item);
  const template = kind === 'when' ? TEMPLATES[language].ask : QUESTIONS[language][kind];
  return template.replace('{title}', title);
}

export interface TemplateContext {
  language: ChatLanguage;
  proposal: ProposalLike | null;
  /** The conversation had a proposal before this turn and has none after it. */
  cleared?: boolean;
  /** The message was not about anything to do. */
  offTopic?: boolean;
  /** The message was refused before the model (an injection). */
  refused?: boolean;
  /** The person changed the list («خلّيها الساعة 6», "make the dentist 5pm"): the reply says so. */
  updated?: boolean;
  /** The person's zone, to say an hour the proposal settled on. */
  timezone?: string;
  /** An edit of the list the rules could not apply: the list is unchanged. */
  editFailed?: boolean;
  /** The words did not state one complete clock that agreed with the model. */
  timeUnclear?: boolean;
  /** A transport retry arrived after the proposal in its receipt was confirmed. */
  alreadySaved?: boolean;
  /**
   * What the model's reply may be grounded in (owner request 2026-09-30):
   * with it, a sentence giving a reason the person never gave, or claiming
   * or offering around a clash that is not there, is taken out (`chatWhy`).
   */
  grounds?: ReplyGrounds;
}

/** One safe reply, built from the proposal and nothing the model wrote. */
export function templateReply(context: TemplateContext): string {
  const table = TEMPLATES[context.language];
  if (context.alreadySaved) return table.already_saved;
  if (context.refused) return table.refused;
  if (context.timeUnclear) {
    const copy = TIME_UNCLEAR[context.language];
    const asking = itemAskingForTime(context.proposal);
    return `${copy.lead} ${asking ? missingQuestion(context.language, asking) : copy.question}`;
  }
  if (context.editFailed) return table.edit_failed;
  const asking = itemAskingForTime(context.proposal);
  if (asking) {
    const question = missingQuestion(context.language, asking);
    return `${context.updated ? table.acknowledged : table.understood} ${question}`;
  }
  if (context.proposal && context.proposal.items.length > 0) return context.updated ? table.updated : table.proposed;
  if ((context.proposal?.seeds?.length ?? 0) > 0) return table.unresolved;
  if (context.cleared) return table.cleared;
  const reason = context.proposal?.noCommitmentReason;
  if (context.offTopic || reason === 'question' || reason === 'greeting_or_chat') return table.off_topic;
  return table.nothing;
}

/** Why a model reply was not shown — content-free, for tests and counts. */
export type ReplyRejection = 'not_text' | 'empty' | 'too_long' | 'link' | 'claims_saved' | 'wrong_language' | 'does_not_ask';

/** The model's reply, if it may be shown; otherwise why not. */
export function checkModelReply(reply: unknown, context: TemplateContext): { ok: true; reply: string } | { ok: false; rejection: ReplyRejection } {
  if (typeof reply !== 'string') return { ok: false, rejection: 'not_text' };
  if (reply.length > CHAT_REPLY_SCAN_LIMIT) return { ok: false, rejection: 'too_long' };
  const text = reply.trim();
  if (!text) return { ok: false, rejection: 'empty' };
  if (text.length > CHAT_REPLY_MAX_CHARACTERS) return { ok: false, rejection: 'too_long' };
  if (URL_PATTERN.test(text)) return { ok: false, rejection: 'link' };
  if (claimsSaved(text)) return { ok: false, rejection: 'claims_saved' };
  if (detectChatLanguage(text, context.language) !== context.language) return { ok: false, rejection: 'wrong_language' };
  // The proposal still needs one particular field. Any question is not enough:
  // «تمام؟» acknowledges the item but never asks for its missing hour.
  const asking = itemAskingForTime(context.proposal);
  if (asking && !asksForMissing(text, asking)) return { ok: false, rejection: 'does_not_ask' };
  return { ok: true, reply: text };
}

/** A question for a day or an hour: "what time", «أي ساعة», «إيمتى», «באיזו שעה». */
const TIME_QUESTION = new RegExp([
  '\\b(?:what\\s+time|which\\s+day|what\\s+day|when)\\b',
  '(?:أي|اي|بأي|باي)\\s+(?:ساعة|ساعه|يوم|وقت)',
  '(?:إيمتى|ايمتى|امتى|إمتى|قديش\\s+الساعة|الساعة\\s+كم|كم\\s+الساعة)',
  '(?:באיזו|איזו)\\s+שעה|(?:באיזה|איזה)\\s+יום|מתי',
].join('|'), 'iu');

/** A reply's sentences, each with its own end mark. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?؟…])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

const isQuestion = (sentence: string): boolean => /[?؟]/.test(sentence);

function asksForMissing(text: string, item: ProposalItemLike): boolean {
  if (!/[?؟]/.test(text)) return false;
  switch (missingKind(item)) {
    case 'day': return /\b(?:which|what)\s+day\b|(?:أي|اي|بأي|باي)\s+يوم|(?:באיזה|איזה)\s+יום/i.test(text);
    case 'hour': return /\bwhat\s+time\b|(?:أي|اي|بأي|باي)\s+(?:ساعة|ساعه|وقت)|الساعة\s+كم|كم\s+الساعة|(?:באיזו|איזו)\s+שעה/i.test(text);
    case 'am_pm': return /(?:morning.*evening|evening.*morning)|(?:الصبح.*المسا|المسا.*الصبح)|(?:בבוקר.*בערב|בערב.*בבוקר)/i.test(text);
    case 'action': return /\bwhat\b.*\b(?:do|action)\b|شو\s+بالزبط|מה\s+בדיוק/i.test(text);
    case 'when': return TIME_QUESTION.test(text);
  }
}

/** "It is at 09:00 for now", for an item the proposal settled on the hour of a part of the day. */
const SETTLED_NOTE: Readonly<Record<ChatLanguage, string>> = {
  ar: '«{title}» عالساعة {time}، وإذا بدك ساعة تانية احكيلي.',
  en: '"{title}" is at {time} for now. Tell me if you want another time.',
  he: '"{title}" בשעה {time} בינתיים. אפשר להגיד לי שעה אחרת.',
};

/**
 * The model's words brought into line with the proposal (chat UAT round 2):
 *
 *   an item still asked about   a sentence that names it with an hour — "I
 *                               changed the second to 7" — is not true of
 *                               it, and goes: the reply never claims a change
 *                               and asks for it at once;
 *   nothing asked about         a question for a day or an hour («أي ساعة؟»,
 *                               "What time on Sunday morning?") asks for what
 *                               the card already has, and goes; for an item
 *                               settled on a part of the day's hour, the reply
 *                               says the hour instead, and that it can change.
 */
function alignedWithProposal(text: string, context: TemplateContext): string {
  const asking = itemAskingForTime(context.proposal);
  const sentences = sentencesOf(text);
  if (asking) {
    const others = (context.proposal?.items ?? []).filter((item) => item !== asking).map((item) => item.title);
    return sentences.filter((sentence) => isQuestion(sentence) || !(statesClock(sentence) && namesOnlyItem(sentence, asking.title, others))).join(' ');
  }
  const kept = sentences.filter((sentence) => !(isQuestion(sentence) && TIME_QUESTION.test(sentence)));
  if (kept.length === sentences.length) return text;
  const settled = context.proposal?.items.find((item) => item.timeEstimated && item.resolvedTime);
  const time = settled?.resolvedTime && context.timezone ? localTimeSpecFor(new Date(settled.resolvedTime), context.timezone)?.time : null;
  if (settled && time) {
    const title = settled.title.length > TEMPLATE_TITLE_MAX ? `${settled.title.slice(0, TEMPLATE_TITLE_MAX - 1)}…` : settled.title;
    kept.push(SETTLED_NOTE[context.language].replace('{title}', title).replace('{time}', time));
  }
  return kept.join(' ');
}

/**
 * The reply the person sees: the model's when it passes, brought into line
 * with the proposal (`alignedWithProposal`); with the missing question added
 * when that is all it lacks; the template otherwise.
 */
export function safeChatReply(reply: unknown, context: TemplateContext): { reply: string; replaced: boolean } {
  const checked = checkModelReply(reply, context);
  const usable = checked.ok || checked.rejection === 'does_not_ask';
  if (!usable || typeof reply !== 'string') return { reply: templateReply(context), replaced: true };
  const aligned = alignedWithProposal(reply.trim(), context).trim();
  let text = context.grounds ? groundedReply(aligned, context.grounds).trim() : aligned;
  if (!text) return { reply: templateReply(context), replaced: true };
  const asking = itemAskingForTime(context.proposal);
  if (asking && !asksForMissing(text, asking)) {
    // Keep a grounded acknowledgement, but discard an unrelated question.
    text = sentencesOf(text).filter((sentence) => !isQuestion(sentence)).join(' ').trim();
    const opening = text || TEMPLATES[context.language].understood;
    const ended = /[.!?؟。…]$/.test(opening) ? opening : `${opening}.`;
    return { reply: `${ended} ${missingQuestion(context.language, asking)}`, replaced: checked.ok === false };
  }
  if (asking && isQuestion(sentencesOf(text)[0] ?? '')) {
    return { reply: `${TEMPLATES[context.language].understood} ${text}`, replaced: false };
  }
  return { reply: text, replaced: false };
}

/* ── the reply after the proposal's shape (audit 2026-10-03 #1, #6) ── */

const SHAPE_NOTES: Readonly<Record<ChatLanguage, { goalSeed: string; goalLinkOne: string; goalLinkMany: string }>> = {
  ar: {
    goalSeed: '«{title}» هدف أكتر منه موعد، فهو تحت لحال: إذا بدك خلّيه.',
    goalLinkOne: 'اقترحت تنحسب على هدفك «{goal}»، وبتقدر تشيل الربط من الكرت.',
    goalLinkMany: 'اقترحت ينحسبوا على هدفك «{goal}»، وبتقدر تشيل الربط من الكروت.',
  },
  en: {
    goalSeed: '"{title}" sounds like a goal rather than an appointment, so it is below on its own: keep it if you want.',
    goalLinkOne: 'I suggested counting it toward your goal "{goal}" — you can remove that on the card.',
    goalLinkMany: 'I suggested counting them toward your goal "{goal}" — you can remove that on the cards.',
  },
  he: {
    goalSeed: '"{title}" נשמע כמו מטרה ולא כמו פגישה, אז הוא מופיע למטה בנפרד: אפשר לשמור אותו.',
    goalLinkOne: 'הצעתי לספור את זה למטרה "{goal}" — אפשר להסיר את זה בכרטיס.',
    goalLinkMany: 'הצעתי לספור אותם למטרה "{goal}" — אפשר להסיר את זה בכרטיסים.',
  },
};

const QUOTED_TITLE = /«([^»]{1,120})»|"([^"]{1,120})"|“([^”]{1,120})”/g;

function clippedTitle(title: string): string {
  return title.length > TEMPLATE_TITLE_MAX ? `${title.slice(0, TEMPLATE_TITLE_MAX - 1)}…` : title;
}

type ShapeProposal = {
  items: ReadonlyArray<ProposalItemLike & { goalLink?: { title: string } }>;
  seeds?: ReadonlyArray<{ kind: string; summary: string }>;
  noCommitmentReason?: CaptureProposalContract['noCommitmentReason'];
};

export interface ShapeContext {
  language: ChatLanguage;
  /** What the model returned, before the boundary read it: its titles only are read. */
  modelItems: readonly unknown[];
  proposal: ShapeProposal | null;
  /** The list the person saw before this message, so a note already given is not given again. */
  previous: ShapeProposal | null;
  updated?: boolean;
}

/**
 * The reply brought into line with the list the boundary actually proposes
 * (`proposalShape`): a sentence naming, in quotes, something of the model's
 * that is no longer a card — "learn React" taken off the timed list — goes;
 * and what was done instead is said once, from the proposal, never from the
 * model: the goal offered below on its own, the goal the items may count
 * toward. A reply left with nothing is the template.
 */
export function withShapeNoted(reply: string, context: ShapeContext): string {
  const cards = (context.proposal?.items ?? []).map((item) => contentWords(item.title));
  const offTheList = context.modelItems.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const titles = [record.title, record.appTitle].filter((title): title is string => typeof title === 'string' && title.trim().length > 0);
    const kept = titles.some((title) => contentWords(title).some((word) => cards.some((card) => card.some((candidate) => sameWord(word, candidate)))));
    return kept ? [] : titles.map((title) => contentWords(title));
  });
  const namesOffTheList = (sentence: string) => Array.from(sentence.slice(0, CHAT_REPLY_SCAN_LIMIT).matchAll(QUOTED_TITLE)).some((match) => {
    const words = contentWords(match[1] ?? match[2] ?? match[3] ?? '');
    return words.length > 0 && offTheList.some((title) => words.some((word) => title.some((candidate) => sameWord(word, candidate))))
      && !cards.some((card) => words.some((word) => card.some((candidate) => sameWord(word, candidate))));
  });
  const seedTitles = (context.proposal?.seeds ?? []).map((seed) => contentWords(seed.summary));
  const namesSeedAsTimed = (sentence: string) => statesClock(sentence)
    && Array.from(sentence.slice(0, CHAT_REPLY_SCAN_LIMIT).matchAll(QUOTED_TITLE)).some((match) => {
      const words = contentWords(match[1] ?? match[2] ?? match[3] ?? '');
      return words.length > 0 && seedTitles.some((title) => words.some((word) => title.some((candidate) => sameWord(word, candidate))));
    });
  const sentences = sentencesOf(reply);
  const remaining = sentences.filter((sentence) => !namesSeedAsTimed(sentence)
    && (offTheList.length === 0 || !namesOffTheList(sentence)));
  // What is left after a sentence went names no card («أكّد من تحت.» alone):
  // the template says the list instead.
  const kept = remaining.length === sentences.length || new RegExp(QUOTED_TITLE.source).test(remaining.join(' '))
    ? remaining.join(' ')
    : '';

  const notes: string[] = [];
  const table = SHAPE_NOTES[context.language];
  const before = new Set((context.previous?.seeds ?? []).filter((seed) => seed.kind === 'possible_goal').map((seed) => seed.summary));
  for (const seed of context.proposal?.seeds ?? []) {
    if (seed.kind === 'possible_goal' && !before.has(seed.summary)) notes.push(table.goalSeed.replace('{title}', clippedTitle(seed.summary)));
  }
  const linkedBefore = new Set((context.previous?.items ?? []).flatMap((item) => (item.goalLink ? [item.goalLink.title] : [])));
  const linkedNow = Array.from(new Set((context.proposal?.items ?? []).flatMap((item) => (item.goalLink ? [item.goalLink.title] : []))));
  for (const goal of linkedNow) {
    if (linkedBefore.has(goal)) continue;
    const count = (context.proposal?.items ?? []).filter((item) => item.goalLink?.title === goal).length;
    notes.push((count > 1 ? table.goalLinkMany : table.goalLinkOne).replace('{goal}', clippedTitle(goal)));
  }

  const text = kept.trim() || (notes.length > 0 || remaining.length !== sentences.length
    ? templateReply({ language: context.language, proposal: context.proposal, ...(context.updated ? { updated: true } : {}) })
    : '');
  if (notes.length === 0) return text;
  const ended = /[.!?؟。…]$/.test(text) ? text : `${text}.`;
  return `${ended} ${notes.join(' ')}`.trim();
}

/* ── weekly, once the end is known (audit 2026-10-03 review, orchestrator's decision) ── */

const WEEKLY_OFFER: Readonly<Record<ChatLanguage, string>> = {
  ar: 'إذا بدك ياه كل أسبوع، قلّي لأي ساعة بيخلص.',
  en: 'If you want it every week, tell me what time it ends.',
  he: 'אם רוצים את זה כל שבוע, ספרו לי עד איזו שעה זה.',
};

type WeeklyLike = { items: ReadonlyArray<{ needsClarification?: boolean; recurrenceHint?: { weekdays?: number[]; start?: string; end?: string } | null; weeklyBlock?: unknown }> };

/**
 * Whether the list holds a repeat over several days that it cannot keep as
 * weekly yet — "every Tuesday and Thursday at 7 PM": an hour, no end, so no
 * weekly block to offer — and nothing on it is still being asked about.
 * One day ("every Friday at 8pm take out the trash") is a one-off the person
 * can keep weekly from its own card; it gets no line (round 2).
 */
function multiDayWithoutEnd(proposal: WeeklyLike | null): boolean {
  const items = proposal?.items ?? [];
  if (items.length === 0 || items.some((item) => item.needsClarification)) return false;
  const open = items.filter((item) => Boolean(item.recurrenceHint?.start) && !item.recurrenceHint?.end && !item.weeklyBlock);
  const byStart = new Map<string, number>();
  for (const item of open) byStart.set(item.recurrenceHint!.start!, (byStart.get(item.recurrenceHint!.start!) ?? 0) + 1);
  return open.some((item) => (item.recurrenceHint?.weekdays?.length ?? 0) > 1) || Array.from(byStart.values()).some((count) => count > 1);
}

/** The reply already asks for the end, or already talks of every week. */
const SAYS_WEEKLY = new RegExp([
  '\\b(?:until|till|ends?|ending|finish(?:es)?|every\\s+week|weekly)\\b',
  'بتخلص|بيخلص|بتخلّص|بيخلّص|لأي ساعة|لاي ساعة|لحد أي|لحد اي|كل أسبوع|كل اسبوع|أسبوعي|اسبوعي',
  'עד איזו|מתי זה נגמר|מתי נגמר|כל שבוע|שבועי',
].join('|'), 'iu');

/**
 * "Every Tuesday and Thursday at 7 PM" is this week's sessions — a weekly
 * block needs an end, and none is ever invented. So the reply says, once,
 * what makes it weekly: the hour it ends. Not when the reply already asks,
 * not while anything on the list is still asked about, and said again only
 * when the list it applied to is gone.
 */
export function withWeeklyOffer(
  reply: string,
  language: ChatLanguage,
  proposal: WeeklyLike | null,
  previous: WeeklyLike | null,
  alreadySaid = '',
): string {
  if (!multiDayWithoutEnd(proposal) || multiDayWithoutEnd(previous)
    || SAYS_WEEKLY.test(`${reply}\n${alreadySaid}`.slice(0, CHAT_REPLY_SCAN_LIMIT))) return reply;
  const offer = WEEKLY_OFFER[language];
  const text = reply.trim();
  if (!text) return offer;
  const sentences = sentencesOf(text);
  const last = sentences[sentences.length - 1];
  // Before a closing question, so the question stays the last thing said.
  if (last && isQuestion(last)) return [...sentences.slice(0, -1), offer, last].join(' ');
  return `${/[.!?؟。…]$/.test(text) ? text : `${text}.`} ${offer}`;
}
