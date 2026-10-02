/**
 * «حضّرني» — preparing for one meeting (closure lane CL5a).
 *
 * ── What comes in ────────────────────────────────────────────────
 *
 * A busy block's start and end, and the notes the person typed or pasted in
 * answer to «شو الاجتماع وشو بدك تحضّر؟». Nothing else: the block is a
 * device-calendar busy time, which the app reads without a title, and that
 * stays true here — the server is never told what the calendar calls it.
 *
 * ── What goes out ────────────────────────────────────────────────
 *
 * An ordinary capture proposal: exactly one prep step, due a sensible lead
 * before the meeting, then at most three follow-ups. It is stored in the same
 * collection as every capture proposal, under the same TTL, and confirmed by
 * the same `/api/mobile/capture/confirm` — so the review screen, the edit
 * sheet, Undo and the "nothing is saved until you confirm" rule are the ones
 * the product already has, not a second copy of them.
 *
 * ── The pipeline ─────────────────────────────────────────────────
 *
 * The notes go through `normalizeMeetingTranscript` (untrusted content, with
 * its injection signals) and the candidates through `createMeetingPrepProposals`
 * (the transcript path's own validation and dedupe). The model, when it may be
 * asked, only proposes candidates; with AI consent off, with an instruction
 * found in the notes, or with an answer that cannot be used, the prep step is
 * the notes' first action sentence and there are no follow-ups.
 *
 * ── The notes are not kept ───────────────────────────────────────
 *
 * Not on the proposal, not in a log, not in a trace. What is stored is the
 * proposal's titles — the steps the person is about to be asked to confirm.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  CAPTURE_CONTRACT_VERSION,
  CAPTURE_INPUT_MAX_CHARACTERS,
  captureAppLocaleFrom,
  type CaptureAppLocale,
  type CaptureProposalContract,
} from '../../../src/contracts/v1/captureContracts';
import { titleScript } from '../../../src/extraction/schemaValidator';
import { titleDropReason } from '../share/shareAllowlist';
import type { AiConsentState } from '../../../src/contracts/v1/consentContracts';
import type { Command } from '../../../src/domain/stateMachine';
import { toVertexSchema } from '../../../src/extraction/llm/vertexSchema';
import { configuredProviderName } from '../../../src/extraction/llm';
import { getAiConsent } from '../../consents/aiConsentService';
import {
  MAX_MEETING_ACTION_LENGTH,
  createMeetingPrepProposals,
  firstActionSentence,
  normalizeMeetingTranscript,
  type MeetingActionCandidate,
  type UntrustedMeetingContext,
} from '../../integrations/meetings/meetingIntelligence';
import { MEETING_PREP_SCHEMA, buildMeetingPrepPrompt } from '../../integrations/meetings/meetingPrepPrompt';
import { shareLlmProvider, type ShareStructuredGenerator } from '../../llm/shareProvider';
import { splitPrompt } from '../../llm/captureProvider';
import { NO_QUIET_HOURS, isInQuietHours, readQuietHours, type QuietHours } from '../../push/quietHours';
import {
  CaptureInputTooLargeError,
  createStorageCaptureProposalStore,
  type CaptureProposalStore,
} from '../captureBoundary';
import { getStorage, userDoc, type StorageAdapter } from '../../storage';
import { localDayKey, localMidnightOf, normalizeTimezone } from './time';
import { hardSettingsOfUser, readReminderSettings } from './reminderSettingsService';
import { dayPartHour, instantFromLocal } from '../../../src/extraction/timeLexicon';
import { clockTimesIn } from '../../../src/extraction/ruleBasedExtractor';
import { isTimedWindow, type DomainState } from '../../../src/domain/stateMachine';
import { loadDomainState } from './participantState';
import { namesPreparedEvent } from '../nextStepPreparation';

/** How long before the meeting the prep step is due. */
export const MEETING_PREP_LEAD_MINUTES = 60;
/** A meeting starting sooner than this has no time left to prepare for. */
export const MEETING_PREP_MIN_NOTICE_MINUTES = 10;
/** How far ahead a meeting may be prepared for. Beyond it, a block is not "the next meeting". */
export const MEETING_PREP_MAX_DAYS_AHEAD = 60;
/** How many meeting preps one account may run in a UTC day. */
export const MAX_MEETING_PREPS_PER_DAY = 20;

const MINUTE = 60_000;
const STEP = 5 * MINUTE;
/** The prep step never lands closer to the start than this, nor sooner than this from now. */
const MARGIN = 5 * MINUTE;
const PREP_TIMEOUT_MS = 15_000;
const PREP_MAX_OUTPUT_TOKENS = 512;

export type MeetingPrepRefusal = 'notes_required' | 'invalid_block' | 'meeting_too_soon' | 'meeting_too_far';

/** A request this service will not run, with the reason code the route answers with. */
export class MeetingPrepInputError extends Error {
  constructor(readonly reason: MeetingPrepRefusal) {
    super(`meeting prep refused: ${reason}`);
    this.name = 'MeetingPrepInputError';
  }
}

export interface MeetingPrepInput {
  notes?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  timezone?: unknown;
  /** The phone's UI language, `'ar' | 'en' | 'he'`: the steps are titled in it (owner request 2026-09-30). */
  locale?: unknown;
  /**
   * The person's own commitment this prepares for, when it is one (audit
   * 2026-10-03 #3). Its title — already theirs, already on the server — says
   * whether it is an exam, which wants a day of lead, or a meeting, which
   * wants an hour. Optional: a busy block has none, and an older phone sends
   * none.
   */
  commitmentId?: unknown;
}

