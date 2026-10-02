/**
 * Fixed-time events and the next step (black-box audit 2026-10-03, #2).
 *
 * «عندي امتحان رياضيات بكرا الساعة 10» was offered as «خطوتك التالية» with
 * «بلّش فيها» the day before; «سهرة مع الصحاب الليلة 21:00» then took the
 * card nine hours before it started, with nothing said about the exam the
 * next morning. Both are `scheduled_event`s: things that happen at their
 * time, not work that can be started now. Three rules, all from the person's
 * own commitments and nothing else:
 *
 *  1. **A timed event is not a step until it is close.** It is a candidate
 *     only from `FIXED_EVENT_LEAD_MS` before its start, and then it carries
 *     `starts_soon` — "coming up", which is something to act on (leave, get
 *     ready). Before that it stays on Today, in its group, at its hour; it is
 *     just not «بلّش فيها». After its start nothing changes: an event whose
 *     time has come is what it always was to the selector.
 *
 *  2. **An important event with nothing planned for it gets a preparation
 *     step.** "Important" is narrow on purpose: the title names an exam, an
 *     interview or a presentation (`PREPARATION_NOUNS`). Within
 *     `PREPARATION_HORIZON_MS`, at least `PREPARATION_MIN_LEAD_MS` ahead, and
 *     with no preparation already on the person's list, the step is
 *     «حضّر لامتحان رياضيات»: something that can be started now. It points at
 *     the event's own commitment, so tapping it opens the event (and its
 *     «حضّرني»); `done` and `edit` are not offered, because either would act
 *     on the event itself — completing the exam, or renaming it.
 *
 *  3. **An evening plan before that event is named, as a question.** When a
 *     fixed event sits in the evening or night before it, the step says so —
 *     «عندك "سهرة مع الصحاب" الساعة 21:00 قبله — بدك تحضّر قبلها؟» — and
 *     nothing more. No verdict on going out: the person may already be ready.
 *
 * Kept outside `lib/recommendation/**` (the locked shadow selector): this is
 * route-facing, called by `getLiveNextStep`.
 */
import type { Commitment, DomainState } from '../../src/domain/stateMachine';
import type { NextStepEvidenceContract, NextStepLocale } from '../../src/contracts/v1/nextStepContracts';
import { mentionsPreparedEvent, namesEvent, namesPreparedEvent, wordsOf } from '../../src/extraction/lexicon/eventTitles';

export { mentionsPreparedEvent, namesEvent, namesPreparedEvent, wordsOf };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How long before its start a timed event becomes a candidate ("coming up"). */
export const FIXED_EVENT_LEAD_MS = 60 * MINUTE;
/** How far ahead an important event earns a preparation step. */
export const PREPARATION_HORIZON_MS = 48 * HOUR;
/** Closer than this, preparing is over: the event itself is the step. */
export const PREPARATION_MIN_LEAD_MS = FIXED_EVENT_LEAD_MS;
/** How long before the event an evening plan counts as "the night before". */
const EVENING_WINDOW_MS = 24 * HOUR;

const OPEN: ReadonlySet<Commitment['status']> = new Set<Commitment['status']>(['active', 'deferred']);
const GONE: ReadonlySet<Commitment['status']> = new Set<Commitment['status']>(['dropped', 'archived', 'draft', 'needs_clarification', 'pending_confirmation']);

function startOf(commitment: Commitment): number | null {
  const raw = commitment.timeSpec.dueAt;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A `scheduled_event` with an hour somebody chose, whose title names an event
 * (`namesEvent`): «امتحان رياضيات», «سهرة مع الصحاب», «موعد دكتور». A task
 * given an hour — «أحضّر الغداء الساعة 2», "send the report at 3pm" — is a
 * `scheduled_event` too, and stays an ordinary candidate.
 */
export function isTimedFixedEvent(commitment: Commitment): boolean {
  return commitment.timeSpec.kind === 'scheduled_event' && !commitment.timeSpec.allDay && startOf(commitment) !== null
    && namesEvent(commitment.title);
}

/** Rule 1: a timed event more than `FIXED_EVENT_LEAD_MS` away is not a step yet. */
export function notStartableYet(commitment: Commitment, now: Date): boolean {
  const start = startOf(commitment);
  return isTimedFixedEvent(commitment) && start !== null && start - now.getTime() > FIXED_EVENT_LEAD_MS;
}

/** Rule 1's other half: a timed event inside its lead window, not yet started. */
export function startsSoon(commitmentId: string, state: DomainState, now: Date): boolean {
  const commitment = state.commitments[commitmentId];
  if (!commitment || !isTimedFixedEvent(commitment)) return false;
  const delta = (startOf(commitment) as number) - now.getTime();
  return delta >= 0 && delta <= FIXED_EVENT_LEAD_MS;
}

// ── words: shared with the phone (`src/extraction/lexicon/eventTitles.ts`) ──

/** Words that say nothing about the topic: «عندي», "have", «יש לי»… */
const FILLER = new Set(wordsOf([
  'عندي عندك عندنا في من مع على عن بكرا اليوم الليله الساعه بعد قبل الصبح المسا هلق لازم بدي',
  'i have has had a an the my at on in for with to of tomorrow today tonight',
  'יש לי את של עם על מחר היום בשעה',
].join(' ')));

function topicWords(title: string): Set<string> {
  return new Set(wordsOf(title).filter((word) => word.length >= 3 && !FILLER.has(word) && !/^\d+$/.test(word)));
}

// ── preparation ───────────────────────────────────────────────────

/**
 * Something on the list already prepares for this event: a «حضّرني» window
 * that ends at its start, or anything but another exam sharing a word of its
 * title and due no later than it — «ادرس رياضيات» for «امتحان رياضيات».
 * Completed counts: they prepared. Dropped does not.
 */
export function preparationPlanned(event: Commitment, state: DomainState): boolean {
  const start = startOf(event);
  const topic = topicWords(event.title);
  return Object.values(state.commitments).some((other) => {
    if (other.id === event.id || GONE.has(other.status)) return false;
    if (other.timeSpec.kind === 'due_by' && other.timeSpec.endAt && start !== null
      && Date.parse(other.timeSpec.endAt) === start) return true;
    // Another exam is not preparation for this one; a study session at 17:00
    // («لازم أدرس للامتحان الساعة 5», a `scheduled_event` too) is: it opens
    // with what to do, so it is a task (`namesPreparedEvent`).
    if (namesPreparedEvent(other.title)) return false;
    const due = other.timeSpec.dueAt ? Date.parse(other.timeSpec.dueAt) : Number.NaN;
    if (Number.isFinite(due) && start !== null && due > start) return false;
    return Array.from(topicWords(other.title)).some((word) => topic.has(word));
  });
}

function localHour(at: number, timezone: string): number | null {
  try {
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }).format(new Date(at));
    const parsed = Number(hour);
    return Number.isFinite(parsed) ? parsed % 24 : null;
  } catch {
    return null;
  }
}

