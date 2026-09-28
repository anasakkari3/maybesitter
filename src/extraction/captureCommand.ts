/**
 * The capture command is not part of the title (L4, fix rounds 2 and 3).
 *
 * The owner said «سجّل موعد دكتور يوم الأحد» and the card read «سجّل موعد
 * دكتور»: "record" was an instruction to the app, not the thing to do.
 *
 * ══ AN ALLOWLIST, NOT A GUESS (controller ruling, fix round 3) ════
 *
 * Round 2 stripped «سجّل» unless a preposition followed, and review found the
 * everyday sentences where «سجّل» *is* the task: «سجّل الأولاد بالمدرسة»
 * (register the kids), «سجّل حلقة البودكاست» (record the episode), «سجّل
 * المصاريف» (log the expenses), «سجّل الدخول» (log in). The card showed a noun
 * phrase with no action. So the verb goes only when what follows is itself a
 * commitment:
 *
 *   ar  «سجّل/سجل/ذكّرني/ذكرني/حطلي/اكتبلي» (or «سجّل لي», «اكتب لي», «حط لي»)
 *       followed by «موعد», «تذكير», «ملاحظة», an appointment noun from the
 *       priority lexicon («دكتور», «امتحان», «مقابلة», «اجتماع»…), «عندي», or
 *       a first-person clause «إني/انو/إنه …» (the conjunction goes too);
 *   en  "remind me to/about/of …", "note: …", "add: …";
 *   he  «תזכיר לי ש…/ל…», «תרשום לי ש…» (ש only before a clause opener —
 *       «שיש», «שאני», «שמחר» — never off a noun like «שיעור»), «תרשום לי: …», and «תרשום לי» or
 *       «תזכיר לי» before an appointment noun («תור», «פגישה», «מבחן»…).
 *
 * Everything else keeps its verb. A Hebrew title never starts with «את» (the
 * object marker): if that is what would remain, nothing is stripped.
 *
 * Used on both engines. On the model path the validator passes the model's
 * own title through here, so a model title is only ever changed when it
 * starts with one of these shapes — never rewritten otherwise.
 */

const A = '(?![\\p{L}\\p{M}])';

const AR_VERB = '(?:سجّل|سجل|سجّلي|سجلي|ذكّرني|ذكرني|ذكّريني|ذكريني|حطلي|حطّلي|اكتبلي|سجللي|سجّللي|(?:سجّل|سجل|حط|حطّ|اكتب)\\s+(?:لي|إلي))';
const AR_COMMITMENT = '(?:و?(?:ال)?(?:موعد|موعدي|تذكير|ملاحظة|ملاحظه|دكتور|دكتورة|طبيب|طبيبة|عيادة|عياده|مستشفى|امتحان|إمتحان|مقابلة|مقابله|طيارة|طيارتي|طيران|محكمة|محكمه|جلسة|اجتماع|فحص|تحليل)|عندي)';
const AR_FIRST_PERSON = '(?:إنّي|إني|اني|إنه|إنّه|انه|انو|إنو|إنّو)';

/**
 * What may follow the subordinator «ש-» for it to be one (fix round 4, C-2).
 *
 * `ש(?=\\S)` took the ש off any word that starts with one: «תרשום לי שיעור
 * חשוב» became «יעור חשוב», «שיחה» «יחה», «שולחן» «ולחן». ש is a prefix only
 * when what is left is a closed-class word that opens a clause — a pronoun,
 * יש/אין, a modal, a time word. Anything else keeps the whole title.
 */
const HE_CLAUSE_OPENER = '(?:יש|אין|אני|אתה|את|הוא|היא|אנחנו|אתם|אתן|הם|הן|צריך|צריכה|צריכים|צריכות|חייב|חייבת|חייבים|מחר|מחרתיים|היום|הערב|ביום|בשבוע|בעוד|יהיה|תהיה|יהיו|לא)';

const COMMANDS: readonly RegExp[] = [
  // «سجّل إني …» — the conjunction goes with the verb.
  new RegExp(`^\\s*${AR_VERB}${A}\\s*[:،,]?\\s*${AR_FIRST_PERSON}${A}\\s*`, 'u'),
  // «سجّل موعد …» — only the verb goes; the commitment is the title.
  new RegExp(`^\\s*${AR_VERB}${A}\\s*[:،,]?\\s*(?=${AR_COMMITMENT}${A})`, 'u'),
  /^\s*(?:please\s+)?(?:remind\s+me\s+(?:to|about|of)\s+|note\s*:\s*|add\s*:\s*)/i,
  new RegExp(`^\\s*(?:תזכיר|תזכירי|תרשום|תרשמי)\\s+לי\\s*(?::\\s*|\\s?ש(?=${HE_CLAUSE_OPENER}${A})|(?=ל\\S)|\\s(?=(?:תור|פגישה|מבחן|בחינה|ראיון|טיסה|דיון)${A}))`, 'u'),
];

/** Spaces and punctuation, which do not count as "more content". */
const LEFTOVER_NOISE = new RegExp('[\\s\\p{P}]', 'gu');

export function stripCaptureCommand(title: string): string {
  if (typeof title !== 'string') return title;
  for (const command of COMMANDS) {
    const match = command.exec(title);
    if (!match) continue;
    const rest = title.slice(match[0].length).trim();
    // Only when followed by more content, and never onto the object marker.
    if (rest.replace(LEFTOVER_NOISE, '').length < 2 || /^את\s/.test(rest)) return title;
    return rest;
  }
  return title;
}