export interface ValidMeetingPrepInput {
  readonly notes: string;
  readonly start: Date;
  readonly end: Date | null;
  readonly timezone: string;
  readonly locale?: CaptureAppLocale;
  readonly commitmentId?: string;
}

/**
 * The checks that need no storage, in the order the route needs them: the
 * route runs this before it spends one of the day's preps, so a request that
 * was always going to be refused costs nothing.
 */
export function validateMeetingPrepInput(input: MeetingPrepInput, now: Date): ValidMeetingPrepInput {
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (!notes) throw new MeetingPrepInputError('notes_required');
  // The capture limit, and the capture error, so the phone's existing 413
  // handling says the same sentence it says in the composer.
  if (notes.length > CAPTURE_INPUT_MAX_CHARACTERS) throw new CaptureInputTooLargeError();
  const start = instant(input.startAt);
  if (!start) throw new MeetingPrepInputError('invalid_block');
  let end: Date | null = null;
  if (input.endAt !== undefined && input.endAt !== null) {
    end = instant(input.endAt);
    if (!end || end.getTime() <= start.getTime()) throw new MeetingPrepInputError('invalid_block');
  }
  if (start.getTime() < now.getTime() + MEETING_PREP_MIN_NOTICE_MINUTES * MINUTE) {
    throw new MeetingPrepInputError('meeting_too_soon');
  }
  if (start.getTime() > now.getTime() + MEETING_PREP_MAX_DAYS_AHEAD * 24 * 60 * MINUTE) {
    throw new MeetingPrepInputError('meeting_too_far');
  }
  const locale = captureAppLocaleFrom(input.locale);
  const commitmentId = typeof input.commitmentId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.commitmentId)
    ? input.commitmentId : undefined;
  return {
    notes, start, end, timezone: normalizeTimezone(input.timezone),
    ...(locale ? { locale } : {}), ...(commitmentId ? { commitmentId } : {}),
  };
}

function instant(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export type PrepAdjustment = 'none' | 'short_notice' | 'quiet_hours' | 'quiet_hours_unavoidable';

/**
 * When the prep step is due: an hour before the start, kept out of quiet hours.
 *
 * Inside quiet hours it moves to when they end, if that is still before the
 * meeting — an 08:00 meeting with quiet hours until 07:30 is prepared for at
 * 07:30. When they end too late, it moves to just before they begin the
 * evening before. Only when neither is possible (a meeting a few minutes after
 * a quiet night the person is already in) does it stay where it was, and says
 * so. Five-minute steps through `isInQuietHours`, which already reads the wall
 * clock through `Intl` and crosses midnight correctly; a second implementation
 * of the window would be a second chance to get the wrap backwards.
 */
export function schedulePrepAt(start: Date, now: Date, quietHours: QuietHours): { at: Date; adjustment: PrepAdjustment } {
  const earliest = now.getTime() + MARGIN;
  const latest = start.getTime() - MARGIN;
  let candidate = start.getTime() - MEETING_PREP_LEAD_MINUTES * MINUTE;
  let adjustment: PrepAdjustment = 'none';
  if (candidate < earliest) {
    candidate = Math.ceil(earliest / STEP) * STEP;
    adjustment = 'short_notice';
  }
  if (!isInQuietHours(quietHours, new Date(candidate))) return { at: new Date(candidate), adjustment };

  const dayOfSteps = (24 * 60 * MINUTE) / STEP;
  let forward = Math.ceil(candidate / STEP) * STEP;
  for (let i = 0; i < dayOfSteps && isInQuietHours(quietHours, new Date(forward)); i += 1) forward += STEP;
  if (forward <= latest && !isInQuietHours(quietHours, new Date(forward))) {
    return { at: new Date(forward), adjustment: 'quiet_hours' };
  }
  let backward = Math.floor(candidate / STEP) * STEP;
  for (let i = 0; i < dayOfSteps && isInQuietHours(quietHours, new Date(backward)); i += 1) backward -= STEP;
  if (backward >= earliest && !isInQuietHours(quietHours, new Date(backward))) {
    return { at: new Date(backward), adjustment: 'quiet_hours' };
  }
  return { at: new Date(candidate), adjustment: 'quiet_hours_unavoidable' };
}

/**
 * ── An exam is prepared for the day before, not an hour before ───
 *
 * Audit 2026-10-03 #3: «حضّرني» on tomorrow's 10:00 exam proposed one session
 * at 09:00 on the day, with the whole afternoon before it free. An hour ahead
 * is right for a meeting; for an exam, an interview or a presentation
 * (`namesPreparedEvent`, on the person's own title or notes) that falls on a
 * later day, the main session is the first free hour on the day before, and
 * the hour-before step stays as a short review when there is room for both.
 *
 * "Free" is the person's own data only: not inside quiet hours, not over any
 * of their timed commitments, between `DAY_WINDOW` hours, and never sooner
 * than `SESSION_NOTICE` from now. Nothing found leaves the hour-before plan
 * as it was.
 */
export const PREP_SESSION_MINUTES = 60;
/** The day-before session starts no earlier than 08:00 and no later than 21:00, local. */
const DAY_WINDOW = { firstHour: 8, lastStartHour: 21 } as const;
/** A session is not proposed to start sooner than this from now. */
const SESSION_NOTICE = 30 * MINUTE;
const HALF_HOUR = 30 * MINUTE;

export type PrepTimingKind = 'hour_before' | 'day_before';

interface BusyInterval { readonly start: number; readonly end: number }

/** The person's timed commitments as busy time, the event itself excepted. */
export function busyIntervalsOf(state: DomainState, exceptId: string | undefined): BusyInterval[] {
  return Object.values(state.commitments).flatMap((commitment): BusyInterval[] => {
    if (commitment.id === exceptId || commitment.status !== 'active' || commitment.timeSpec.allDay || !commitment.timeSpec.dueAt) return [];
    const start = Date.parse(commitment.timeSpec.dueAt);
    if (!Number.isFinite(start)) return [];
    // A window (a prep step done by its meeting) takes its session, not the
    // whole run up to the meeting; anything else its own end, or an hour.
    const ownEnd = !isTimedWindow(commitment.timeSpec) && commitment.timeSpec.endAt ? Date.parse(commitment.timeSpec.endAt) : Number.NaN;
    return [{ start, end: Number.isFinite(ownEnd) && ownEnd > start ? ownEnd : start + PREP_SESSION_MINUTES * MINUTE }];
  });
}

function localHourOf(at: number, timezone: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(at));
  return Number(hour) % 24;
}

