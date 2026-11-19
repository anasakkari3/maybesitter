import { LLMUnavailableError } from './llm/llmProvider';
import { extractWithOllama, type LLMProviderFunction } from './ollamaExtractor';
import { screenForInjection } from './injectionBoundary';
import { extract as ruleBasedExtract, stripTimeExpressions } from './ruleBasedExtractor';
import { decideExtractionDisposition } from './extractionPolicy';
import { decideEscalation, type EscalationReason } from './escalationGate';
import { ARBITRATION_UNAVAILABLE, type ArbiterFunction, type ArbitrationVerdict } from './arbiter';
import { mapExtractionToCommand } from './mapExtractionToCommand';
import { instantFromLocal, localTimeSpecFor, rangeEndInstant, rangeMinutesFrom, rangeStartTime, readClockRange, readRelativeOffsetMinutes, relativeDayOffset, statesClock, withoutRelativeOffset } from './timeLexicon';
import { daysUntilWeekday, namesCalendarDate, namesExplicitDate, readRecurrence, readWeekdayMentions, readWeekdayReference, type StatedRecurrence } from './weekdayLexicon';
import type { Command } from '../domain/stateMachine';
import type { ExtractionContext, ExtractionDisposition, ExtractionResult, RecurrenceHint } from './extractionTypes';

export type ExtractionEngine = 'gemini' | 'ollama' | 'rule-based';

/**
 * Something the person *had*, told in the past tense (closure UAT round 2,
 * FY1 N1): «اليوم الساعة 3 العصر كان عندي اجتماع», "I had a meeting at 3",
 * «היתה לי פגישה». It already happened; it is not a commitment, and nothing is
 * made for it. Read as a task, its 15:00 — gone by 18:08 — was the time the
 * capture then refused, and the room and the bank said beside it were lost.
 *
 * Only the "I had" construction, whole words: «مكان عندي» is not «كان
 * عندي», and «كان في بالي» ("I had in mind to…") is left to the reader. A
 * request word in the same clause — «…بس تأجل لبكرا», «كان
 * لازم» — is still read as a request below (`request`), as for «مبارح».
 */
const PAST_EVENT_NARRATION = new RegExp(
  [
    '(?:^|[\\s،,.;:!?؟(])[وف]?(?:كان|كانت)\\s+(?:عندي|عندنا|عنّا|عنا|إلي|الي|إلنا|النا|لي|لنا)(?=$|[\\s،,.;:!?؟)])',
    "\\b(?:i|we)\\s+had\\s+(?:a|an|my|our|the)\\b",
    '(?:^|[\\s,.;:!?(])[ו]?(?:היתה|הייתה|היה)\\s+(?:לי|לנו)(?=$|[\\s,.;:!?)])',
  ].join('|'),
  'iu',
);

/**
 * Not narration after all (FY1 review, I1): «إذا كان عندي وقت يوم السبت بدي
 * أنظف السيارة» is a condition on a plan, and «كان عندي موعد يوم الأحد بس صار
 * يوم الاثنين الساعة 10» corrects one. Both were real commitments dropped as
 * `past_event`. So the "I had" reading declines after a conditional, when the
 * clause corrects itself («بس صار…», "but it moved"), and when it names a day
 * ahead — a weekday, a date, tomorrow. «اليوم» is not ahead: N1's «اليوم
 * الساعة 3 العصر كان عندي اجتماع» is still what already happened.
 */