/** Rule 3: the earliest timed event in the evening or night before `event`, after now. */
export function eveningPlanBefore(event: Commitment, state: DomainState, now: Date, timezone: string): Commitment | null {
  const start = startOf(event);
  if (start === null) return null;
  const found = Object.values(state.commitments)
    .filter((other) => other.id !== event.id && OPEN.has(other.status) && other.confirmedAt !== null
      && isTimedFixedEvent(other) && !namesPreparedEvent(other.title))
    .filter((other) => {
      const at = startOf(other) as number;
      if (at <= now.getTime() || at >= start || start - at > EVENING_WINDOW_MS) return false;
      const hour = localHour(at, other.timeSpec.timezone || timezone);
      return hour !== null && (hour >= 17 || hour < 5);
    })
    .sort((left, right) => (startOf(left) as number) - (startOf(right) as number));
  return found[0] ?? null;
}

export interface PreparationStep {
  event: Commitment;
  title: string;
  evidenceCodes: NextStepEvidenceContract[];
}

/** «عندي امتحان رياضيات» → «امتحان رياضيات»: the rule-based title keeps the possessive. */
function eventName(title: string): string {
  return title
    .replace(/^\s*(?:في\s+)?(?:عندي|عندنا|عندك)\s+/, '')
    .replace(/^\s*(?:i(?:'ve| have)(?: got)?|have|got)\s+(?:an?\s+|my\s+)?/i, '')
    .replace(/^\s*יש\s+(?:לי|לנו)\s+/, '')
    .trim() || title.trim();
}

/** The step's words, in the language the phone asked for. */
export function preparationTitle(title: string, locale: NextStepLocale): string {
  const name = eventName(title);
  if (locale === 'ar') {
    // «ل» joins an Arabic word directly («لامتحان»); with the article it
    // takes the alif's place («للامتحان»). Anything else gets «لـ».
    if (/^ال[ء-ي]/.test(name)) return `حضّر ل${name.slice(1)}`;
    if (/^[ء-ي]/.test(name)) return `حضّر ل${name}`;
    return `حضّر لـ${name}`;
  }
  if (locale === 'he') {
    const bare = /^ה[א-ת]{2,}/.test(name) ? name.slice(1) : name;
    return /^[א-ת]/.test(bare) ? `להתכונן ל${bare}` : `להתכונן ל־${bare}`;
  }
  return `Prepare for ${name}`;
}

/**
 * Rule 2 (and 3): the preparation step the card should offer now, or null.
 *
 * The nearest important event first. `exclude` is the same set the selector
 * is given — an event the person deferred or dismissed on the card is not
 * offered again as its own preparation.
 */
export function preparationStep(
  state: DomainState,
  now: Date,
  timezone: string,
  locale: NextStepLocale,
  exclude?: ReadonlySet<string>,
): PreparationStep | null {
  const nowMs = now.getTime();
  const event = Object.values(state.commitments)
    .filter((commitment) => !exclude?.has(commitment.id)
      && commitment.status === 'active' && commitment.confirmedAt !== null
      && commitment.timeSpec.kind === 'scheduled_event' && namesPreparedEvent(commitment.title))
    .filter((commitment) => {
      const start = startOf(commitment);
      return start !== null && start - nowMs >= PREPARATION_MIN_LEAD_MS && start - nowMs <= PREPARATION_HORIZON_MS;
    })
    .filter((commitment) => !preparationPlanned(commitment, state))
    .sort((left, right) => (startOf(left) as number) - (startOf(right) as number))[0];
  if (!event) return null;

  const start = startOf(event) as number;
  const evidenceCodes: NextStepEvidenceContract[] = [
    { code: 'prepares_for_event', params: { at: new Date(start).toISOString(), ...(event.timeSpec.allDay ? { allDay: true } : {}) } },
  ];
  const evening = eveningPlanBefore(event, state, now, timezone);
  if (evening) {
    evidenceCodes.push({
      code: 'evening_plan_before_event',
      params: { title: eventName(evening.title).slice(0, 80), at: evening.timeSpec.dueAt as string },
    });
  }
  evidenceCodes.push({ code: start - nowMs <= 24 * HOUR ? 'due_within_24h' : 'due_within_7d' });
  return { event, title: preparationTitle(event.title, locale), evidenceCodes };
}