/** The first free `PREP_SESSION_MINUTES` on the local day `dayKey`, or null. */
export function firstFreeSession(
  dayKey: string,
  timezone: string,
  now: Date,
  latestEnd: number,
  quietHours: QuietHours,
  busy: readonly BusyInterval[],
): Date | null {
  const midnight = Date.parse(localMidnightOf(dayKey, timezone));
  const length = PREP_SESSION_MINUTES * MINUTE;
  let at = Math.max(midnight, Math.ceil((now.getTime() + SESSION_NOTICE) / HALF_HOUR) * HALF_HOUR);
  for (; at < midnight + 26 * 60 * MINUTE; at += HALF_HOUR) {
    if (localDayKey(new Date(at), timezone) !== dayKey) {
      if (at > midnight) break;
      continue;
    }
    const hour = localHourOf(at, timezone);
    if (hour < DAY_WINDOW.firstHour) continue;
    if (hour > DAY_WINDOW.lastStartHour) break;
    const end = at + length;
    if (end > latestEnd) break;
    if (isInQuietHours(quietHours, new Date(at)) || isInQuietHours(quietHours, new Date(end - MINUTE))) continue;
    if (busy.some((interval) => interval.start < end && interval.end > at)) continue;
    return new Date(at);
  }
  return null;
}

/**
 * When to prepare: the main session, and the short review when there is one.
 * `day_before` only for an event worth preparing for on a later day.
 */
export function planPrepSessions(input: {
  start: Date;
  now: Date;
  timezone: string;
  quietHours: QuietHours;
  busy: readonly BusyInterval[];
  preparedEvent: boolean;
}): { kind: PrepTimingKind; main: { at: Date; adjustment: PrepAdjustment }; review: { at: Date; adjustment: PrepAdjustment } | null } {
  const hourBefore = schedulePrepAt(input.start, input.now, input.quietHours);
  const eventDay = localDayKey(input.start, input.timezone);
  if (!input.preparedEvent || eventDay <= localDayKey(input.now, input.timezone)) {
    return { kind: 'hour_before', main: hourBefore, review: null };
  }
  const dayBefore = localDayKey(new Date(Date.parse(localMidnightOf(eventDay, input.timezone)) - 12 * 60 * MINUTE), input.timezone);
  const main = firstFreeSession(dayBefore, input.timezone, input.now, input.start.getTime() - PREP_SESSION_MINUTES * MINUTE, input.quietHours, input.busy);
  if (!main) return { kind: 'hour_before', main: hourBefore, review: null };
  // The review keeps the hour-before rule, when it is after the session and
  // was not pushed out of shape by quiet hours it could not avoid.
  const review = hourBefore.at.getTime() >= main.getTime() + PREP_SESSION_MINUTES * MINUTE
    && hourBefore.adjustment !== 'quiet_hours_unavoidable' ? hourBefore : null;
  return { kind: 'day_before', main: { at: main, adjustment: 'none' }, review };
}

/** The short review's title, in the app's language or the prep step's own script. */
export function reviewTitle(prepTitle: string, locale: CaptureAppLocale | undefined): string {
  const language = locale ?? (titleScript(prepTitle) as CaptureAppLocale | null) ?? 'en';
  const title = language === 'ar' ? `مراجعة سريعة: ${prepTitle}`
    : language === 'he' ? `חזרה קצרה: ${prepTitle}`
      : `Quick review: ${prepTitle}`;
  return Array.from(title).slice(0, MAX_MEETING_ACTION_LENGTH).join('');
}

export interface MeetingPrepSummary {
  /** Which item in `proposal.items` is the prep step. Always the first. */
  readonly itemId: string;
  /**
   * When the phone first rings for it: the chosen prep instant whenever the
   * account's reminders can ring then, the ring they do make otherwise, and
   * null when nothing will ring at all (I-3).
   */
  readonly remindAt: string | null;
  /** Why nothing rings, when nothing does (`silenceOf`). */
  readonly silentBecause: PrepSilence | null;
  /**
   * Its deadline, never after the start (see `prepTiming`): the stored
   * `timeSpec.endAt`, which the phone counts its lead back from. The step itself
   * is shown at the prep instant, `proposal.items[0].resolvedTime` (FX1).
   */
  readonly dueAt: string;
  /** Minutes between the chosen prep instant and the meeting's start. */
  readonly leadMinutes: number;
  readonly adjustment: PrepAdjustment;
  readonly startAt: string;
  readonly endAt: string | null;
  /**
   * Why the prep step is when it is (audit 2026-10-03 #3): `hour_before`, the
   * rule a meeting has always had; `day_before`, the first free hour the day
   * before an exam-like event. Added for Review's "why this time" line; an
   * older phone ignores it.
   */
  readonly timing: PrepTimingKind;
  /** Every preparation session proposed, the prep step first. More than one only with `day_before`. */
  readonly sessions: readonly { readonly itemId: string; readonly at: string }[];
}