const NOT_NARRATION = new RegExp(
  [
    '(?:^|[\\s،,.;:!?؟(])[وف]?(?:إذا|اذا|لو|لولا|إن|ان)\\s+(?:[وف]?كان|كانت)(?=$|[\\s،,.;:!?؟)])',
    '(?:^|[\\s،,.;:!?؟(])[وف]?(?:بس|لكن|بعدين)\\s+(?:صار|صارت|تأجل|تأجّل|اتأجل|انتقل|نقلوه|تغير|تغيّر|رح\\s+يكون|حيكون)(?=$|[\\s،,.;:!?؟)])',
    "\\b(?:if|unless)\\s+(?:i|we)\\s+had\\b",
    "\\bbut\\s+(?:it|that|now\\s+it)(?:'s|\\s+is|\\s+was|\\s+got)?\\s+(?:moved|changed|rescheduled|postponed|now)\\b",
    '(?:^|[\\s,.;:!?(])[ו]?(?:אם|לו|אילו|כש)\\s*(?:היה|היתה|הייתה)\\s+(?:לי|לנו)(?=$|[\\s,.;:!?)])',
    '(?:^|[\\s,.;:!?(])[ו]?אבל\\s+(?:זה\\s+)?(?:עבר|נדחה|נדחתה|השתנה|הוזז)(?=$|[\\s,.;:!?)])',
  ].join('|'),
  'iu',
);

function isPastNarration(rawText: string): boolean {
  if (!PAST_EVENT_NARRATION.test(rawText) || NOT_NARRATION.test(rawText)) return false;
  // A day ahead of today, said in the same clause, is a plan being told.
  return readWeekdayReference(rawText) === null && (relativeDayOffset(rawText) ?? 0) < 1;
}

/*
 * ══ A THING THAT WAS TO BE DONE, AND WAS NOT (QA v3, V3-F04-03) ══
 *
 * «مبارح الساعة 9 الصبح كان لازم أبعت الواجب للدكتور وما بعتته» made
 * nothing: the model answered «بقدر أساعدك بالمهام الجاية», the rules put it
 * at 09:00 today. Owner decision (2026-11-19): it is a thing to do *now* — on
 * today's list, ready to be done. Nothing calls it late or missed (mobile
 * AGENTS.md: there is no "overdue"), its passed hour is not kept, and the
 * person is asked when today, as for any task with no hour; nothing is saved
 * until they confirm.
 *
 * What it is, and only that: an obligation told in the past («كان لازم»,
 * «كان المفروض», "I was supposed to", «הייתי צריך») with the words saying it
 * was not done («وما بعتته», "and didn't", «ולא»), or "I forgot to" /
 * «نسيت أ…» / «ما لحقت» before a verb. «امبارح كان عندي اجتماع» told
 * something that happened and stays no commitment. A day ahead named in the
 * same words («…بدي أبعته بكرا») is the person's own plan and is read as said.
 */
const B = '(?<![\\p{L}\\p{M}])';
const A = '(?![\\p{L}\\p{M}])';
const PAST_OBLIGATION = new RegExp(
  [
    `${B}[وف]?(?:كان|كانت)\\s+(?:لازم|لازمني|بدي|بدّي|المفروض|مفروض|عليّ|علي)${A}`,
    "\\b(?:was|were)\\s+supposed\\s+to\\b|\\bshould\\s+have\\b|\\b(?:had|needed|meant)\\s+to\\b",
    `${B}ו?(?:הייתי|היה)\\s+(?:צריך|צריכה|אמור|אמורה)${A}`,
  ].join('|'),
  'iu',
);
const NOT_DONE = new RegExp(
  [
    `${B}[وف]?(?:ما|مش|لسا|لسّا|لسه|لسّه)${A}`,
    "\\b(?:didn'?t|didn’t|did\\s+not|haven'?t|have\\s+not|hasn'?t|never)\\b",
    `${B}ו?לא${A}`,
  ].join('|'),
  'iu',
);
const FORGOT_TO = new RegExp(
  [
    `${B}[وف]?(?:نسيت|ما\\s+لحقت|مالحقت)\\s+(?:(?:إني|اني|انو|إنو)\\s+)?[أاإن][\\p{L}\\p{M}]{2,}`,
    "\\b(?:forgot|forget)\\s+to\\b|\\bdidn'?t\\s+get\\s+to\\b|\\bnever\\s+got\\s+(?:around\\s+)?to\\b",
    `${B}ו?(?:שכחתי|לא\\s+הספקתי)${A}`,
  ].join('|'),
  'iu',
);

