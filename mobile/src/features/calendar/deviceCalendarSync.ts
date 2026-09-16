/**
 * Keeping the phone's calendar in step with the account (UC-3.1, #185).
 *
 * One function, `reconcile`, run over the commitments the app already holds.
 * Not a stream of events and not a queue: the app is given a list of
 * commitments and their links on every refresh, so "what should the calendar
 * look like" is answerable from data already in hand, and answering it the same
 * way every time is what makes a missed confirm, a killed app or a flaky
 * network self-correcting rather than a permanent divergence.
 *
 * ── Every decision is a pure function of (target, link, draft) ───
 *
 * `decide` below takes no clock, no storage and no native module, and returns
 * one of five plans. That is deliberate: the acceptance criteria for this issue
 * are almost all statements about *which* plan is chosen — off writes nothing,
 * a second device writes nothing, a detached event is never recreated — and on
 * a device none of them can be observed without seeded calendars. Making the
 * decision separable means the criteria are tested even though the effect
 * cannot be.
 *
 * ── The five plans ───────────────────────────────────────────────
 *
 *   `none`     nothing to do
 *   `create`   no link yet, and the commitment names a time
 *   `update`   our link, and the event no longer matches the commitment
 *   `delete`   our link, and the commitment is gone or has lost its time
 *   `detach`   our link, and the event is not in the calendar any more
 *
 * ── What is deliberately *not* here ──────────────────────────────
 *
 * A completed commitment keeps its event. It happened; the calendar is a record
 * of somebody's week, and deleting the entry for the dentist appointment they
 * went to would make their own history wrong.
 *
 * Turning the target off writes nothing more and removes nothing. "Stop adding"
 * and "remove what you added" are two sentences, and the second has its own
 * button — `removeAllWrittenEvents` below.
 *
 * Nothing is ever read *out* of the calendar except "is this event still
 * there?". The app cannot see a title it did not write.
 */
import type { Commitment, DeviceCalendarLink } from '../../api/schemas/common';
import type { CalendarWriteTarget } from '../../api/schemas/calendar';
import { DeviceCalendarError, type DeviceCalendar } from './deviceCalendar';
import { draftFor, type EventDraft } from './eventDraft';

export type SyncPlan =
  | { kind: 'none'; because: NoReason }
  | { kind: 'create'; draft: EventDraft }
  | { kind: 'update'; eventId: string; draft: EventDraft }
  | { kind: 'delete'; eventId: string }
  | { kind: 'detach'; eventId: string };

export type NoReason =
  /** The account is not writing to a device calendar. */
  | 'target_off'
  /** Another installation owns this commitment's event. */
  | 'foreign_writer'
  /** The user deleted the event by hand. It is never written again. */
  | 'detached'
  /** The commitment names no time, and never had an event. */
  | 'undated'
  /** The event already says exactly this. */
  | 'unchanged'
  /** The commitment is gone and there was no event to remove. */
  | 'gone'
  /** A capture the user has not confirmed. Nothing is written for one. */
  | 'unconfirmed'
  /** No calendar has been picked on this device yet. */
  | 'no_calendar';

export interface SyncSubject {
  /**
   * The commitment this is about.
   *
   * Carried separately from `commitment` because a subject can be a link with
   * no commitment behind it at all, and that subject still has to name the row
   * it is going to delete.
   */
  commitmentId: string;
  /**
   * The commitment as the account has it, or `null` when the account no longer
   * holds it — cancelled, or gone.
   *
   * This is deliberately a *value* and not a `removed: true` flag. A flag is
   * something a caller has to remember to set, and the one caller there is
   * never set it: the pass is built from the lists, a deleted commitment is
   * simply absent from them, and the delete branch guarded by the flag was
   * unreachable in the shipped app while a test handed it the flag by hand and
   * passed. `null` cannot be forgotten, because it is the only thing an orphan
   * link has to offer.
   */
  commitment: Commitment | null;
  /**
   * The link as the server last answered.
   *
   * `undefined` is not `null`. `null` means "there is no link"; `undefined`
   * means "this response did not say", which happens on a 409 conflict body —
   * and treating the two alike is how a refusal becomes a second event.
   */
  link: DeviceCalendarLink | null | undefined;
}

export interface DecideInput extends SyncSubject {
  writeTarget: CalendarWriteTarget;
  writerId: string;
  calendarId: string | null;
  deviceTimeZone: string;
  /** Whether the event is still in the calendar. Checked only when linked. */
  eventStillThere: boolean;
}