export interface MeetingPrepResult {
  readonly proposal: CaptureProposalContract;
  readonly prep: MeetingPrepSummary;
}

export interface MeetingPrepOptions {
  now?: Date;
  storage?: StorageAdapter;
  store?: CaptureProposalStore;
  /** Injected by tests. Production uses the gated, metered, logged provider. */
  generate?: ShareStructuredGenerator;
  consent?: (uid: string) => Promise<AiConsentState>;
  quietHours?: QuietHours;
  /** The account's reminder lead, in minutes. Read from its settings when absent. */
  softLeadMinutes?: number;
  /** The account's reminder settings, whole. Read from its settings when absent. */
  ringSettings?: PrepRingSettings;
}

/** The notes, a segment per line, as the meeting pipeline expects them. */
function segmentsOf(notes: string) {
  return notes
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ speaker: null, spokenAt: null, text }));
}

function localText(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, weekday: 'long', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(at);
}

function actionFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const action = value.replace(/\s+/g, ' ').trim();
  const length = Array.from(action).length;
  return length >= 2 && length <= MAX_MEETING_ACTION_LENGTH ? action : null;
}

/** One follow-up as the model gave it, before it is checked. */
interface ModelFollowUp {
  readonly action: string;
  /** The same action in the app's language, when the model gave one (owner request 2026-09-30). */
  readonly appAction: string | null;
  readonly date: string | null;
  readonly time: string | null;
}

interface ModelCandidates {
  readonly prep: string;
  readonly prepAppAction: string | null;
  readonly followUps: readonly ModelFollowUp[];
}

/**
 * The title a step is shown and saved with (owner request 2026-09-30): the
 * model's app-language one, across languages only, and never one that — or
 * whose own-words original — is a link, a contact instruction or a sentence to
 * the assistant. Every check on the notes (the clause a follow-up's hour is
 * read from, the transcript's own validation) reads `action`, in the notes'
 * words; this is applied after them.
 */
function shownTitle(action: string, appAction: string | null | undefined, locale: CaptureAppLocale | undefined): string {
  if (!locale || !appAction || appAction === action) return action;
  if (titleScript(action) === locale || titleScript(appAction) !== locale) return action;
  if (titleDropReason(action) !== null || titleDropReason(appAction) !== null) return action;
  return appAction;
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The model's answer, or null when there is no usable prep step in it. */
function parseModelAnswer(text: string): ModelCandidates | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { prepStep?: { action?: unknown; appAction?: unknown }; followUps?: unknown };
  const prep = actionFrom(record.prepStep?.action);
  if (!prep) return null;
  const followUps = (Array.isArray(record.followUps) ? record.followUps : []).flatMap((entry): ModelFollowUp[] => {
    const item = entry as { action?: unknown; appAction?: unknown; deadlineDate?: unknown; deadlineTime?: unknown };
    const action = actionFrom(item?.action);
    if (!action) return [];
    const date = typeof item.deadlineDate === 'string' && LOCAL_DATE.test(item.deadlineDate.trim()) ? item.deadlineDate.trim() : null;
    const time = typeof item.deadlineTime === 'string' && LOCAL_TIME.test(item.deadlineTime.trim()) ? item.deadlineTime.trim() : null;
    return [{ action, appAction: actionFrom(item.appAction), date, time }];
  });
  return { prep, prepAppAction: actionFrom(record.prepStep?.appAction), followUps };
}

/** When a follow-up is due: an instant, a whole day, or nothing. */
type FollowUpWhen =
  | { readonly kind: 'instant'; readonly dueAt: string }
  | { readonly kind: 'day'; readonly date: string; readonly dueAt: string }
  | { readonly kind: 'none' };

/**
 * A follow-up's day and hour, kept only when they can be believed (M-3).
 *
 * The hour comes from the follow-up's own clause (`followUpClock`), never from
 * the model alone: the prompt forbids a guess, and this enforces it. The
 * meeting's own «الساعة ١٠» elsewhere in the notes is no licence for one.
 * Without an hour the follow-up is an all-day commitment on that day, which is
 * how a day with no chosen hour is stored everywhere else (`TimeSpec.allDay`).
 * A day before the meeting, or beyond the horizon a meeting may be prepared
 * in, is no day at all.
 */
const NOT_A_LETTER_OR_DIGIT = new RegExp('[^\\p{L}\\p{N}]+', 'u');

/**
 * An Arabic word without the letters that attach to its front — «و», «ف»,
 * «ب», «ك», «ل» and the article — so «لسامي» and «سامي», «الملخص» and
 * «ملخص» are one word (re-review 2, n-1b: a model that writes «إرسال الملخص
 * إلى سامي» for «أبعت الملخص لسامي» still names that clause). Both sides of a
 * comparison go through it, so a word it clips wrongly is clipped the same
 * way on each; any other script is left alone.
 */
function withoutArabicClitics(word: string): string {
  if (!/^[ء-ي]/.test(word)) return word;
  let rest = word;
  if (/^[وف]/.test(rest) && Array.from(rest).length > 3) rest = rest.slice(1);
  if (rest.startsWith('لل') && Array.from(rest).length > 3) return rest.slice(2);
  if (/^[بكل]/.test(rest) && Array.from(rest).length > 3) rest = rest.slice(1);
  if (rest.startsWith('ال') && Array.from(rest).length > 3) rest = rest.slice(2);
  return rest;
}

