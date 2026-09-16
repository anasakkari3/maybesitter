import { isLocalMidnight } from '../../../src/domain/stateMachine';
import type { Command, Commitment, DomainState, Priority, Reminder, TimeSpec } from '../../../src/domain/stateMachine';
import { rankForMobile, type RankedItem } from '../../priority/mobileRanking';
import {
  COMMITMENT_CATEGORIES,
  isCommitmentCategory,
  type CommitmentCategory,
  type CommitmentCategorySource,
} from '../../../src/contracts/v1/categoryContracts';
import { resolveModuleRuntime } from '../../../src/contracts/v1/runtimeControls';
import { applyCommand, configureCommandService, getCommandServiceState } from '../commandService';
import { collisionsForCommitment, type CollisionWarning } from '../timeCollision';
import {
  applyParticipantCommand,
  applyParticipantCommandOnce,
  ClientActionIdReusedError,
  commitmentActionReceiptPath,
  getParticipantStateSnapshot,
  type CommitmentActionReceipt,
} from './participantState';
import { getStorage } from '../../storage';
import {
  isPastCommitmentTime,
  pastTimeMessage,
  reminderLeadNoLongerFitsMessage,
} from '../commitments/timeRules';
import {
  addLocalDays,
  isDateOnly,
  localDayKey,
  localDaysBetween,
  normalizeTimezone,
  parseIsoInstant,
  resolvedCommitmentTime,
} from './time';

const HIDDEN_LIST_STATUSES = new Set<Commitment['status']>(['dropped', 'archived']);

export interface CommitmentQueryOptions {
  now?: Date;
  timezone?: string;
  participantId?: string;
}

export interface PatchCommitmentInput {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  /**
   * Which part of life this belongs to (#415).
   *
   * Absent and `null` differ the way they do for the time fields: absent means
   * the edit did not mention the category, `null` means the user cleared it.
   * Both of the present cases are the user speaking, so both are recorded as
   * theirs and neither can be overwritten by a later inference.
   */
  category?: unknown;
  dueDate?: unknown;
  /**
   * When the commitment stops (#185). An instant, or `null` for "no end".
   *
   * Absent and `null` differ here the way they differ for every other time
   * field: absent means the edit did not mention the end, `null` means the user
   * removed it.
   */
  endDate?: unknown;
  /** The commitment names a day, not a time of day (#185). A boolean, or absent. */
  allDay?: unknown;
  reminderTime?: unknown;
}

/**
 * Who is acting, and what they believed they were acting on.
 *
 * `expectedUpdatedAt` is the `If-Match` validator (UC-1.4, #148). Absent, the
 * mutation is unconditional, which is what every client did before this and
 * still does for a first write.
 */
export interface CommitmentMutationOptions {
  participantId?: string;
  /** The `If-Match` validator the caller sent back, if any. */
  expectedValidator?: string;
}

/**
 * Time order, which is what a list is when ranking is off.
 *
 * An undated commitment sorts last rather than by `updatedAt`. It could not
 * reach this function at all until #384 — Today filtered undated items out and
 * Upcoming still does — and `updatedAt` would have put "Buy milk" above a
 * commitment due this afternoon purely because it was saved earlier, which is
 * not a time order, it is a creation order wearing one. Last is also where the
 * ranked path puts it, so turning the flag off no longer moves it.
 *
 * Dated items keep the exact comparison they have always had, including
 * returning 0 on a tie: `MAYBESITTER_FEATURE_PRIORITY=false` promises
 * byte-identical output to the order that preceded ranking.
 *
 * What a tie resolves to is **not decided here**, and this deliberately does
 * not claim to decide it. `Array.prototype.sort` is stable, so tied items keep
 * the order `Object.values(state.commitments)` gave them — and every
 * authenticated path builds that state from `participantState`, which lists one
 * document per commitment and returns them by id. So the tie order is the
 * storage layer's, it is the same on every read, and a tie-break added here
 * would be unreachable code asserting a promise this module does not own.
 * `tests/mobile/listBoundaryRule.test.ts` asserts the observable half: the same
 * two commitments come back in the same order however they were written.
 */
function sortByResolvedTime(items: Commitment[]): Commitment[] {
  return [...items].sort((a, b) => {
    const aTime = instantForOrder(a);
    const bTime = instantForOrder(b);
    if (aTime === bTime) return 0;
    return aTime < bTime ? -1 : 1;
  });
}

/** Undated is `Infinity`, so it sorts after everything with a time. */
function instantForOrder(commitment: Commitment): number {
  const resolved = resolvedCommitmentTime(commitment);
  return resolved ? Date.parse(resolved) : Number.POSITIVE_INFINITY;
}