/**
 * What to do about one commitment.
 *
 * The order of the guards is the order of the invariants, strongest first: an
 * account that is not writing writes nothing, whatever else is true; a link
 * somebody else owns is never touched, even to delete it; a detached event is
 * never recreated, even by an edit. Reordering any of the first three turns an
 * acceptance criterion into a bug, which is why each has a test that fails on
 * its own.
 */
export function decide(input: DecideInput): SyncPlan {
  const { link, writerId, commitment } = input;

  // A link we do not own is not ours to create beside, update, or delete —
  // and this is checked before the target, because a foreign link must survive
  // this device turning its own writing off.
  if (link && link.writerId !== writerId) return { kind: 'none', because: 'foreign_writer' };

  if (link && link.state === 'detached') return { kind: 'none', because: 'detached' };

  if (link) {
    // The user removed it in their Calendar app. Record that, and never write
    // it again. Checked first, because an event that is already gone needs no
    // delete and the link still has to stop being `linked`.
    if (!input.eventStillThere) return { kind: 'detach', eventId: link.eventId };
    // The commitment is gone. This is above the target check on purpose:
    // turning the switch off stops writing, and deleting a commitment is not
    // writing — it is taking back something already written, and it must happen
    // whether or not the user is still adding new entries.
    if (commitment === null) return { kind: 'delete', eventId: link.eventId };
  }

  if (input.writeTarget !== 'device') {
    // Off, or pointed at Google (UC-3.3, #187). An event already written stays
    // where it is; this only stops new writes and stops chasing changes.
    return { kind: 'none', because: 'target_off' };
  }

  if (commitment === null) return { kind: 'none', because: 'gone' };

  // A capture waiting to be confirmed is not a commitment anybody made. The
  // issue's own sentence is "every commitment I *confirm*", and an unconfirmed
  // one is on Today for its stated day: without this, opening the app with an
  // abandoned draft in it puts an hour the user never agreed to in front of
  // everybody they share a calendar with. If one ever did get written, the link
  // is honoured and the event taken back out rather than left orphaned.
  if (!isConfirmed(commitment)) {
    if (link) return { kind: 'delete', eventId: link.eventId };
    return { kind: 'none', because: 'unconfirmed' };
  }

  const draft = draftFor(commitment, input.deviceTimeZone);

  if (link) {
    // The commitment lost its time, so the event has nothing left to say.
    if (draft === null) return { kind: 'delete', eventId: link.eventId };
    if (draft.contentHash === link.contentHash) return { kind: 'none', because: 'unchanged' };
    return { kind: 'update', eventId: link.eventId, draft };
  }

  if (draft === null) return { kind: 'none', because: 'undated' };
  if (input.calendarId === null) return { kind: 'none', because: 'no_calendar' };
  return { kind: 'create', draft };
}

/**
 * The statuses a capture passes through before the user has agreed to it.
 *
 * Named from `stateMachine.ts`'s own union — they are the three
 * `ensureCommitmentStatus` allows a confirm command to move out of.
 */
const UNCONFIRMED_STATUSES: ReadonlySet<string> = new Set([
  'draft', 'needs_clarification', 'pending_confirmation',
]);

function isConfirmed(commitment: Commitment): boolean {
  return !UNCONFIRMED_STATUSES.has(commitment.status);
}

/** What `reconcile` did, so a screen can say so and a test can count. */
export interface SyncOutcome {
  created: number;
  updated: number;
  deleted: number;
  detached: number;
  skipped: number;
  /** Set when the pass stopped because the user has not granted access. */
  permissionDenied: boolean;
}

const EMPTY_OUTCOME: SyncOutcome = {
  created: 0, updated: 0, deleted: 0, detached: 0, skipped: 0, permissionDenied: false,
};

/**
 * What the sync needs from the rest of the app, as functions it is handed.
 *
 * `putLink` and `deleteLink` are the server calls, and `putLink` is where the
 * second-device rule is decided: the first installation to claim a commitment
 * owns its event and every other claim comes back 409.
 *
 * The claim cannot come *first*, because the thing being claimed is an event id
 * and there is no id until the event exists. So a create writes the event,
 * claims it, and — if the claim is refused or never lands — takes the event
 * back out again. `apply` below is where that happens, and it is the only
 * reason "a second device does not leave a duplicate" is true rather than
 * merely intended.
 */