/** Letters and digits, lower-cased, with the Arabic spellings that vary folded together. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .split(NOT_A_LETTER_OR_DIGIT)
    .map(withoutArabicClitics)
    .filter((word) => Array.from(word).length >= 2);
}

/**
 * Words that start the next thing the person has to do, in a note dictated
 * without punctuation: «اجتماع الساعة ١٠ وبعده لازم أبعت الملخص…» is two
 * clauses (re-review 2, n-1a). The word stays with the clause it starts.
 */
const NEXT_CLAUSE = new RegExp(
  [
    /(?<=\s)(?=(?:وبعده|وبعدها|وبعدين|بعدين|وبعد هيك|بعد هيك)(?:\s|$))/.source,
    /(?<=\s)(?=(?:and then|then|after that|afterwards)\b)/.source,
    /(?<=\s)(?=(?:ואחר כך|ואחרי זה|ואז)(?:\s|$))/.source,
  ].join('|'),
  'iu',
);

/**
 * The notes cut into clauses: at line ends and sentence ends, before a word
 * that starts the next thing to do (`NEXT_CLAUSE`), and at a comma when both
 * sides are clauses of their own (three words or more each) — so «…الساعة
 * ١٠، بعده لازم أبعت الملخص…» is two clauses, and "Send the summary on
 * Sunday, at 4pm" stays one.
 */
function clausesOf(notes: string): string[] {
  const clauses: string[] = [];
  for (const sentence of notes.split(/[\n.!?؟;؛]+/).flatMap((part) => part.split(NEXT_CLAUSE))) {
    const parts = sentence.split(/[,،]/);
    let current = parts[0] ?? '';
    for (const part of parts.slice(1)) {
      if (wordsOf(current).length >= 3 && wordsOf(part).length >= 3) {
        clauses.push(current);
        current = part;
      } else {
        current = `${current},${part}`;
      }
    }
    clauses.push(current);
  }
  return clauses.filter((clause) => clause.trim());
}

/**
 * The clause of the notes a follow-up came from: the one sharing the most of
 * its words, and at least half of them. A follow-up the notes do not
 * recognisably say has no clause, and so no hour.
 */
function ownClause(action: string, notes: string): string | null {
  const wanted = new Set(wordsOf(action));
  if (wanted.size === 0) return null;
  let best: { clause: string; shared: number } | null = null;
  for (const clause of clausesOf(notes)) {
    const words = new Set(wordsOf(clause));
    const shared = Array.from(wanted).filter((word) => words.has(word)).length;
    if (!best || shared > best.shared) best = { clause, shared };
  }
  return best && best.shared * 2 >= wanted.size ? best.clause : null;
}

/**
 * The hour a follow-up keeps, `HH:MM`, or null for none (M-3, round 3).
 *
 * - The model's hour, when its own clause writes that clock time («الساعة ٤
 *   العصر» for 16:00; the half of the day is the model's reading of it).
 * - Otherwise, when the clause writes no clock time but names a part of the
 *   day, the product's hour for it — «يوم الأحد الصبح» is Sunday 09:00, which
 *   is what capture makes of the same words (`dayPartHour`). The period is the
 *   person's; only its hour is the product's, the same one everywhere.
 * - Otherwise none: an hour the model gave that the clause does not write is
 *   a guess, and a clause that writes some other clock time (the meeting's,
 *   when nothing separates the two) cannot say which is the follow-up's.
 */
function followUpClock(followUp: ModelFollowUp, notes: string): { time: string; guessed: boolean } | null {
  const clause = ownClause(followUp.action, notes);
  if (clause === null) return null;
  const written = clockTimesIn(clause);
  const model = followUp.time ? /^(\d{1,2}):(\d{2})$/.exec(followUp.time) : null;
  if (model && written.some((clock) => clock.hour % 12 === Number(model[1]) % 12 && clock.minute === Number(model[2]))) {
    return { time: followUp.time!, guessed: false };
  }
  if (written.length > 0) return null;
  const part = dayPartHour(clause);
  // The part of the day's hour is ours, and the review card says so (UAT
  // round 6, D2): capture marks «يوم الأحد الصبح» the same way.
  return part === null ? null : { time: `${String(part).padStart(2, '0')}:00`, guessed: true };
}

function followUpWhen(followUp: ModelFollowUp, valid: ValidMeetingPrepInput, now: Date, time: string | null): FollowUpWhen {
  if (!followUp.date) return { kind: 'none' };
  const after = (valid.end ?? valid.start).getTime();
  const horizon = after + MEETING_PREP_MAX_DAYS_AHEAD * 24 * 60 * MINUTE;
  if (time) {
    const at = instantFromLocal(followUp.date, time, valid.timezone);
    if (at && at.getTime() > after && at.getTime() > now.getTime() && at.getTime() <= horizon) {
      return { kind: 'instant', dueAt: at.toISOString() };
    }
    return { kind: 'none' };
  }
  const meetingDay = localDayKey(valid.start, valid.timezone);
  if (followUp.date < meetingDay) return { kind: 'none' };
  const midnight = localMidnightOf(followUp.date, valid.timezone);
  if (Date.parse(midnight) > horizon) return { kind: 'none' };
  return { kind: 'day', date: followUp.date, dueAt: midnight };
}

