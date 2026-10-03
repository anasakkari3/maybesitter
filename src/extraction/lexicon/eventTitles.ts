/**
 * Is a timed entry an event, or a task given an hour? (Black-box audit
 * 2026-10-03 #2 and its review.) One answer for the server's next step
 * (`lib/services/nextStepPreparation.ts`) and the phone's fallback card
 * (`mobile/src/features/today/composeToday.ts`), so the two never disagree.
 *
 * The app bundles this directory (`mobile/metro.config.js`), so it is plain
 * code: no `\p{…}` classes, no lookbehind, no `u` flag — nothing Hermes may
 * read differently from the Node that runs the tests.
 */
import { GATHERING_NOUNS, PREPARATION_NOUNS } from './eventNouns';

/** Anything that is not a Latin, Hebrew or Arabic letter or a digit. No `\p{…}`: Hermes reads this file too. */
const SPLIT = /[^0-9A-Za-z\u00C0-\u024F\u0590-\u05FF\u0620-\u064A\u0660-\u0669\u066E-\u06D3\u06FA-\u06FF]+/;

/** An Arabic word without «و»/«ف», «ب»/«ك»/«ل» and the article, so «للامتحان» is «امتحان». */
function arabicStem(word: string): string {
  if (!/^[ء-ي]/.test(word)) return word;
  let rest = word;
  if (/^[وف]/.test(rest) && rest.length > 3) rest = rest.slice(1);
  if (rest.startsWith('لل') && rest.length > 3) return rest.slice(2);
  if (/^[بكل]/.test(rest) && rest.length > 3) rest = rest.slice(1);
  if (rest.startsWith('ال') && rest.length > 3) rest = rest.slice(2);
  return rest;
}

/** A Hebrew word without one of the prefixes ה ו ב ל מ ש, when it is long enough to have one. */
function hebrewStem(word: string): string {
  // Repeated, so the noun and the word in a title land on the same stem
  // however many letters each lost: «למסיבה» and «מסיבה» both reach «סיבה».
  let stem = word;
  while (/^[הובלמש][\u05D0-\u05EA]{3,}$/.test(stem)) stem = stem.slice(1);
  return stem;
}

export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .split(SPLIT)
    .filter(Boolean)
    .map((word) => hebrewStem(arabicStem(word)));
}

type Nouns = { readonly ar: readonly string[]; readonly he: readonly string[]; readonly en: readonly string[] };

function phrasesOf(...lists: readonly Nouns[]): (readonly string[])[] {
  return lists.flatMap((nouns) => [...nouns.ar, ...nouns.he, ...nouns.en]).map((noun) => wordsOf(noun)).filter((phrase) => phrase.length > 0);
}

/** A phrase of `phrases` starting at word `index`. */
function phraseAt(words: readonly string[], index: number, phrases: readonly (readonly string[])[]): boolean {
  return phrases.some((phrase) => phrase.every((part, offset) => words[index + offset] === part));
}

/**
 * The nouns that make a timed entry an event when they *head* its title
 * (review of audit #2). Narrower than the appointment list on purpose: no
 * «تحليل»/«فحص» («اعمل تحليل البيانات» is work), and only ever as the head —
 * "Send the meeting notes", "Buy a birthday cake", «احكي مع الدكتور» name an
 * event noun and are tasks.
 */
const EVENT_HEAD_EXTRA: Nouns = {
  ar: ['موعد', 'موعدي', 'دكتور', 'دكتورة', 'طبيب', 'طبيبة', 'عيادة', 'عياده', 'طيارة', 'طيارتي', 'طيران', 'محكمة', 'محكمه', 'جلسة', 'جلسه', 'اجتماع', 'ميتنغ', 'ميتينغ'],
  he: ['תור', 'פגישה', 'טיסה', 'דיון'],
  en: ['appointment', 'appt', 'doctor', 'dentist', 'clinic', 'flight', 'court hearing', 'court date', 'meeting'],
};
const EVENT_HEADS = phrasesOf(PREPARATION_NOUNS, GATHERING_NOUNS, EVENT_HEAD_EXTRA);
const PREPARED_HEADS = phrasesOf(PREPARATION_NOUNS);

/**
 * Words that start a task: an action («اعمل», «احجز», "send", «לשלוח») or a
 * "have to" («لازم», "need to», «צריך»). A title that opens with one is
 * something to do, whatever event it mentions — «لازم أدرس للامتحان» is the
 * preparation, not the exam.
 */
const TASK_STARTS = new Set(wordsOf([
  'لازم لازملي ضروري بدي بدنا رح راح خلي خليني ممكن',
  'اعمل اعملي احكي احكيلي احجز اشتري اشتريلي ابعت ابعث اتصل تصل روح رجع ارجع جيب خلص كمل حضر ادرس راجع اكتب اطبع ادفع نظف رتب صلح وصل سلم قدم سجل اطلب',
  'send call buy book finish prepare study review revise practice practise write email text pay pick get go make do plan schedule cancel reschedule remind check submit print bring take clean fix order read ask tell remember to dont',
  'צריך צריכה חייב חייבת תזכיר תזכירי',
].join(' ')));