function isVisibleInLists(commitment: Commitment): boolean {
  return !HIDDEN_LIST_STATUSES.has(commitment.status);
}

/**
 * Ranked order, or the time order the lists have always used (UC-2.8, #169).
 *
 * The flag decides, per request, so turning ranking off is a config change and
 * not a deploy — and `MAYBESITTER_FEATURE_PRIORITY=false` gives byte-identical
 * output to the sort this function replaces, which a test asserts.
 */
function orderForLists(
  commitments: Commitment[],
  reminders: readonly Reminder[],
  now: Date,
): { items: Commitment[]; ranking: Map<string, RankedItem> } {
  if (resolveModuleRuntime('priority').mode !== 'enabled') {
    return { items: sortByResolvedTime(commitments), ranking: new Map() };
  }
  const ranked = rankForMobile(commitments, reminders, now.toISOString());
  const ranking = new Map(ranked.map((entry) => [entry.commitmentId, entry]));
  const byId = new Map(commitments.map((commitment) => [commitment.id, commitment]));
  return {
    items: ranked.map((entry) => byId.get(entry.commitmentId)!).filter(Boolean),
    ranking,
  };
}

/** Async since UC-1.0b (#141): a participant's state is a storage read. */
async function stateFor(options: { participantId?: string } = {}): Promise<DomainState> {
  if (options.participantId) return getParticipantStateSnapshot(options.participantId);
  configureCommandService({});
  return getCommandServiceState();
}

/** The commitments and their ranking, so a route can send both. */
export interface RankedCommitments {
  items: Commitment[];
  ranking: Map<string, RankedItem>;
  /**
   * Every commitment in the account that may still own a calendar event (#185).
   *
   * Not "the ones in this list". The lists are a window — Today and Upcoming
   * together hold every live commitment, but a *settled* one drops out of both
   * the day after it happened — and the calendar sync needs to tell the two
   * reasons a commitment stopped appearing apart. Something finished last week
   * keeps its entry, because the calendar is a record of the week the user
   * lived. Something they cancelled must lose it.
   *
   * So this is the id set the whole account still holds, and a stored link whose
   * commitment id is missing from it names an event with nothing left behind it.
   * Computed from the same state read the list was built from, so the two
   * answers cannot disagree about a commitment that changed between them.
   */
  calendarEligibleIds: Set<string>;
}

/**
 * The statuses in which a commitment has no business being in a calendar (#185).
 *
 * Deliberately its own set rather than `HIDDEN_LIST_STATUSES`, which today
 * holds the same two names. They mean different things: one decides what a
 * screen draws, and the other decides whether an entry is deleted out of
 * somebody's calendar. Sharing the constant would mean a later decision to hide
 * one more status from a list silently reached into everyone's calendar and
 * removed those events.
 */
const CALENDAR_GONE_STATUSES = new Set<Commitment['status']>(['dropped', 'archived']);

function calendarEligibleIdsOf(state: DomainState): Set<string> {
  const ids = new Set<string>();
  for (const commitment of Object.values(state.commitments)) {
    if (!CALENDAR_GONE_STATUSES.has(commitment.status)) ids.add(commitment.id);
  }
  return ids;
}

/**
 * The statuses a commitment can still be acted on in.
 *
 * Not a list this module invents: it is `stateMachine.ts`'s own, the exact
 * triple every action command guards on with `ensureCommitmentStatus` —
 * Acknowledge, Complete, Postpone, Drop, and the reminder commands all name
 * `['active', 'deferred', 'missed']`. If the user can still do something to it,
 * it is live, and live work rolls forward.
 */
const LIVE_STATUSES = new Set<Commitment['status']>(['active', 'deferred', 'missed']);

function isLive(commitment: Commitment): boolean {
  return LIVE_STATUSES.has(commitment.status);
}

/**
 * The local day a commitment belongs to, or `null` when it names no day.
 *
 * A live commitment is on the day it is *for*: `postponedUntil`, else the
 * reminder, else the due date. Something settled is on the day it *happened* —
 * `completedAt` — because that is the day the user lived, and it is what the
 * Finished group on Today exists to draw. A settled commitment with neither
 * falls back to the day it was last touched, so it is still on exactly one day
 * rather than on none.
 */
function dayOf(commitment: Commitment, timezone: string): string | null {
  if (isLive(commitment)) {
    const resolved = resolvedCommitmentTime(commitment);
    return resolved ? localDayKey(resolved, timezone) : null;
  }
  const settled = commitment.completedAt ?? resolvedCommitmentTime(commitment) ?? commitment.updatedAt;
  return settled ? localDayKey(settled, timezone) : null;
}