async function askModel(
  context: UntrustedMeetingContext,
  valid: ValidMeetingPrepInput,
  now: Date,
  generate: ShareStructuredGenerator,
): Promise<ModelCandidates | null> {
  const { system, user } = splitPrompt(buildMeetingPrepPrompt({
    transcript: context.transcript,
    startsAtLocal: localText(valid.start, valid.timezone),
    endsAtLocal: valid.end ? localText(valid.end, valid.timezone) : null,
    nowLocal: localText(now, valid.timezone),
    timezone: valid.timezone,
    ...(valid.locale ? { appLanguage: valid.locale } : {}),
  }));
  try {
    const response = await generate({
      system,
      parts: [{ kind: 'text', text: user }],
      responseSchema: toVertexSchema(MEETING_PREP_SCHEMA),
      maxOutputTokens: PREP_MAX_OUTPUT_TOKENS,
      timeoutMs: PREP_TIMEOUT_MS,
    });
    return parseModelAnswer(response.text);
  } catch {
    // No model, no consent, over a cap, a timeout, or the kill switch. The
    // provider already logged which, without the notes; to the person they
    // all mean the same thing — the rules read the notes instead.
    return null;
  }
}

type StepTime =
  | {
    readonly kind: 'due_by'; readonly dueAt: string; readonly remindAt: string | null; readonly allDay: boolean;
    /** The prep step's deadline, when it is done by a later instant than it is shown at (`deadlineOfTimeSpec`). */
    readonly endAt?: string;
  }
  | { readonly kind: 'unscheduled' };

/**
 * The commands one proposed item confirms into.
 *
 * Built here rather than by `mapExtractionToCommand`: a follow-up with no
 * deadline would come out of that as `needs_clarification`, and the confirm's
 * activation step only activates what is `pending_confirmation` — so the
 * person would confirm it and never see it. A meeting step is something they
 * are about to agree to by name; it has nothing left to clarify.
 */
function commandsFor(title: string, when: StepTime, timezone: string, now: Date): Command[] {
  return [{
    type: 'CreateDraft',
    now: now.toISOString(),
    draftStatus: 'pending_confirmation',
    commitment: {
      id: randomUUID(),
      kind: 'task',
      title,
      description: null,
      person: null,
      priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
      category: null,
      timeSpec: when.kind === 'due_by'
        ? { kind: 'due_by', dueAt: when.dueAt, endAt: when.endAt ?? null, remindAt: when.remindAt, allDay: when.allDay, timezone }
        : { kind: 'unscheduled', dueAt: null, remindAt: null, timezone },
    },
  }];
}

/** What decides whether, and how early, the phone reminds an ordinary commitment. */
export interface PrepRingSettings {
  /** The reminders switch. Off: the phone schedules nothing. */
  readonly softEnabled: boolean;
  /** 60, 30 or 15. */
  readonly softLeadMinutes: number;
  readonly escalationCeiling: 'soft' | 'followUp' | 'hard';
  /** The routine survey's `none`: the phone schedules nothing for it either. */
  readonly surveySaysNone: boolean;
}

/** The phone's follow-up lead (`FOLLOW_UP_LEAD_MINUTES`). */
const PHONE_FOLLOW_UP_LEAD_MINUTES = 30;
/** A ring the phone moved out of quiet hours this close to the start is dropped (`MIN_LEAD_AFTER_DEFER_MS`). */
const PHONE_MIN_LEAD_AFTER_DEFER = 5 * MINUTE;

/**
 * Every instant the phone rings a prep window `[opensAt, deadline]`, earliest
 * first (post-UAT FX1, ruling R1).
 *
 * The phone's `planFor` for a window at `normal` priority, which it reads as
 * Should: the gentle stage at the opening itself, whatever the account's
 * lead; the follow-up half an hour before the deadline when the ceiling
 * allows it and that is after the opening; nothing with reminders off or the
 * survey's `none`. Then `desiredRequests`: a ring inside quiet hours moves to
 * when they end and is dropped when that is within five minutes of the
 * deadline (`deferOutOfQuietHours`), and a moment already past is not
 * scheduled. The pipeline and route tests run the phone's own engine against
 * what this decides, so a drift between the two is a red test.
 */
export function phoneWindowRings(
  opensAt: Date,
  deadline: Date,
  settings: PrepRingSettings,
  now: Date,
  quietHours: QuietHours,
): number[] {
  if (!settings.softEnabled || settings.surveySaysNone) return [];
  const planned = [opensAt.getTime()];
  const followUp = deadline.getTime() - PHONE_FOLLOW_UP_LEAD_MINUTES * MINUTE;
  if (settings.escalationCeiling !== 'soft' && followUp > opensAt.getTime()) planned.push(followUp);
  const rings = new Set<number>();
  for (let at of planned) {
    if (isInQuietHours(quietHours, new Date(at))) {
      // The window's end is a wall-clock minute: walk the minutes to it.
      let end = Math.floor(at / MINUTE) * MINUTE;
      for (let i = 0; i <= 24 * 60 && isInQuietHours(quietHours, new Date(end)); i += 1) end += MINUTE;
      if (end > deadline.getTime() - PHONE_MIN_LEAD_AFTER_DEFER) continue;
      at = end;
    }
    if (at <= now.getTime()) continue;
    rings.add(at);
  }
  return Array.from(rings).sort((left, right) => left - right);
}

export interface PrepTiming {
  /** The deadline: the meeting's start, always (ruling R1). */
  readonly dueAt: Date;
  /** The phone's first ring for the step, or null when nothing will ring. */
  readonly ringAt: Date | null;
}