export interface SyncPorts {
  calendar: DeviceCalendar;
  /** Claims or updates the link. Rejects with a conflict when refused. */
  putLink(commitmentId: string, link: Omit<DeviceCalendarLink, 'writtenAt'>): Promise<void>;
  deleteLink(commitmentId: string, writerId: string): Promise<void>;
  /** Records an event id so UC-3.2 (#186) can skip our own events. */
  rememberEvent(eventId: string): Promise<void>;
  forgetEvent(eventId: string): Promise<void>;
}

export interface ReconcileInput {
  subjects: readonly SyncSubject[];
  writeTarget: CalendarWriteTarget;
  writerId: string;
  calendarId: string | null;
  deviceTimeZone: string;
  ports: SyncPorts;
}

/**
 * Brings the calendar into line with the commitments in hand.
 *
 * ── It asks the OS nothing when it has nothing to do ─────────────
 *
 * The access check happens only if some subject actually needs the calendar.
 * A build with the target off must not prompt for calendar permission, and must
 * not so much as read the permission state: the criterion is "confirming writes
 * no event", and a permission dialog on an account that turned the feature off
 * would be a worse violation of it than the event.
 *
 * ── One failure does not stop the rest ───────────────────────────
 *
 * A single commitment whose event will not write — a calendar that became
 * read-only, an id the OS no longer knows — is counted as skipped and the pass
 * continues. The alternative is one bad row freezing every other commitment's
 * calendar entry for ever, silently.
 *
 * A *permission* failure is the exception and stops the pass: every remaining
 * write would fail the same way, and the screen has something to say about it.
 */
export async function reconcile(input: ReconcileInput): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { ...EMPTY_OUTCOME };
  const { ports, writerId } = input;

  // Decided first, with no I/O, so the common case — nothing to do — touches
  // neither the OS nor the network.
  const pending: { subject: SyncSubject; plan: SyncPlan }[] = [];
  for (const subject of input.subjects) {
    const plan = decide({
      ...subject,
      writeTarget: input.writeTarget,
      writerId,
      calendarId: input.calendarId,
      deviceTimeZone: input.deviceTimeZone,
      // Assumed present for now; the ones that reach the calendar are checked
      // below, and only those. `eventExists` is a native call per event, and
      // making it here would mean one per commitment on every refresh.
      eventStillThere: true,
    });
    if (plan.kind === 'none') outcome.skipped += 1;
    else pending.push({ subject, plan });
  }
  if (pending.length === 0) return outcome;

  if ((await ports.calendar.getAccess()) !== 'granted') {
    return { ...outcome, skipped: outcome.skipped + pending.length, permissionDenied: true };
  }

  for (const { subject, plan } of pending) {
    try {
      // Re-decided with the real answer, for the subjects that have a link. The
      // first pass assumed the event was there; this is where "the user deleted
      // it in Calendar" is actually discovered.
      const link = subject.link;
      const settled = link && link.writerId === writerId && link.state === 'linked'
        ? decide({
          ...subject,
          writeTarget: input.writeTarget,
          writerId,
          calendarId: input.calendarId,
          deviceTimeZone: input.deviceTimeZone,
          eventStillThere: await ports.calendar.eventExists(link.eventId),
        })
        : plan;
      await apply(subject, settled, input, outcome);
    } catch (error) {
      if (error instanceof DeviceCalendarError && error.reason === 'permission_denied') {
        return { ...outcome, permissionDenied: true };
      }
      // A refused link (another device won the race, or the commitment is
      // detached) and a calendar that will not take this event are both "leave
      // this one alone and carry on".
      outcome.skipped += 1;
    }
  }
  return outcome;
}