/** Which list a commitment is on, or `null` for neither. */
type ListPlacement = 'today' | 'upcoming' | null;

/**
 * **Live work that is not on a later day belongs to Today.**
 *
 * One function, so a commitment is on at most one list because a function
 * returns one value — not because two predicates were written to negate each
 * other and were both kept correct. Both lists are this function read twice
 * (#383, #384).
 *
 * ── The partition holds within one request, and only there ───────
 *
 * Today and Upcoming are two GETs, and each resolves its own `now` unless the
 * client sends `referenceTime`. A pair of calls that straddles local midnight
 * therefore asks two different questions: a tomorrow-dated commitment answered
 * by Today just before midnight and by Upcoming just after is on neither list
 * across that pair, and the reverse order puts it on both. That is a property
 * of the two requests, not of this function, and it predates #383 — the fix is
 * one `referenceTime` sent across the pair, which is the client's to make. It
 * is written down here so the claim above is not read as more than it is.
 *
 * ── The two gaps this closes ─────────────────────────────────────
 *
 *   #383 — Today kept `=== today` and Upcoming kept `> today`, so a commitment
 *          dated *yesterday* matched neither. A device run watched seven of
 *          them vanish at midnight. They existed on the server the whole time;
 *          no list admitted them.
 *   #384 — an *undated* commitment reached Today only when the `priority`
 *          module runtime was enabled. Staging's is not, and neither is the
 *          default, so the comment that stood here — hiding it "meant 'Buy
 *          milk' never reached a phone at all (#169)" — described the live
 *          behaviour rather than the history it recounted. Where a commitment
 *          lives is not a property of the ranking module: a flag that decides
 *          the *order* of a list must not decide its *membership*.
 *
 * ── Why only live work rolls forward ─────────────────────────────
 *
 * "Not on a later day" applied to everything visible would turn #383's
 * vanishing bug into an accumulating one on the same screen. `completed` is
 * terminal — no command in `stateMachine.ts` reaches `archived`, so nothing
 * ever leaves it — and the list route has no cap, so Today would grow by one
 * row for every commitment the user has ever finished, for ever, with the
 * Finished badge counting a lifetime instead of a day. Worse for the rest:
 * `model.ts` draws `missed` and anything it has no mapping for as a live card,
 * so a year-old abandoned draft would sit in Must for ever.
 *
 * So a settled commitment is on its own day and no other: finished today, on
 * today's Finished group; finished last March, gone tomorrow. The invariant
 * this implements says *active* work is never invisible, and that is what
 * rolls forward.
 *
 * Unconfirmed captures — `draft`, `needs_clarification`, `pending_confirmation`
 * — deliberately do not roll forward either. They keep exactly the behaviour
 * they had before this change: on Today on their stated day, on Upcoming on a
 * later one. Nothing was ever committed to, so surfacing a week-old capture as
 * a live card is the same accumulating bug wearing a different status, and
 * whether it should happen is a product question nobody has been asked.
 *
 * ── The same rule the planner applies, and where it is not ───────
 *
 * `buildDailyPlan` decided the day comparison first (#194, merged):
 * `rollsIntoDay` calls an instant behind the day being planned yesterday's work
 * and rolls it forward. `localDayKey(day) < today` here and `rollsIntoDay`
 * there are two spellings of one comparison, asked the same question at the
 * millisecond the day turns in `tests/mobile/listBoundaryRule.test.ts`.
 *
 * The two rules are *not* identical on every axis, and the test file names each
 * difference rather than letting it be discovered later:
 *
 *   - membership: the planner's `isPlannable` is `active || deferred`. It is a
 *     subset of `LIVE_STATUSES`, which is the direction that matters — nothing
 *     can be in the plan and missing from Today. The single difference is
 *     `missed`, which no command in the state machine assigns.
 *   - undated items: every undated live commitment is on Today, while the
 *     planner's `belongsToDay` admits an undated commitment only when
 *     `priority.level !== 'low'`. A low-importance undated commitment is
 *     therefore on Today and not in the plan. That is the planner's deliberate
 *     choice — a plan is what realistically fits — and a list is not a plan.
 *
 * This is not a "missed" or "overdue" state. It is yesterday's work, on today's
 * list, until the user acts on it.
 */