/**
 * When the prep step is due, and when — if at all — the phone rings for it.
 *
 * The step is a window from the prep instant to the meeting's start. The
 * phone rings its opening, so the claim is the prep instant itself; when
 * nothing can ring (reminders off, the survey's silence, quiet hours the
 * person is already in), it is null, said as nothing, with the reason
 * `silenceOf` gives. What the proposal shows is therefore always a ring that
 * happens, and the time it happens at is the time every screen shows.
 */
export function prepTiming(start: Date, prepAt: Date, now: Date, settings: PrepRingSettings, quietHours: QuietHours): PrepTiming {
  const [first] = phoneWindowRings(prepAt, start, settings, now, quietHours);
  return { dueAt: start, ringAt: first === undefined ? null : new Date(first) };
}

/**
 * Why the phone rings nothing for the prep step, in the words Review uses.
 *
 * - `reminders_off`: the reminders switch is off.
 * - `silent_choice`: the switch is on, but the survey said «صامتة» (`none`),
 *   which the phone plans nothing for — the person's choice, not a switch.
 * - `quiet_hours`: it would ring, but every moment it could falls in quiet
 *   hours — they end too close to the meeting (07:32 at 22:40) or the meeting
 *   is inside them (06:00, 00:00). Review says only what holds for both (I-4).
 * - `too_close`: no moment is left before the meeting to ring at.
 */
export type PrepSilence = 'reminders_off' | 'silent_choice' | 'quiet_hours' | 'too_close';

function silenceOf(settings: PrepRingSettings, opensAt: Date, deadline: Date, now: Date): PrepSilence {
  if (!settings.softEnabled) return 'reminders_off';
  if (settings.surveySaysNone) return 'silent_choice';
  return phoneWindowRings(opensAt, deadline, settings, now, NO_QUIET_HOURS).length > 0 ? 'quiet_hours' : 'too_close';
}

/** The settings `prepTiming` needs, resolved exactly as the settings screen resolves them. */
async function readPrepRingSettings(uid: string, options: { storage?: StorageAdapter }): Promise<PrepRingSettings> {
  const settings = await readReminderSettings(uid, options);
  const user = await (options.storage ?? getStorage()).get(userDoc(uid));
  return {
    softEnabled: settings.softEnabled,
    softLeadMinutes: settings.softLeadMinutes,
    escalationCeiling: settings.escalationCeiling,
    surveySaysNone: hardSettingsOfUser(user).surveySaysNone,
  };
}