/** The words tell a thing that was to be done and was not, with no day ahead of their own. */
export function isMissedObligation(rawText: string): boolean {
  if (typeof rawText !== 'string' || !rawText.trim()) return false;
  if (!(PAST_OBLIGATION.test(rawText) && NOT_DONE.test(rawText)) && !FORGOT_TO.test(rawText)) return false;
  return (relativeDayOffset(rawText) ?? 0) < 1 && readWeekdayReference(rawText) === null
    && !namesCalendarDate(rawText) && readRecurrence(rawText) === null;
}

/** The framing around the thing itself: the past day, "I was supposed to", and "and I didn't". */
const MISSED_FRAMING = new RegExp(
  [
    `${B}[وب]?(?:مبارح|امبارح|إمبارح|أمس|امس|البارحة|البارحه)${A}`,
    `${B}[وف]?(?:كان|كانت)\\s+(?:لازم|لازمني|بدي|بدّي|المفروض|مفروض|عليّ|علي)${A}(?:\\s+(?:إني|اني|انو|إنو))?`,
    `${B}[وف]?(?:نسيت|ما\\s+لحقت|مالحقت)${A}(?:\\s+(?:إني|اني|انو|إنو))?`,
    "\\b(?:yesterday|last\\s+night|earlier\\s+today)\\b",
    "\\b(?:i\\s+)?(?:was|were)\\s+supposed\\s+to\\b|\\b(?:i\\s+)?should\\s+have\\b|\\b(?:i\\s+)?(?:had|needed|meant|forgot)\\s+to\\b|\\b(?:i\\s+)?(?:didn'?t\\s+get|never\\s+got(?:\\s+around)?)\\s+to\\b",
    `${B}ו?(?:אתמול|הייתי\\s+(?:צריך|צריכה|אמור|אמורה)|שכחתי|לא\\s+הספקתי)${A}`,
  ].join('|'),
  'giu',
);
/** "…and I did not": from the not-done words to the end. */
const NOT_DONE_TAIL = new RegExp(
  [
    `[\\s،,]+[وف]?(?:(?:بس|لكن)\\s+)?(?:(?:لسا|لسّا|لسه|لسّه)\\s+)?(?:ما|مش)${A}[\\s\\S]*$`,
    "[\\s,]+(?:and|but)\\s+(?:i\\s+)?(?:didn'?t|didn’t|did\\s+not|haven'?t|have\\s+not|never)\\b[\\s\\S]*$",
    `[\\s,]+(?:ו|אבל\\s+)?לא${A}[\\s\\S]*$`,
  ].join('|'),
  'iu',
);

function missedThingTitle(text: string | null): string | null {
  if (!text) return text;
  const title = text.replace(MISSED_FRAMING, ' ').replace(NOT_DONE_TAIL, '').replace(/\s+/g, ' ').replace(/^[\s,،.:;-]+|[\s,،.:;-]+$/g, '').trim();
  return title.length >= 3 ? title : text;
}

/**
 * The missed thing as a thing to do today: today, no hour (the one it had
 * has gone), the framing out of its title, asked when. Never a passed time,
 * never "late".
 */