function placeInList(commitment: Commitment, today: string, timezone: string): ListPlacement {
  // Dropped on purpose or archived: the user closed it, and closing it is a
  // first-class outcome in this product rather than a gap in the lists.
  if (!isVisibleInLists(commitment)) return null;
  const day = dayOf(commitment, timezone);

  if (isLive(commitment)) {
    // No day at all is not a later day, so it stays here (#384). Ranking puts
    // it after the dated items it ties with, saying `no_deadline`, and
    // `sortByResolvedTime` puts it in the same place when ranking is off.
    if (day === null) return 'today';
    // A day behind today rolls into today (#383).
    return day <= today ? 'today' : 'upcoming';
  }

  if (day === null) return null;
  if (day === today) return 'today';
  // A capture still waiting to be confirmed, stated for a later day.
  return day > today ? 'upcoming' : null;
}

export async function listTodayRanked(options: CommitmentQueryOptions = {}): Promise<RankedCommitments> {
  const now = options.now ?? new Date();
  const timezone = normalizeTimezone(options.timezone);
  const today = localDayKey(now, timezone);
  const state = await stateFor(options);
  const items = Object.values(state.commitments)
    .filter((commitment) => placeInList(commitment, today, timezone) === 'today');
  return {
    ...orderForLists(items, Object.values(state.reminders), now),
    calendarEligibleIds: calendarEligibleIdsOf(state),
  };
}

export async function listToday(options: CommitmentQueryOptions = {}): Promise<Commitment[]> {
  return (await listTodayRanked(options)).items;
}

export async function listUpcomingRanked(options: CommitmentQueryOptions = {}): Promise<RankedCommitments> {
  const now = options.now ?? new Date();
  const timezone = normalizeTimezone(options.timezone);
  const today = localDayKey(now, timezone);
  const state = await stateFor(options);
  const items = Object.values(state.commitments)
    .filter((commitment) => placeInList(commitment, today, timezone) === 'upcoming');
  return {
    ...orderForLists(items, Object.values(state.reminders), now),
    calendarEligibleIds: calendarEligibleIdsOf(state),
  };
}

export async function listUpcoming(options: CommitmentQueryOptions = {}): Promise<Commitment[]> {
  return (await listUpcomingRanked(options)).items;
}

export async function getCommitment(id: string, options: { participantId?: string } = {}): Promise<Commitment | null> {
  return (await stateFor(options)).commitments[id] ?? null;
}

function priorityFromMobile(value: unknown): Partial<Priority> | undefined {
  if (value === undefined) return undefined;
  if (value !== 'low' && value !== 'normal' && value !== 'high') {
    throw new Error('priority must be low, normal, or high');
  }
  return {
    level: value,
    source: 'user_explicit',
    pressureAllowed: false,
    pressureLevel: 'none',
  };
}

/**
 * One client-supplied time field: an instant, or `null` for "no time".
 *
 * `null` and absent are not the same answer. Absent means the edit did not
 * touch the time; `null` means the user removed it (UC-2.R3, #173), which is a
 * choice `applyEdits.ts` has always allowed on the capture path and which a
 * commitment that already exists had no way to express. `null` is not a time,
 * so the clock has nothing to say about it.
 *
 * A time that *is* supplied goes through the same past-time rule the capture
 * path enforces (#352). This used to take no clock at all, which is how the
 * boundary came to accept a `dueDate` the edit sheet and the capture path both
 * refused: a reminder behind the clock is one that will never fire.
 */
function optionalInstant(value: unknown, field: string, now: Date): string | null {
  if (value === null) return null;
  // A bare `YYYY-MM-DD` is refused for being a date, and not for whatever the
  // hour it would have been given turns out to mean (#352).
  //
  // `parseIsoInstant` resolves one to UTC midnight, so today's date arrived
  // here already behind the clock and was answered "must not be in the past" —
  // a true sentence about a fabricated instant, and a baffling one to read
  // about today. A *future* bare date was worse, because it was accepted: it
  // stored 00:00Z, which is 03:00 for this product's default Asia/Jerusalem
  // user, so a reminder fired at three in the morning on a day whose hour
  // nobody had chosen. Both halves are the same mistake — a value with no hour
  // being given one — and neither is a thing to guess at.
  //
  // This is a rule about the shape of a client field, so the shape test lives
  // in `time.ts` and the refusal here, rather than in `timeRules.ts` next to
  // the past-time rule. `validateEdit` asks the same question of a capture
  // edit's `resolvedTime` now (#375) and answers it in its own vocabulary; the
  // note that once stood here, saying the capture path could not reach a bare
  // date, was true of the app's own screens and not of its boundary.
  if (isDateOnly(value)) throw new Error(`${field} must name a time of day, not only a date`);
  const parsed = parseIsoInstant(value, field);
  if (isPastCommitmentTime(parsed, now)) throw new Error(pastTimeMessage(field));
  return parsed.toISOString();
}