/** The possessive people state a plan with — «عندي», "I have", «יש לי» — which is no evidence either way. */
function withoutPossessive(title: string): string {
  return title
    .replace(/^\s*(?:في\s+)?(?:عندي|عندنا|عندك)\s+/, '')
    .replace(/^\s*(?:i(?:'ve| have)(?: got)?|we have|have|got)\s+(?:an?\s+|my\s+|the\s+)?/i, '')
    .replace(/^\s*יש\s+(?:לי|לנו)\s+/, '');
}

/**
 * The verb of *going to* an event, which titles open with — the imperative
 * the capture model writes («تطلع مع أصحابك», «تحضر عرس ابن عمك», «تقدّم
 * امتحان الرياضيات», "Take the math exam", «ללכת לחתונה»). Set aside like
 * the possessive, so the event noun after it can head the title (second
 * review of #2). Only when what follows is an event noun does it count: «قدّم
 * الطلب», "Take the trash out", «לעשות כביסה» stay tasks.
 *
 * The trap is «حضّر» (prepare) against «تحضر»/«احضر» (attend): without the
 * shadda they are one spelling. Only the forms with a prefix letter — «تحضر»,
 * «احضر», «أحضر», «بحضر» — are attendance, and never with a shadda or before
 * «ل…» («أحضّر للامتحان», «احضر للمقابلة» is preparing for it); a bare
 * «حضر»/«حضّر» is not stripped at all, so it stays the task it is.
 */
export function withoutAttendance(title: string): string {
  const text = title.trim();
  const tokens = text.split(/\s+/);
  // Matched without the short vowels and the shadda («تقدّم» is «تقدم»).
  const plain = tokens.map((token) => token.replace(/[\u064B-\u0652]/g, ''));
  const ARABIC_VERB = /^(?:تحضري?|احضر|إحضر|أحضر|بحضر|نحضر|تروحي?|روح|اروح|أروح|بروح|نروح|منروح|تقدمي?|قدم|اقدم|أقدم|بقدم|تطلعي?|اطلع|أطلع|نطلع|بطلع)$/;
  if (tokens.length > 1 && ARABIC_VERB.test(plain[0]!)) {
    const verb = tokens[0]!;
    const skip = /^(?:على|عل|ع|الى|إلى|لعند)$/.test(plain[1]!) && tokens.length > 2 ? 2 : 1;
    const rest = tokens.slice(skip).join(' ');
    // «أحضّر» with its shadda is preparing; so is «احضر للمقابلة», for something.
    if (/حض/.test(plain[0]!) && (/\u0651/.test(verb) || /^ل/.test(rest))) return title;
    // «عالحفلة» is «على الحفلة».
    return rest.replace(/^عال/, 'ال');
  }
  const english = /^(?:attend(?:ing)?|go(?:ing)? to|head(?:ing)? to|take|taking|sit(?:ting)?(?: for)?|be at)\s+(?:the\s+|a\s+|an\s+|my\s+|our\s+)?(.+)$/i.exec(text);
  if (english) return english[1]!;
  const hebrew = /^(?:ללכת|להגיע|לעשות|לגשת|לבוא)\s+(.+)$/.exec(text);
  if (hebrew) return hebrew[1]!;
  return title;
}

/** The first word reads as a verb or a "have to": a task. */
function startsWithTask(head: string): boolean {
  const raw = head.trim().split(/\s+/)[0] ?? '';
  if (!raw) return false;
  // Arabic first-person imperfect («أسلّم», «أدرس», «أخلص»): «أ» on the first letter.
  if (/^أ[ء-ي]{2,}/.test(raw)) return true;
  // A Hebrew infinitive («לשלוח», «ללמוד», «להתכונן»).
  if (/^ל[א-ת]{3,}$/.test(raw) && !/^(?:ל)?(?:מבחן|בחינה|ראיון|מסיבה)/.test(raw)) return true;
  const first = wordsOf(raw)[0] ?? '';
  return TASK_STARTS.has(first);
}

/**
 * Where the event noun must stand: the head. Arabic and Hebrew put the head
 * first («امتحان رياضيات», «מבחן במתמטיקה»); English may put up to two
 * modifiers before it ("Math exam", "Job interview", "Team meeting").
 */
function headIndexOf(words: readonly string[], heads: readonly (readonly string[])[], latin: boolean): number | null {
  const reach = latin ? 3 : 1;
  for (let index = 0; index < Math.min(reach, words.length); index += 1) {
    if (phraseAt(words, index, heads)) return index;
    if (index > 0 && TASK_STARTS.has(words[index]!)) return null;
  }
  return null;
}

function headedBy(title: string, heads: readonly (readonly string[])[]): boolean {
  const rest = withoutPossessive(title);
  const words = wordsOf(rest);
  if (words.length === 0) return false;
  // Going to it: the event noun after the verb heads the title.
  const attended = withoutAttendance(rest);
  if (attended !== rest) {
    const after = wordsOf(attended);
    if (headIndexOf(after, heads, !/[\u0590-\u06FF]/.test(attended)) !== null) return true;
  }
  // A going-out phrase heads with its verb («تطلع مع أصحابك»): checked first.
  if (phraseAt(words, 0, heads)) return true;
  if (startsWithTask(rest)) return false;
  return headIndexOf(words, heads, !/[\u0590-\u06FF]/.test(rest)) !== null;
}

/**
 * The title names an event rather than a task (review of audit #2): an event
 * noun heads it — an exam, a night out, an appointment — and it does not open
 * with an action or a "have to". «عندي»/"I have"/«יש לי» is set aside, not
 * counted: «عندي تقرير لازم أسلمه الساعة 3» is a task.
 */
export function namesEvent(title: string): boolean {
  return headedBy(title, EVENT_HEADS);
}

/** An event to prepare for: an exam, an interview, a presentation heads the title. */
export function namesPreparedEvent(title: string): boolean {
  return headedBy(title, PREPARED_HEADS);
}

/** Free text (the «حضّرني» notes) that mentions such an event anywhere. */
export function mentionsPreparedEvent(text: string): boolean {
  const words = wordsOf(text);
  return words.some((_, index) => phraseAt(words, index, PREPARED_HEADS));
}