function asThingToDoToday(result: ExtractionResult, rawText: string, context: ExtractionContext): ExtractionResult {
  const timezone = context.timezone || result.localTimeSpec?.timezone || 'UTC';
  const today = localTimeSpecFor(context.now, timezone)?.date;
  if (!today) return result;
  const named = missedThingTitle(result.title) ?? missedThingTitle(stripTimeExpressions(rawText));
  const action = missedThingTitle(result.action) ?? named;
  const { undatedTime: _undated, rangeMinutes: _range, recurrenceHint: _hint, ...rest } = result;
  return {
    ...rest,
    type: result.type === 'follow_up' ? 'follow_up' : 'task',
    title: named,
    action,
    dueAt: null,
    remindAt: null,
    allDay: false,
    localTimeSpec: { date: today, time: null, timezone },
    timeEvidence: 'day_only',
    dateInferred: false,
    missingFields: [...result.missingFields.filter((field) => field !== 'action' && field !== 'time'), 'time'],
    ambiguityFlags: result.ambiguityFlags.filter((flag) => flag !== 'informational_without_action' && flag !== 'vague_action' && flag !== 'no_action_verb'),
    confidence: { ...result.confidence, overall: Math.max(result.confidence.overall, 0.7), type: Math.max(result.confidence.type, 0.7), action: Math.max(result.confidence.action, 0.7) },
  };
}

/** A span counted from now, on the person's clock, when the words state no clock or other day of their own. */
export function statedRelativeTime(rawText: string, now: Date, timeZone: string): { instant: string; date: string; time: string } | null {
  const minutes = readRelativeOffsetMinutes(rawText);
  if (minutes === null) return null;
  if (statesClock(rawText) || readRecurrence(rawText) || readWeekdayReference(rawText) || namesCalendarDate(rawText)) return null;
  if ((relativeDayOffset(rawText) ?? 0) !== 0) return null;
  const at = new Date(Math.floor((now.getTime() + minutes * 60_000) / 60_000) * 60_000);
  const local = localTimeSpecFor(at, timeZone);
  return local ? { instant: at.toISOString(), date: local.date, time: local.time } : null;
}

/**
 * The span counted from now is the time, on either engine (V3-F04-04): the
 * rules asked «إيمتى؟» and a model once put «بعد ساعتين» at 19:12 when it was
 * 07:12. The span leaves the title.
 */
function onRelativeTime(result: ExtractionResult, rawText: string, context: ExtractionContext): ExtractionResult {
  const timeZone = context.timezone || result.localTimeSpec?.timezone || 'UTC';
  const stated = statedRelativeTime(rawText, context.now, timeZone);
  if (!stated) return result;
  const tidy = (text: string | null): string | null => {
    if (!text) return text;
    const without = withoutRelativeOffset(text);
    return without.length >= 3 ? without : text;
  };
  const { undatedTime: _undated, ...rest } = result;
  return {
    ...rest,
    title: tidy(result.title),
    action: tidy(result.action),
    dueAt: result.dueAt || !result.remindAt ? stated.instant : null,
    remindAt: result.remindAt ? stated.instant : null,
    allDay: false,
    localTimeSpec: { date: stated.date, time: stated.time, timezone: timeZone },
    timeEvidence: 'hhmm',
    dateInferred: false,
    missingFields: result.missingFields.filter((field) => field !== 'time'),
    ambiguityFlags: result.ambiguityFlags.filter((flag) => flag !== 'vague_time'),
    confidence: { ...result.confidence, time: Math.max(result.confidence.time, 0.9) },
  };
}

export interface ExtractAndMapOptions {
  llmProvider?: LLMProviderFunction;
  /**
   * Which engine the injected provider represents (UC-2.0, #160).
   *
   * This module cannot ask: `src/extraction` never imports from `lib/`, and the
   * provider is composed there. So the caller that built it says what it is,
   * and the default stays `ollama` — what every existing injection meant.
   */
  llmEngine?: ExtractionEngine;
  /** Absent means never escalate -- the local model's answer stands. */
  arbiter?: ArbiterFunction;
  /** A specialized caller may fail closed on the first malformed answer. */
  repairEnabled?: boolean;
}

export interface ExtractionEscalation {
  /**
   * True only when a second opinion was actually obtained. A gate that fired
   * without an arbiter configured, and a call that timed out or threw, both
   * leave this false while `reasons` still records the doubt.
   */
  escalated: boolean;
  reasons: EscalationReason[];
  verdict: ArbitrationVerdict | null;
  /**
   * Why no second opinion was obtained, when one was wanted. A misconfigured
   * arbiter reports unavailable on every capture while every downstream number
   * reads normal, so the fact alone is not enough to notice it.
   */
  unavailableReason: string | null;
}

