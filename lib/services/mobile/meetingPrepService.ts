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
  type CaptureProposalContract,
} from '../../../src/contracts/v1/captureContracts';
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
import { isInQuietHours, readQuietHours, type QuietHours } from '../../push/quietHours';
import {
  CaptureInputTooLargeError,
  createStorageCaptureProposalStore,
  type CaptureProposalStore,
} from '../captureBoundary';
import type { StorageAdapter } from '../../storage';
import { localDayKey, localMidnightOf, normalizeTimezone } from './time';
import { readReminderSettings } from './reminderSettingsService';
import { instantFromLocal } from '../../../src/extraction/timeLexicon';
import { countTimeExpressions } from '../../../src/extraction/ruleBasedExtractor';

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
}

export interface ValidMeetingPrepInput {
  readonly notes: string;
  readonly start: Date;
  readonly end: Date | null;
  readonly timezone: string;
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
  return { notes, start, end, timezone: normalizeTimezone(input.timezone) };
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

export interface MeetingPrepSummary {
  /** Which item in `proposal.items` is the prep step. Always the first. */
  readonly itemId: string;
  /** When its reminder rings: the chosen prep instant. */
  readonly remindAt: string;
  /**
   * When it is due: one reminder lead after `remindAt`, never after the start,
   * so the phone's own reminder (`dueAt − lead`) rings at `remindAt` (I-1).
   */
  readonly dueAt: string;
  /** Minutes between that and the meeting's start. */
  readonly leadMinutes: number;
  readonly adjustment: PrepAdjustment;
  readonly startAt: string;
  readonly endAt: string | null;
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
  readonly date: string | null;
  readonly time: string | null;
}

interface ModelCandidates {
  readonly prep: string;
  readonly followUps: readonly ModelFollowUp[];
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
  const record = raw as { prepStep?: { action?: unknown }; followUps?: unknown };
  const prep = actionFrom(record.prepStep?.action);
  if (!prep) return null;
  const followUps = (Array.isArray(record.followUps) ? record.followUps : []).flatMap((entry): ModelFollowUp[] => {
    const item = entry as { action?: unknown; deadlineDate?: unknown; deadlineTime?: unknown };
    const action = actionFrom(item?.action);
    if (!action) return [];
    const date = typeof item.deadlineDate === 'string' && LOCAL_DATE.test(item.deadlineDate.trim()) ? item.deadlineDate.trim() : null;
    const time = typeof item.deadlineTime === 'string' && LOCAL_TIME.test(item.deadlineTime.trim()) ? item.deadlineTime.trim() : null;
    return [{ action, date, time }];
  });
  return { prep, followUps };
}

/** When a follow-up is due: an instant, a whole day, or nothing. */
type FollowUpWhen =
  | { readonly kind: 'instant'; readonly dueAt: string }
  | { readonly kind: 'day'; readonly date: string; readonly dueAt: string }
  | { readonly kind: 'none' };

/**
 * A follow-up's day and hour, kept only when they can be believed (M-3).
 *
 * The hour is kept only when the notes write a clock time at all — «يوم الأحد
 * الصبح» names a day and a part of it, and the model filling in 07:00 is a
 * guess the prompt forbids and this enforces. Without an hour the follow-up is
 * an all-day commitment on that day, which is how a day with no chosen hour is
 * stored everywhere else (`TimeSpec.allDay`). A day before the meeting, or
 * beyond the horizon a meeting may be prepared in, is no day at all.
 */
function followUpWhen(followUp: ModelFollowUp, valid: ValidMeetingPrepInput, now: Date, clockWritten: boolean): FollowUpWhen {
  if (!followUp.date) return { kind: 'none' };
  const after = (valid.end ?? valid.start).getTime();
  const horizon = after + MEETING_PREP_MAX_DAYS_AHEAD * 24 * 60 * MINUTE;
  if (followUp.time && clockWritten) {
    const at = instantFromLocal(followUp.date, followUp.time, valid.timezone);
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
  | { readonly kind: 'due_by'; readonly dueAt: string; readonly remindAt: string | null; readonly allDay: boolean }
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
        ? { kind: 'due_by', dueAt: when.dueAt, remindAt: when.remindAt, allDay: when.allDay, timezone }
        : { kind: 'unscheduled', dueAt: null, remindAt: null, timezone },
    },
  }];
}

/**
 * When the prep step is *due*, given when its reminder should ring (I-1).
 *
 * The phone rings for a commitment at `dueAt − softLeadMinutes` and reads
 * nothing else (`mobile/src/features/reminders/reminderInputs.ts`, `startOf`).
 * So the step is due one lead after the chosen prep instant: the phone's own
 * reminder then rings at exactly that instant — the hour before the meeting,
 * already moved out of quiet hours — and the server's `remindAt` agrees with
 * it. Never later than the start: a prep step due after the meeting began
 * would be a step for a meeting that is over, and would sit on Today as not
 * yet late while the meeting is already happening.
 */
export function prepDueAt(start: Date, prepAt: Date, softLeadMinutes: number): Date {
  return new Date(Math.min(start.getTime(), prepAt.getTime() + softLeadMinutes * MINUTE));
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
  const softLeadMinutes = options.softLeadMinutes ?? (await readReminderSettings(uid, storageOption)).softLeadMinutes;
  const due = schedulePrepAt(valid.start, now, quietHours);
  const prepDue = prepDueAt(valid.start, due.at, softLeadMinutes);

  // A clock time anywhere in the notes is what lets a follow-up keep an hour.
  const clockWritten = countTimeExpressions(valid.notes) > 0;
  const followUps = (answered?.followUps ?? []).map((followUp) => ({ followUp, when: followUpWhen(followUp, valid, now, clockWritten) }));
  const whenByKey = new Map(followUps.map(({ followUp, when }) => [
    `${followUp.action.toLowerCase()}\0${when.kind === 'none' ? '' : when.dueAt}`, when,
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
  // The prep step: shown at, and reminded at, the prep instant; due one lead later.
  push(plan.prep.candidate.action, { resolvedTime: due.at.toISOString() }, {
    kind: 'due_by', dueAt: prepDue.toISOString(), remindAt: due.at.toISOString(), allDay: false,
  });
  for (const proposal of plan.followUps) {
    const when = whenByKey.get(`${proposal.candidate.action.toLowerCase()}\0${proposal.candidate.deadlineAt ?? ''}`) ?? { kind: 'none' as const };
    if (when.kind === 'instant') {
      push(proposal.candidate.action, { resolvedTime: when.dueAt }, { kind: 'due_by', dueAt: when.dueAt, remindAt: when.dueAt, allDay: false });
    } else if (when.kind === 'day') {
      push(proposal.candidate.action, { resolvedTime: null, resolvedDate: when.date, dateEstimated: false }, {
        kind: 'due_by', dueAt: when.dueAt, remindAt: null, allDay: true,
      });
    } else {
      push(proposal.candidate.action, { resolvedTime: null }, { kind: 'unscheduled' });
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
      remindAt: due.at.toISOString(),
      dueAt: prepDue.toISOString(),
      leadMinutes: Math.round((valid.start.getTime() - due.at.getTime()) / MINUTE),
      adjustment: due.adjustment,
      startAt: valid.start.toISOString(),
      endAt: valid.end?.toISOString() ?? null,
    },
  };
}