/**
 * `now` is the request's clock, not this function's own.
 *
 * It judges only the fields the patch supplies. The commitment's existing time
 * is never re-judged: there is no "overdue" in this product, and an item whose
 * hour has gone must stay editable, or a typo in yesterday's title could never
 * be fixed.
 *
 * -- The derived reminder is judged too (#375) --------------------
 *
 * The `remindAt` derived below from a preserved lead is written by this patch,
 * at this clock, so it faces the same rule as one a client sends. Move a due
 * date to an hour from now on an item whose reminder ran two hours ahead of it
 * and the derived reminder is an hour behind the clock — exactly the
 * reminder-that-never-fires this function refuses when asked for it directly,
 * arriving through the other door.
 *
 * #375 chose refusal over the alternatives. Clamping the lead to `now` and
 * dropping the reminder are both silent rewrites of a time the user chose: the
 * edit sheet would go on showing a lead the server had quietly moved or
 * deleted, and they would find out when the reminder came at the wrong hour or
 * never came at all. A refusal costs one more tap and is the only outcome they
 * can act on, so it names what collided and what to do about it.
 *
 * It refuses the whole patch, not only the time. The due date in the same
 * request is fine on its own, but storing it alone would leave the commitment
 * moved with a reminder the user still believes tracks it — the silent
 * half-write this function exists to prevent.
 */
function patchTimeSpec(current: TimeSpec, input: PatchCommitmentInput, now: Date): Partial<TimeSpec> | undefined {
  const hasDueDate = input.dueDate !== undefined;
  const hasReminderTime = input.reminderTime !== undefined;
  const hasEndDate = input.endDate !== undefined;
  const hasAllDay = input.allDay !== undefined;
  if (!hasDueDate && !hasReminderTime && !hasEndDate && !hasAllDay) return undefined;

  const dueAt = hasDueDate ? optionalInstant(input.dueDate, 'dueDate', now) : current.dueAt;
  let remindAt: string | null;
  if (hasReminderTime) {
    remindAt = optionalInstant(input.reminderTime, 'reminderTime', now);
  } else if (hasDueDate && current.dueAt && current.remindAt && dueAt) {
    // Keep the gap the user chose rather than collapsing the reminder onto the
    // new due date or stranding it at the old one.
    const lead = Date.parse(current.dueAt) - Date.parse(current.remindAt);
    const derived = new Date(Date.parse(dueAt) - lead);
    // The one comparison, asked about a value this patch produced rather than
    // one it was handed. `isPastCommitmentTime` rather than a second `<` here,
    // so the derived reminder can never end up a millisecond stricter or looser
    // than a supplied one (#352, #375).
    if (isPastCommitmentTime(derived, now)) throw new Error(reminderLeadNoLongerFitsMessage('dueDate'));
    remindAt = derived.toISOString();
  } else if (hasDueDate && !current.remindAt) {
    remindAt = null;
  } else {
    remindAt = current.remindAt;
  }

  // Decided before the end, because an all-day span's length is a count of days
  // and a meeting's is a count of minutes, and only this says which it is.
  const allDay = patchedAllDay(current, input, dueAt, hasAllDay);

  return {
    kind: dueAt || remindAt ? 'due_by' : 'unscheduled',
    dueAt,
    endAt: patchedEndAt(current, input, dueAt, hasEndDate, allDay),
    remindAt,
    allDay,
    timezone: current.timezone,
  } as Partial<TimeSpec>;
}

/**
 * The end of the commitment after this patch (#185).
 *
 * ── A move carries the length, the way it carries the reminder lead ──
 *
 * A patch that supplies only `dueDate` is a *move*: the user dragged the thing
 * to another hour, and they did not shorten it. `remindAt` already survives a
 * move by keeping the lead the user chose (#134); an end that did not survive
 * the same way would mean every reschedule of a two-hour meeting silently made
 * it a point in time — and on a device calendar that is a two-hour event
 * collapsing to the default block, visible to anybody who shares the calendar.
 *
 * So the *duration* is preserved, not the instant. The reminder keeps a lead
 * measured backwards from the due time and the end keeps a length measured
 * forwards from it, which is the same arithmetic from the same anchor.
 *
 * ── Clearing the time clears the end ─────────────────────────────
 *
 * `dueDate: null` is "this has no time". An `endAt` left standing after it
 * would be an end with no start, which `defaultTimeSpec` refuses outright — so
 * the choice here is between answering at the boundary with a 400 nobody can
 * act on, and doing the only thing the user's sentence can mean. It means the
 * end is gone too.
 *
 * ── The end is never judged against the clock ────────────────────
 *
 * `optionalInstant` refuses a supplied time behind `now` (#352), and an end is
 * the one time field where that rule would be wrong. An event that started an
 * hour ago and runs for another hour has an end in the future; one that ran
 * this morning has an end in the past and is still a true record of a meeting
 * that happened. What must hold is that it is after its own start, which is
 * `defaultTimeSpec`'s invariant and is checked there for every producer rather
 * than here for one of them. The *date-only* half of `optionalInstant` still
 * applies, so `endDate` cannot be a bare `YYYY-MM-DD` given a fabricated hour.
 */