export interface ExtractAndMapResult {
  result: ExtractionResult;
  disposition: ExtractionDisposition;
  commands: Command[];
  engine: ExtractionEngine;
  fallbackReason: string | null;
  escalation: ExtractionEscalation;
}

export interface ExtractWithFallbackResult {
  result: ExtractionResult;
  engine: ExtractionEngine;
  fallbackReason: string | null;
}

/**
 * Why the model did not answer, in words that are ours (UC-2.0, #160).
 *
 * This reason reaches the client in `provenance.fallbackReason`. A provider's
 * error message can quote the request it failed on, and the request is the
 * sentence the user typed — so an `LLMUnavailableError` contributes only its
 * machine-readable reason, never its message.
 */
function fallbackReasonFrom(error: unknown): string {
  if (error instanceof LLMUnavailableError) return `llm_unavailable:${error.reason}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function safeNegativeResult(rawText: string, type: 'unknown' | 'informational_context'): ExtractionResult {
  return {
    type,
    action: null,
    title: null,
    person: null,
    dueAt: null,
    remindAt: null,
    localTimeSpec: null,
    timeEvidence: 'none',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    // This result exists because the text was refused — injection, or a past
    // event with no action. There is nothing to file and nothing was read
    // (#415).
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 0.99, type: 0.99, action: 0.8, time: 0.9, priority: 0.92 },
    missingFields: ['action'],
    ambiguityFlags: type === 'informational_context' ? ['informational_without_action'] : ['vague_action'],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
    rawText,
    parserVersion: 'semantic-safety-v1',
  };
}

/**
 * Decide whether this capture deserves a second opinion, and get one if so.
 *
 * The local model handles the volume; the frontier model is asked only about
 * the captures the gate says are doubtful. Its answer is recorded, never
 * applied -- a correction the user has not seen must not silently replace
 * what they said.
 */
async function arbitrate(
  rawText: string,
  extracted: ExtractWithFallbackResult,
  arbiter: ArbiterFunction | undefined
): Promise<ExtractionEscalation> {
  const declined = { escalated: false, reasons: [], verdict: null, unavailableReason: null };

  // The arbiter judges a *model* proposal, so it is asked only when the model
  // actually answered. Every other path lands on 'rule-based', and each is a
  // reason not to escalate in its own right:
  //   - injection screened off, and the semantic-safety refusal, both produced
  //     nothing for the user, so disclosing them to a remote provider buys
  //     nothing and costs a sentence;
  //   - the fallback's confidence is not commensurable with the model's -- it
  //     caps overall at 0.68 and time at 0.1, both under the gate, so an Ollama
  //     outage would otherwise become the moment of maximum remote spend and
  //     maximum disclosure.
  if (extracted.engine === 'rule-based') return declined;

  const gate = decideEscalation(extracted.result, rawText);
  if (!gate.escalate || !arbiter) {
    return { escalated: false, reasons: gate.reasons, verdict: null, unavailableReason: null };
  }

  let verdict: ArbitrationVerdict;
  let unavailableReason: string | null = null;
  try {
    verdict = await arbiter(rawText, extracted.result);
  } catch (error) {
    // The remote model is an improvement, never a dependency -- but degrade
    // with the reason recorded, the way the local path already does.
    verdict = ARBITRATION_UNAVAILABLE;
    unavailableReason = fallbackReasonFrom(error);
  }

  return {
    // A refusal, a timeout or a throw yields a verdict object but no second
    // opinion. Counting those as escalated would report a capture as checked
    // when nothing checked it.
    escalated: verdict.outcome !== 'unavailable',
    reasons: gate.reasons,
    verdict,
    unavailableReason,
  };
}

export async function extractAndMap(
  rawText: string,
  context: ExtractionContext,
  options: ExtractAndMapOptions = {}
): Promise<ExtractAndMapResult> {
  const extracted = await extractWithFallback(rawText, context, options);
  const escalation = await arbitrate(rawText, extracted, options.arbiter);
  const disposition = decideExtractionDisposition(extracted.result);
  const commands = mapExtractionToCommand(extracted.result, context.now.toISOString());

  return {
    ...extracted,
    disposition,
    commands,
    escalation,
  };
}

export async function extractWithFallback(
  rawText: string,
  context: ExtractionContext,
  options: ExtractAndMapOptions = {}
): Promise<ExtractWithFallbackResult> {
  const injection = screenForInjection(rawText);
  if (injection) {
    return { result: safeNegativeResult(rawText, 'unknown'), engine: 'rule-based', fallbackReason: `prompt_injection:${injection}` };
  }
  const past = /\b(yesterday|last night|last week|earlier)\b|مبارح|أمس|امبارح|אתמול|בשבוע שעבר/i.test(rawText)
    || isPastNarration(rawText);
  const request = /\b(remind|add|create|schedule|please|need to|must|tomorrow)\b|ذكرني|ضيف|أضف|لازم|بكرا|תזכיר|תוסיף|צריך|מחר/i.test(rawText);
  // A thing that was to be done and was not is still to do (V3-F04-03).
  const missed = isMissedObligation(rawText);
  if (past && !request && !missed) {
    return { result: safeNegativeResult(rawText, 'informational_context'), engine: 'rule-based', fallbackReason: 'semantic_safety:past_no_action' };
  }
  let result: ExtractionResult;
  let engine: ExtractionEngine = options.llmEngine ?? 'ollama';
  let fallbackReason: string | null = null;

  try {
    result = await extractWithOllama(rawText, context, {
      provider: options.llmProvider,
      repairEnabled: options.repairEnabled,
    });
  } catch (error) {
    fallbackReason = fallbackReasonFrom(error);
    result = ruleBasedExtract(rawText, context);
    engine = 'rule-based';
  }
  if (/תזכיר\s+לי/.test(rawText) && result.type === 'task') {
    result = { ...result, explicitReminderRequest: true };
  }
  if (missed) {
    // A model "nothing here" is the defect itself: the rules read the words.
    if (result.type !== 'task' && result.type !== 'follow_up') {
      result = ruleBasedExtract(rawText, context);
      engine = 'rule-based';
      fallbackReason ??= 'semantic_safety:missed_obligation';
    }
    result = asThingToDoToday(result, rawText, context);
  }
  result = withStatedShape(result, rawText, context);

  return {
    result,
    engine,
    fallbackReason,
  };
}


/* ── What the words themselves say about the shape (FIX-R8-CAPTURE) ──
 *
 * Read after either engine answered, before the past-time guard, so the model
 * and the rules cannot disagree about a recurrence or a range:
 *
 *   a recurrence   «كل سبت», "every Saturday", «כל שבת»: never a one-off on
 *                  today or on a day nobody named. With a weekday, the item is
 *                  on its next occurrence by the weekday rule (never today;
 *                  `weekdayLexicon` rule 1) and that day is marked ours — a
 *                  model that answered today or tomorrow is put there, its
 *                  hour kept. With only the week («كل أسبوع») a day the words
 *                  did not state is dropped and asked. The phrase stays in the
 *                  title, and `recurrenceHint` carries it for the weekly lane.
 *   a range        «من 10 لـ 4»: `rangeMinutes`, counted from the start that
 *                  was read (`rangeMinutesFrom`).
 */
function localTimeOf(result: ExtractionResult, timeZone: string): string | null {
  if (result.allDay) return null;
  if (result.localTimeSpec?.time) return result.localTimeSpec.time;
  const instant = result.remindAt ?? result.dueAt;
  if (instant) return localTimeSpecFor(new Date(Date.parse(instant)), timeZone)?.time ?? null;
  return result.undatedTime ?? null;
}

function nextOccurrence(weekdays: readonly number[], now: Date, timeZone: string): string | null {
  const today = localTimeSpecFor(now, timeZone)?.date;
  if (!today || weekdays.length === 0) return null;
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const current = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const ahead = Math.min(...weekdays.map((weekday) => daysUntilWeekday(current, { weekday, weeksLater: 0, today: false })));
  return new Date(Date.UTC(year, month - 1, day + ahead)).toISOString().slice(0, 10);
}

function onRecurrenceDay(result: ExtractionResult, recurrence: StatedRecurrence, rawText: string, now: Date, timeZone: string): ExtractionResult {
  const date = result.localTimeSpec?.date
    ?? (result.remindAt ?? result.dueAt ? localTimeSpecFor(new Date(Date.parse((result.remindAt ?? result.dueAt)!)), timeZone)?.date ?? null : null);
  // A calendar date the words give («every Saturday from 10 October») is theirs.
  if (namesCalendarDate(rawText)) return result;
  const time = localTimeOf(result, timeZone);
  if (recurrence.weekdays.length === 0) {
    // «كل أسبوع»: the week, no day. A day the words did state (today,
    // tomorrow) stays; any other is a guess, and is asked.
    if (!date || namesExplicitDate(rawText)) return result;
    return {
      ...result,
      dueAt: null,
      remindAt: null,
      localTimeSpec: null,
      dateInferred: false,
      allDay: false,
      ...(time ? { undatedTime: time } : {}),
      missingFields: result.missingFields.includes('time') ? result.missingFields : [...result.missingFields, 'time'],
    };
  }
  const target = nextOccurrence(recurrence.weekdays, now, timeZone);
  if (!target) return result;
  if (date === target) return { ...result, dateInferred: true };
  // "every Tuesday and Thursday": an item already on the coming Thursday is
  // on one of its days (audit 2026-10-03 #1) — moving it to the nearest of
  // them put the Thursday session on Tuesday, beside the Tuesday one.
  if (date && recurrence.weekdays.some((weekday) => nextOccurrence([weekday], now, timeZone) === date)) {
    return { ...result, dateInferred: true };
  }
  // Tonight's session of a list said today, before it starts ("every Monday
  // and Wednesday at 6pm", said Monday morning): the item already on today
  // stays there. A single day keeps FIX-R8's next-week rule.
  const local = localTimeSpecFor(now, timeZone);
  if (date && local && recurrence.weekdays.length > 1 && date === local.date && time && time > local.time) {
    const [year, month, day] = date.split('-').map(Number) as [number, number, number];
    if (recurrence.weekdays.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay())) return { ...result, dateInferred: true };
  }
  const { undatedTime: _undated, ...rest } = result;
  if (result.allDay) {
    const midnight = instantFromLocal(target, '00:00', timeZone)?.toISOString() ?? null;
    return { ...rest, dueAt: midnight, localTimeSpec: { date: target, time: null, timezone: timeZone }, dateInferred: true };
  }
  const instant = time ? instantFromLocal(target, time, timeZone)?.toISOString() ?? null : null;
  return {
    ...rest,
    dueAt: instant && (result.dueAt || !result.remindAt) ? instant : null,
    remindAt: instant && result.remindAt ? instant : null,
    localTimeSpec: { date: target, time: instant ? time : null, timezone: timeZone },
    dateInferred: true,
  };
}

/** The recurrence phrase in the title, as the person said it, when an engine's title dropped it. */
function withPhraseInTitle(result: ExtractionResult, phrases: readonly string[]): ExtractionResult {
  const title = result.title?.trim();
  if (!title) return result;
  const missing = phrases.filter((phrase) => !title.toLowerCase().includes(phrase.toLowerCase()));
  if (missing.length === 0) return result;
  const titled = `${title} ${missing.join(' ')}`;
  return { ...result, title: titled, ...(result.action === result.title ? { action: titled } : {}) };
}

function withStatedShape(result: ExtractionResult, rawText: string, context: ExtractionContext): ExtractionResult {
  if (result.type !== 'task' && result.type !== 'follow_up') return result;
  const timeZone = context.timezone || result.localTimeSpec?.timezone || 'UTC';
  let shaped = onRelativeTime(result, rawText, context);
  let recurrence = readRecurrence(rawText);
  // An item whose own words put it on a day outside the list is not the
  // list's (audit 2026-10-03 review, round 2): "gym every Tuesday and Thursday
  // at 7pm, and the dentist on Friday at 4pm" leaves the dentist on Friday.
  if (recurrence && recurrence.weekdays.length > 0) {
    const day = result.localTimeSpec?.date
      ?? (result.remindAt ?? result.dueAt ? localTimeSpecFor(new Date(Date.parse((result.remindAt ?? result.dueAt)!)), timeZone)?.date ?? null : null);
    if (day) {
      const [year, month, date] = day.split('-').map(Number) as [number, number, number];
      const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
      if (!recurrence.weekdays.includes(weekday) && readWeekdayMentions(rawText).includes(weekday)) recurrence = null;
    }
  }
  if (recurrence) {
    const placed = onRecurrenceDay(shaped, recurrence, rawText, context.now, timeZone);
    // The title as it always was: the phrase as the recurrence patterns read it.
    // A list's per-day items lose the whole phrase where they are made
    // (`withoutRecurrenceTitle`), and only when they are (round 4 D).
    // A list of days is not appended at all: half of it on a Thursday item
    // («Gym every Tuesday») says the wrong day. Words already in the title stay.
    shaped = recurrence.weekdays.length > 1 ? placed : withPhraseInTitle(placed, recurrence.shortPhrases ?? recurrence.phrases);
  }
  const range = readClockRange(rawText);
  const deterministicStart = range ? rangeStartTime(range) : null;
  if (range && deterministicStart && shaped.localTimeSpec?.date) {
    const instant = rangeEndInstant(shaped.localTimeSpec.date, deterministicStart, timeZone, 0);
    if (instant) {
      const iso = instant.toISOString();
      shaped = {
        ...shaped,
        dueAt: shaped.dueAt ? iso : null,
        remindAt: shaped.remindAt ? iso : null,
        localTimeSpec: { date: shaped.localTimeSpec.date, time: deterministicStart, timezone: timeZone },
      };
    }
  }
  const minutes = shaped.timeAnchor === 'deadline' ? null : rangeMinutesFrom(rawText, deterministicStart ?? localTimeOf(shaped, timeZone));
  if (minutes) shaped = { ...shaped, rangeMinutes: minutes, timeAnchor: 'event' };
  if (recurrence) shaped = { ...shaped, recurrenceHint: { weekdays: recurrence.weekdays } };
  return shaped;
}

/**
 * The weekly hint a proposal item carries (FIX-R8-CAPTURE): the days, and —
 * once the hour is settled, not a صبح/مسا still to ask — the start and the
 * end the words gave, `HH:MM` on the person's clock. Null when the words
 * state no recurrence. Content-free by construction.
 */
export function recurrenceHintOf(result: ExtractionResult, timeZone: string, settled: boolean): RecurrenceHint | null {
  if (!result.recurrenceHint) return null;
  const hint: RecurrenceHint = { weekdays: [...result.recurrenceHint.weekdays] };
  const start = settled && (result.localTimeSpec?.time || result.remindAt || result.dueAt) ? localTimeOf(result, timeZone) : null;
  if (!start) return hint;
  hint.start = start;
  if (result.rangeMinutes) {
    const minutes = (Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5)) + result.rangeMinutes) % (24 * 60);
    hint.end = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  return hint;
}