export async function prepareMeeting(uid: string, input: MeetingPrepInput, options: MeetingPrepOptions = {}): Promise<MeetingPrepResult> {
  const now = options.now ?? new Date();
  const valid = validateMeetingPrepInput(input, now);

  const meetingId = `block-${createHash('sha256').update(`${valid.start.toISOString()}|${valid.end?.toISOString() ?? ''}`).digest('hex').slice(0, 20)}`;
  const context = normalizeMeetingTranscript({
    provider: 'maybesitter',
    connectionId: 'user_notes',
    meetingId,
    occurredAt: valid.start.toISOString(),
    segments: segmentsOf(valid.notes),
    source: 'user_notes',
  });

  // Decided here, from the consent the server holds — never from the request.
  // An instruction found in the notes keeps them away from the model too: they
  // are the person's own words to confirm, not something to hand on.
  const consent = await (options.consent ?? getAiConsent)(uid);
  const requestedEngine: 'model' | 'rules' = consent === 'granted' && context.injectionSignals.length === 0 ? 'model' : 'rules';
  const answered = requestedEngine === 'model'
    ? await askModel(context, valid, now, options.generate ?? shareLlmProvider(uid, { purpose: 'meeting_prep' }))
    : null;

  const prepAction = answered?.prep ?? firstActionSentence(valid.notes);
  // `validateMeetingPrepInput` refused empty notes, so there is a sentence.
  if (!prepAction) throw new MeetingPrepInputError('notes_required');

  const storageOption = options.storage ? { storage: options.storage } : {};
  const quietHours = options.quietHours ?? await readQuietHours(uid, storageOption);
  const ringSettings = options.ringSettings ?? await readPrepRingSettings(uid, storageOption);
  const settings = options.softLeadMinutes === undefined ? ringSettings : { ...ringSettings, softLeadMinutes: options.softLeadMinutes };
  // The commitment's own title and the notes both say what it is; the
  // person's other timed commitments are where a session cannot go.
  const state = await loadDomainState(options.storage ?? getStorage(), uid);
  const eventTitle = valid.commitmentId ? state.commitments[valid.commitmentId]?.title ?? '' : '';
  const sessions = planPrepSessions({
    start: valid.start, now, timezone: valid.timezone, quietHours,
    busy: busyIntervalsOf(state, valid.commitmentId),
    preparedEvent: namesPreparedEvent(eventTitle) || namesPreparedEvent(valid.notes),
  });
  const due = sessions.main;
  const timing = prepTiming(valid.start, due.at, now, settings, quietHours);
  const ringAt = timing.ringAt?.toISOString() ?? null;

  // The follow-up's own clause decides whether it keeps an hour, and which.
  const followUps = (answered?.followUps ?? []).map((followUp) => {
    const clock = followUpClock(followUp, valid.notes);
    return { followUp, when: followUpWhen(followUp, valid, now, clock?.time ?? null), hourGuessed: clock?.guessed === true };
  });
  const whenByKey = new Map(followUps.map(({ followUp, when, hourGuessed }) => [
    `${followUp.action.toLowerCase()}\0${when.kind === 'none' ? '' : when.dueAt}`, { when, hourGuessed, appAction: followUp.appAction },
  ]));

  const allSegments = segmentsOf(valid.notes).map((_, index) => index);
  const candidate = (action: string, deadlineAt: string | null): Omit<MeetingActionCandidate, 'candidateId'> => ({
    owner: null, action, deadlineAt, confidence: answered ? 0.8 : 0.6, sourceSegmentIndexes: allSegments,
  });
  const plan = createMeetingPrepProposals(
    context,
    candidate(prepAction, due.at.toISOString()),
    followUps.map(({ followUp, when }) => candidate(followUp.action, when.kind === 'none' ? null : when.dueAt)),
  );

  const items: CaptureProposalContract['items'] = [];
  const commandsByItemId = new Map<string, readonly Command[]>();
  const push = (title: string, item: Omit<CaptureProposalContract['items'][number], 'itemId' | 'title' | 'needsClarification' | 'priority' | 'priorityEstimated'>, when: StepTime) => {
    const itemId = randomUUID();
    items.push({ itemId, title, ...item, needsClarification: false, priority: 'normal', priorityEstimated: true });
    commandsByItemId.set(itemId, commandsFor(title, when, valid.timezone, now));
  };
  // The prep step has one time, the prep instant, and every screen shows it:
  // Review, the confirmation, Today, the Calendar, Details (post-UAT FX1). It
  // used to be *stored* at the meeting's start, so the phone's lead would ring
  // at the prep instant, while Review showed the ring; the lists then drew it
  // at 15:00, inside the meeting it prepares for. It is now a window (ruling
  // R1): `dueAt` the prep instant, `endAt` the meeting's start. The phone rings
  // the opening whatever the lead, and it is late only once the meeting has
  // begun. `schedulePrepAt` keeps the prep instant before the start, so the
  // window is never empty.
  const shownAt = due.at.toISOString();
  // The prep instant is the product's plan for the step, not a reading of an
  // hour in the notes, so it is not marked as a guessed hour (D2).
  // The prep step's title in the app's language only when it is the model's own step, as it wrote it.
  const prepTitle = answered && plan.prep.candidate.action === answered.prep
    ? shownTitle(answered.prep, answered.prepAppAction, valid.locale)
    : plan.prep.candidate.action;
  push(prepTitle, { resolvedTime: shownAt, timeEstimated: false }, {
    kind: 'due_by', dueAt: shownAt, endAt: timing.dueAt.toISOString(), remindAt: ringAt, allDay: false,
  });
  // The short review an hour before (day-before plans only): the same kind
  // of window, done by the start, ringing when the phone can.
  if (sessions.review) {
    const reviewAt = sessions.review.at.toISOString();
    const reviewRing = prepTiming(valid.start, sessions.review.at, now, settings, quietHours).ringAt?.toISOString() ?? null;
    push(reviewTitle(prepTitle, valid.locale), { resolvedTime: reviewAt, timeEstimated: false }, {
      kind: 'due_by', dueAt: reviewAt, endAt: timing.dueAt.toISOString(), remindAt: reviewRing, allDay: false,
    });
  }
  for (const proposal of plan.followUps) {
    const found = whenByKey.get(`${proposal.candidate.action.toLowerCase()}\0${proposal.candidate.deadlineAt ?? ''}`);
    const when = found?.when ?? { kind: 'none' as const };
    const title = shownTitle(proposal.candidate.action, found?.appAction, valid.locale);
    if (when.kind === 'instant') {
      push(title, { resolvedTime: when.dueAt, timeEstimated: found?.hourGuessed === true }, { kind: 'due_by', dueAt: when.dueAt, remindAt: when.dueAt, allDay: false });
    } else if (when.kind === 'day') {
      push(title, { resolvedTime: null, timeEstimated: false, resolvedDate: when.date, dateEstimated: false }, {
        kind: 'due_by', dueAt: when.dueAt, remindAt: null, allDay: true,
      });
    } else {
      push(title, { resolvedTime: null, timeEstimated: false }, { kind: 'unscheduled' });
    }
  }

  const executedEngine: NonNullable<CaptureProposalContract['provenance']>['executedEngine'] = answered
    ? (configuredProviderName() === 'ollama' ? 'ollama' : 'gemini')
    : 'rule-based';
  const contract: CaptureProposalContract = {
    version: CAPTURE_CONTRACT_VERSION,
    proposalId: randomUUID(),
    status: 'proposed',
    items,
    seeds: [],
    provenance: { requestedEngine, executedEngine, fallbackUsed: requestedEngine === 'model' && !answered },
  };

  const store = options.store ?? createStorageCaptureProposalStore(options.storage);
  await store.put({
    contract,
    scopeId: uid,
    commandsByItemId,
    // The server's clock, as capture does it: the confirm's staleness guard
    // measures from here.
    proposedAt: new Date().toISOString(),
  });

  return {
    proposal: contract,
    prep: {
      itemId: items[0]!.itemId,
      remindAt: ringAt,
      silentBecause: ringAt ? null : silenceOf(settings, due.at, timing.dueAt, now),
      dueAt: timing.dueAt.toISOString(),
      leadMinutes: Math.round((valid.start.getTime() - due.at.getTime()) / MINUTE),
      adjustment: due.adjustment,
      startAt: valid.start.toISOString(),
      endAt: valid.end?.toISOString() ?? null,
      timing: sessions.kind,
      sessions: items.slice(0, sessions.review ? 2 : 1).map((item) => ({ itemId: item.itemId, at: item.resolvedTime as string })),
    },
  };
}
