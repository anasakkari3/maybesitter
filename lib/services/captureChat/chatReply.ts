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

type TemplateKind = 'proposed' | 'updated' | 'ask' | 'nothing' | 'off_topic' | 'cleared' | 'refused' | 'acknowledged';

const TEMPLATES: Readonly<Record<ChatLanguage, Readonly<Record<TemplateKind, string>>>> = {
  // Spoken Levantine, not MSA: the product's own voice.
  ar: {
    proposed: 'هيك فهمت. شوف القائمة وإذا كلها تمام أكّدها.',
    updated: 'تمام، غيّرتها. شوف القائمة وإذا كلها تمام أكّدها.',
    acknowledged: 'تمام، غيّرتها.',
    ask: 'إيمتى بدك «{title}»؟ احكيلي اليوم والساعة.',
    nothing: 'شو بدك تعمل وإيمتى؟ احكيلي وأنا بجهزلك ياها لتأكدها.',
    off_topic: 'أنا هون لأساعدك بالمهام والمواعيد تبعك. شو في عندك تعمله؟',
    cleared: 'تمام، شلتها من القائمة. في إشي تاني؟',
    refused: 'بهاد ما بقدر ساعد. احكيلي شو بدك تعمل وإيمتى.',
  },
  en: {
    proposed: "Here's what I understood. Check the list and confirm it if it looks right.",
    updated: 'Okay, I changed that. Check the list and confirm it if it looks right.',
    acknowledged: 'Okay, I changed that.',
    ask: 'When do you want to do "{title}"? Tell me the day and the time.',
    nothing: "What do you need to do, and when? Tell me and I'll set it up for you to confirm.",
    off_topic: "I'm here to help with your commitments and plans. What do you need to get done?",
    cleared: 'Okay, I took it off the list. Anything else?',
    refused: "I can't help with that. Tell me what you need to do and when.",
  },
  he: {
    proposed: 'זה מה שהבנתי. אפשר לבדוק את הרשימה ולאשר אם היא נכונה.',
    updated: 'בסדר, שיניתי. אפשר לבדוק את הרשימה ולאשר אם היא נכונה.',
    acknowledged: 'בסדר, שיניתי.',
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

type ProposalItemLike = Pick<CaptureProposalContract['items'][number], 'title'> & Partial<Pick<CaptureProposalContract['items'][number], 'needsClarification' | 'resolvedDate' | 'clarification'>>;
type ProposalLike = { items: readonly ProposalItemLike[]; noCommitmentReason?: CaptureProposalContract['noCommitmentReason'] };

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
}

/** One safe reply, built from the proposal and nothing the model wrote. */
export function templateReply(context: TemplateContext): string {
  const table = TEMPLATES[context.language];
  if (context.refused) return table.refused;
  const asking = itemAskingForTime(context.proposal);
  if (asking) {
    const question = missingQuestion(context.language, asking);
    return context.updated ? `${table.acknowledged} ${question}` : question;
  }
  if (context.proposal && context.proposal.items.length > 0) return context.updated ? table.updated : table.proposed;
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
  // The proposal still needs a day or a time: the reply has to ask for it.
  if (itemAskingForTime(context.proposal) && !/[?؟]/.test(text)) return { ok: false, rejection: 'does_not_ask' };
  return { ok: true, reply: text };
}

/**
 * The reply the person sees: the model's when it passes; the model's with the
 * missing question after it when that is all it lacks; the template otherwise.
 */
export function safeChatReply(reply: unknown, context: TemplateContext): { reply: string; replaced: boolean } {
  const checked = checkModelReply(reply, context);
  if (checked.ok) return { reply: checked.reply, replaced: false };
  const asking = itemAskingForTime(context.proposal);
  if (checked.rejection === 'does_not_ask' && asking && typeof reply === 'string') {
    const text = reply.trim();
    const ended = /[.!?؟。…]$/.test(text) ? text : `${text}.`;
    return { reply: `${ended} ${missingQuestion(context.language, asking)}`, replaced: false };
  }
  return { reply: templateReply(context), replaced: true };
}
