/**
 * The capture command is not part of the title (L4, fix round 2).
 *
 * The owner said «سجّل موعد دكتور يوم الأحد» and the card read «سجّل موعد
 * دكتور»: "record" was an instruction to the app, not the thing to do. Both
 * engines' titles pass through `stripCaptureCommand` — the rules path in
 * `cleanAction`, the model's answer in the schema validator — so the same
 * sentence gets the same title whichever engine answered.
 *
 * ── Only when the verb is an instruction to us ─────────────────────
 *
 * Every one of these verbs is also an ordinary task. «سجّل بالنادي» is "sign
 * up at the gym", «اكتب التقرير» is "write the report", «حط الغسيل» is "put
 * the laundry in", "add milk to the list", «לרשום את הילד לחוג» is "register
 * the kid". So:
 *
 *   «سجّل», «ذكّرني»   stripped at the start, unless their own complement
 *                     follows — a preposition or a place («سجّل بالنادي»,
 *                     «سجل في دورة»);
 *   «حط», «ضيف», «اكتب» stripped only with «لي»/«عندك» or a colon after them:
 *                     «حط لي موعد», «اكتب: موعد»;
 *   note/add          only as "note:", "add:", "note that", "add a reminder";
 *                     "remind me about/of" as well;
 *   «תרשום/תרשמי»      only with «לי» or a colon.
 *
 * Only at the start, only when something is left after it. A title that
 * would be emptied comes back unchanged.
 */

const A = '(?![\\p{L}\\p{M}])';

/** «سجّل موعد…» — but not «سجّل بالنادي», «سجل في دورة», «سجل حالك». */
const AR_RECORD = new RegExp(
  `^\\s*(?:سجّل|سجل|سجّلي|سجلي|ذكّرني|ذكّريني)${A}(?:\\s+(?:لي|إلي|الي|عندك))?\\s*[:،,]?\\s+(?!ب|لل|عال|(?:في|فيه|ع|على|عند|مع|حالي|حالك|نفسي|نفسك|اسمي|اسمك)${A})`,
  'u',
);

/** «حط لي…», «ضيف لي…», «اكتب: …» — the object pronoun or the colon is the tell. */
const AR_NOTE = new RegExp(
  `^\\s*(?:حطّ|حط|حطّي|حطي|ضيف|ضيفي|اكتب|اكتبي|اكتبلي|حطلي|ضيفلي)${A}(?:\\s+(?:لي|إلي|الي|عندك)\\s*[:،,]?|\\s*[:،,])\\s*`,
  'u',
);
/** The fused forms carry the «لي» already: «حطلي موعد». */
const AR_NOTE_FUSED = new RegExp(`^\\s*(?:اكتبلي|حطلي|ضيفلي|سجللي|سجّللي)${A}\\s*[:،,]?\\s*`, 'u');

const EN_NOTE = /^\s*(?:please\s+)?(?:(?:note|add|reminder)\s*:\s*|note\s+that\s+|note\s+down\s*:?\s*|add\s+a\s+reminder(?:\s+(?:to|for|about))?\s*:?\s*|remind\s+me\s+(?:about|of)\s+)/i;

const HE_NOTE = new RegExp(`^\\s*(?:תרשום|תרשמי|תרשמו)${A}(?:\\s+לי\\s*[:,]?|\\s*[:,])\\s*`, 'u');

/** Spaces and punctuation, which do not count as "more content". */
const LEFTOVER_NOISE = new RegExp('[\\s\\p{P}]', 'gu');

const COMMANDS: readonly RegExp[] = [AR_RECORD, AR_NOTE_FUSED, AR_NOTE, EN_NOTE, HE_NOTE];

export function stripCaptureCommand(title: string): string {
  if (typeof title !== 'string') return title;
  for (const command of COMMANDS) {
    const match = command.exec(title);
    if (!match) continue;
    const rest = title.slice(match[0].length).trim();
    // Only when followed by more content: «سجّل» alone stays «سجّل».
    if (rest.replace(LEFTOVER_NOISE, '').length >= 2) return rest;
    return title;
  }
  return title;
}