function patchedEndAt(
  current: TimeSpec,
  input: PatchCommitmentInput,
  dueAt: string | null,
  hasEndDate: boolean,
  allDay: boolean,
): string | null {
  if (hasEndDate) {
    if (input.endDate === null) return null;
    if (isDateOnly(input.endDate)) throw new Error('endDate must name a time of day, not only a date');
    const parsed = parseIsoInstant(input.endDate, 'endDate').toISOString();
    if (!dueAt) throw new Error('endDate requires a due date on the commitment');
    // `<=`, not `<`. An end exactly on its start is a zero-length range, which
    // is the empty set — and answering it here rather than letting
    // `defaultTimeSpec` refuse it further down means the message names the
    // field the request actually sent.
    if (Date.parse(parsed) <= Date.parse(dueAt)) throw new Error('endDate must be after the due date');
    return parsed;
  }

  // Nothing to carry, or nowhere to carry it to. `!current.dueAt` is the case
  // `defaultTimeSpec` refuses to store and this function can still be handed:
  // an end with no start is half a record, and pinning it to a *new* due date
  // would assemble a range out of two facts that were never about each other —
  // possibly one that ends before it begins.
  if (!dueAt || !current.endAt || !current.dueAt) return null;

  if (allDay) {
    // A span of days is a count of days. Carrying it in milliseconds meant a
    // two-day block moved across the night a zone puts its clocks back landed
    // an hour short of midnight — no longer a day boundary at all — and drew
    // one day fewer than it had.
    return addLocalDays(dueAt, localDaysBetween(current.dueAt, current.endAt, current.timezone), current.timezone);
  }

  // A meeting is a number of minutes, on any day of the year. This is the same
  // arithmetic from the same anchor as the reminder lead above, in the other
  // direction.
  const length = Date.parse(current.endAt) - Date.parse(current.dueAt);
  return new Date(Date.parse(dueAt) + length).toISOString();
}

/**
 * Whether the commitment still names a day rather than an hour (#185).
 *
 * The flag is a claim about `dueAt`, so it cannot outlive one. Clearing the
 * time turns it off for the same reason it clears the end: `defaultTimeSpec`
 * refuses an all-day commitment on no day, and the only thing "this has no
 * time" can mean is that the day went with it.
 */
function patchedAllDay(
  current: TimeSpec,
  input: PatchCommitmentInput,
  dueAt: string | null,
  hasAllDay: boolean,
): boolean {
  if (!dueAt) return false;
  if (hasAllDay) {
    if (typeof input.allDay !== 'boolean') throw new Error('allDay must be a boolean');
    return input.allDay;
  }
  if (!current.allDay) return false;
  // The patch did not mention the flag, so the value decides. `optionalInstant`
  // refuses a bare `YYYY-MM-DD` (#352), so every due date that gets this far
  // names a time of day — the question is whether it is still the midnight the
  // flag is a claim *about*. Move an all-day commitment to another day and it
  // is; set it to half past six and the user has just chosen the hour the flag
  // says nobody chose, through the only API that can choose one. Keeping the
  // flag then threw their choice away silently, because the mapper reads
  // `allDay` first and draws a day.
  return isLocalMidnight(dueAt, current.timezone);
}

export const patchTimeSpecForTest = patchTimeSpec;

/**
 * The category half of a patch, or nothing at all (#415).
 *
 * Returns an empty object when the edit did not mention the category, so the
 * key never reaches the command — the state machine reads `undefined` as "do
 * not touch it", and a key present with an undefined value would be
 * indistinguishable from the user clearing it.
 *
 * `categorySource` is stated rather than left to default: this request came
 * from a person tapping a chip, and saying so here means the state machine's
 * refusal rule has something to refuse *against* when a background
 * re-classification arrives later.
 */
function categoryPatchFrom(
  value: unknown,
): { category?: CommitmentCategory | null; categorySource?: CommitmentCategorySource } {
  if (value === undefined) return {};
  if (value === null) return { category: null, categorySource: 'user_explicit' };
  if (!isCommitmentCategory(value)) {
    throw new Error(`category must be one of ${COMMITMENT_CATEGORIES.join(', ')}, or null`);
  }
  return { category: value, categorySource: 'user_explicit' };
}