async function apply(
  subject: SyncSubject,
  plan: SyncPlan,
  input: ReconcileInput,
  outcome: SyncOutcome,
): Promise<void> {
  const { ports, writerId } = input;
  const commitmentId = subject.commitmentId;

  switch (plan.kind) {
    case 'none':
      outcome.skipped += 1;
      return;

    case 'create': {
      const calendarId = input.calendarId;
      if (calendarId === null) {
        outcome.skipped += 1;
        return;
      }
      /*
       * The event has to exist before it can be claimed, because the claim *is*
       * an event id. So this device writes first and asks second — and undoes
       * its own write when the answer is no.
       *
       * Two ways the answer is no, and they are the same repair:
       *
       *   the claim is **refused** — another installation got there first, or
       *   the user has deleted this event by hand before and the row is a
       *   tombstone. Keeping the event would be the duplicate the whole link
       *   mechanism exists to prevent, sitting in a calendar the other device
       *   cannot reach and with no link row anywhere to clean it up: not even
       *   "Remove events MaybeSitter added" would find it, because that walks
       *   the links.
       *
       *   the claim **never landed** — a dropped connection between the write
       *   and the claim. Leaving the event would be worse than a one-off
       *   orphan: the next pass still sees no link, creates another, and the
       *   user collects one duplicate per time they open the app.
       *
       * The error is rethrown after the repair so the pass counts this subject
       * as skipped, or stops if what failed was the permission.
       */
      const eventId = await ports.calendar.createEvent(calendarId, plan.draft);
      await ports.rememberEvent(eventId);
      try {
        await ports.putLink(commitmentId, {
          writerId,
          calendarId,
          eventId,
          contentHash: plan.draft.contentHash,
          state: 'linked',
        });
      } catch (error) {
        // Deliberately not swallowed: if this delete fails too, its error is
        // the one worth having — a revoked permission stops the whole pass,
        // which a 409 must not.
        await ports.calendar.deleteEvent(eventId);
        await ports.forgetEvent(eventId);
        throw error;
      }
      outcome.created += 1;
      return;
    }

    case 'update': {
      await ports.calendar.updateEvent(plan.eventId, plan.draft);
      await ports.putLink(commitmentId, {
        writerId,
        calendarId: subject.link?.calendarId ?? input.calendarId ?? '',
        eventId: plan.eventId,
        contentHash: plan.draft.contentHash,
        state: 'linked',
      });
      outcome.updated += 1;
      return;
    }

    case 'delete': {
      await ports.calendar.deleteEvent(plan.eventId);
      await ports.forgetEvent(plan.eventId);
      // The row goes too, so a later re-confirm can link afresh rather than
      // being refused for ever by a tombstone that describes nothing.
      await ports.deleteLink(commitmentId, writerId);
      outcome.deleted += 1;
      return;
    }

    case 'detach': {
      await ports.forgetEvent(plan.eventId);
      await ports.putLink(commitmentId, {
        writerId,
        calendarId: subject.link?.calendarId ?? '',
        eventId: plan.eventId,
        contentHash: subject.link?.contentHash ?? '',
        state: 'detached',
      });
      outcome.detached += 1;
      return;
    }
  }
}

/**
 * "Remove events MaybeSitter added" (UC-3.1, #185).
 *
 * Only the events this installation linked, and only those. It walks the links
 * rather than the calendar, so an entry the user made themselves — even one
 * with the same title at the same hour — is never a candidate: the app has no
 * way to name an event it did not write, which is exactly the property that
 * makes this button safe to press.
 *
 * `detached` rows are left alone on purpose. One of those is the record that
 * the user already deleted that event by hand; removing the row would let the
 * next confirm write it back, which is the behaviour the tombstone exists to
 * prevent.
 */
export async function removeAllWrittenEvents(input: {
  subjects: readonly SyncSubject[];
  writerId: string;
  ports: SyncPorts;
}): Promise<{ removed: number; skipped: number; permissionDenied: boolean }> {
  const mine = input.subjects.filter(
    (subject) => subject.link && subject.link.writerId === input.writerId && subject.link.state === 'linked',
  );
  if (mine.length === 0) return { removed: 0, skipped: 0, permissionDenied: false };

  if ((await input.ports.calendar.getAccess()) !== 'granted') {
    return { removed: 0, skipped: mine.length, permissionDenied: true };
  }

  let removed = 0;
  let skipped = 0;
  for (const subject of mine) {
    const link = subject.link!;
    try {
      await input.ports.calendar.deleteEvent(link.eventId);
      await input.ports.forgetEvent(link.eventId);
      await input.ports.deleteLink(subject.commitmentId, input.writerId);
      removed += 1;
    } catch (error) {
      if (error instanceof DeviceCalendarError && error.reason === 'permission_denied') {
        return { removed, skipped: skipped + (mine.length - removed - skipped), permissionDenied: true };
      }
      skipped += 1;
    }
  }
  return { removed, skipped, permissionDenied: false };
}