function stringField(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

export async function patchCommitment(
  id: string,
  input: PatchCommitmentInput,
  now: Date = new Date(),
  options: CommitmentMutationOptions = {},
): Promise<Commitment> {
  const current = await getCommitment(id, options);
  if (!current) throw new Error('Commitment not found');

  const updates: Extract<Command, { type: 'UpdateCommitment' }>['updates'] = {
    title: stringField(input.title, 'title'),
    description: stringField(input.description, 'description'),
    priority: priorityFromMobile(input.priority),
    // Spread rather than assigned, because `undefined` and `null` mean
    // different things to the state machine and writing `category: undefined`
    // would put the key there (#415).
    ...categoryPatchFrom(input.category),
    timeSpec: patchTimeSpec(current.timeSpec, input, now),
  };

  const command: Command = {
    type: 'UpdateCommitment',
    commitmentId: id,
    now: now.toISOString(),
    updates,
  };
  await applyCommitmentCommand(id, command, options, 'Could not update commitment');
  return (await getCommitment(id, options)) ?? current;
}

/**
 * What a commitment now lands on top of, read from the same state an edit just
 * wrote (#football-fixtures, final review C2). The edit route returns it with
 * the updated commitment, so moving "call the dentist" onto Saturday's match
 * is warned about exactly the way capturing it there is.
 */
export async function collisionsForExistingCommitment(
  id: string,
  options: { participantId?: string } = {},
): Promise<readonly CollisionWarning[]> {
  const state = await stateFor(options);
  return collisionsForCommitment(state.commitments[id], Object.values(state.commitments));
}

/**
 * The state machine refused the move: completing a completed commitment,
 * postponing a dropped one. The route answers 409 rather than pretending it
 * worked (#148).
 */
export class InvalidTransitionError extends Error {
  constructor() {
    super('invalid_transition');
    this.name = 'InvalidTransitionError';
  }
}

/**
 * One command against one commitment, with the caller's `If-Match` expectation
 * carried into the same transaction that writes.
 */
async function applyCommitmentCommand(
  id: string,
  command: Command,
  options: CommitmentMutationOptions,
  rejection: string,
): Promise<void> {
  if (!options.participantId && options.expectedValidator !== undefined) {
    // The in-process path has no transaction to check inside, so honouring an
    // If-Match there would be a claim this cannot keep. Every authenticated
    // route supplies a participant; this only fires for a caller that does not.
    throw new Error('If-Match requires an authenticated participant');
  }
  const result = options.participantId
    ? await applyParticipantCommand(
        options.participantId,
        command,
        options.expectedValidator === undefined
          ? undefined
          : { commitmentId: id, validator: options.expectedValidator },
      )
    : applyCommand(command);
  if (result.result === 'rejected') throw new Error(rejection);
  if (result.result === 'invalid_transition') throw new InvalidTransitionError();
}

export async function completeCommitment(
  id: string,
  now: Date = new Date(),
  options: CommitmentMutationOptions = {},
): Promise<Commitment> {
  const command: Command = { type: 'Complete', commitmentId: id, now: now.toISOString() };
  await applyCommitmentCommand(id, command, options, 'Could not complete commitment');
  const commitment = await getCommitment(id, options);
  if (!commitment) throw new Error('Commitment not found');
  return commitment;
}

export async function postponeCommitment(
  id: string,
  postponedUntil: unknown,
  now: Date = new Date(),
  options: CommitmentMutationOptions = {},
): Promise<Commitment> {
  const parsed = parseIsoInstant(postponedUntil, 'postponedUntil');
  if (parsed.getTime() <= now.getTime()) throw new Error('postponedUntil must be after now');
  const command: Command = {
    type: 'Postpone',
    commitmentId: id,
    postponedUntil: parsed.toISOString(),
    now: now.toISOString(),
  };
  await applyCommitmentCommand(id, command, options, 'Could not postpone commitment');
  const commitment = await getCommitment(id, options);
  if (!commitment) throw new Error('Commitment not found');
  return commitment;
}

export async function dropCommitment(
  id: string,
  now: Date = new Date(),
  options: CommitmentMutationOptions = {},
): Promise<Commitment> {
  const command: Command = { type: 'Drop', commitmentId: id, now: now.toISOString() };
  await applyCommitmentCommand(id, command, options, 'Could not delete commitment');
  const commitment = await getCommitment(id, options);
  if (!commitment) throw new Error('Commitment not found');
  return commitment;
}

export type CommitmentActionName = 'complete' | 'postpone' | 'cancel' | 'aware';

/** The notification's Later default (mobile `DEFAULT_DEFER_MS`), applied to a late-arriving tap. */
export const LATE_TAP_DEFER_MS = 60 * 60 * 1000;

/**
 * One notification-button tap, or one in-app action, applied to a commitment
 * (UC-3.14, #200).
 *
 * With a `clientActionId` it is applied at most once: the receipt is created
 * in the transaction that writes the domain event, and a second delivery
 * answers `replayed: true` with the commitment as it now is. The receipt is
 * looked up *before* `postponedUntil` is validated, because a defer tapped
 * offline and delivered two hours later names an instant that is now in the
 * past — and that delivery's answer is "already done", not "invalid".
 */
export async function applyCommitmentAction(
  id: string,
  action: CommitmentActionName,
  input: {
    postponedUntil?: unknown;
    now?: Date;
    clientActionId?: string;
    participantId: string;
    expectedValidator?: string;
  },
): Promise<{ commitment: Commitment; replayed: boolean }> {
  const now = input.now ?? new Date();
  const scope: CommitmentMutationOptions = {
    participantId: input.participantId,
    expectedValidator: input.expectedValidator,
  };
  if (input.clientActionId === undefined) {
    const commitment = action === 'complete'
      ? await completeCommitment(id, now, scope)
      : action === 'postpone'
        ? await postponeCommitment(id, input.postponedUntil, now, scope)
        : action === 'cancel'
          ? await dropCommitment(id, now, scope)
          : await acknowledgeReminder(id, now, scope);
    return { commitment, replayed: false };
  }

  const fingerprint = `${action}|${typeof input.postponedUntil === 'string' ? input.postponedUntil : ''}`;
  const receipt = await getStorage().get<CommitmentActionReceipt>(
    commitmentActionReceiptPath(input.participantId, input.clientActionId),
  );
  let replayed = false;
  if (receipt) {
    if (receipt.fingerprint !== fingerprint || receipt.commitmentId !== id) throw new ClientActionIdReusedError();
    replayed = true;
  } else {
    const command = commandFor(id, action, input.postponedUntil, now, true);
    const precondition = input.expectedValidator === undefined
      ? undefined
      : { commitmentId: id, validator: input.expectedValidator };
    const outcome = await applyParticipantCommandOnce(
      input.participantId, input.clientActionId, fingerprint, command, precondition,
    );
    if (outcome.result === 'replayed') replayed = true;
    else if (outcome.result === 'rejected') {
      throw new Error(outcome.newState.commitments[id] ? `Could not ${action} commitment` : 'Commitment not found');
    }
    else if (outcome.result === 'invalid_transition') throw new InvalidTransitionError();
  }
  const commitment = await getCommitment(id, scope);
  if (!commitment) throw new Error('Commitment not found');
  return { commitment, replayed };
}

function commandFor(
  id: string,
  action: CommitmentActionName,
  postponedUntil: unknown,
  now: Date,
  fromOutbox = false,
): Command & { commitmentId: string } {
  if (action === 'complete') return { type: 'Complete', commitmentId: id, now: now.toISOString() };
  if (action === 'cancel') return { type: 'Drop', commitmentId: id, now: now.toISOString() };
  if (action === 'aware') return { type: 'MarkAware', commitmentId: id, now: now.toISOString(), source: 'reminder' };
  let parsed = parseIsoInstant(postponedUntil, 'postponedUntil');
  if (parsed.getTime() <= now.getTime()) {
    // A Later pressed offline and delivered after its own instant (#200). The
    // person asked for "later", not for nothing: defer from now by the button's
    // default rather than refusing a tap the outbox would then drop.
    if (!fromOutbox) throw new Error('postponedUntil must be after now');
    parsed = new Date(now.getTime() + LATE_TAP_DEFER_MS);
  }
  return { type: 'Postpone', commitmentId: id, postponedUntil: parsed.toISOString(), now: now.toISOString() };
}

/** A tap on a reminder: the commitment is known about, and that is recorded (#200). */
export async function acknowledgeReminder(
  id: string,
  now: Date = new Date(),
  options: CommitmentMutationOptions = {},
): Promise<Commitment> {
  const command: Command = { type: 'MarkAware', commitmentId: id, now: now.toISOString(), source: 'reminder' };
  await applyCommitmentCommand(id, command, options, 'Commitment not found');
  const commitment = await getCommitment(id, options);
  if (!commitment) throw new Error('Commitment not found');
  return commitment;
}
