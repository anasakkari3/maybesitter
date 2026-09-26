/**
 * Applying what the user changed in review, atomically (UC-2.4, #164).
 *
 * -- Why this is not a PATCH after the confirm --------------------
 *
 * UC-2.R2 (#172)'s original plan saved the commitment first and then sent the
 * edited title in a second request. That leaves the user holding a commitment
 * with a title they had already changed for as long as the second call takes --
 * and permanently, if it fails. Worse, a failed PATCH is silent: the confirm
 * already said "saved".
 *
 * So the edits travel with the confirm and are applied to the commands before
 * anything is persisted. What the user saw when they pressed confirm is what
 * gets written, or nothing is.
 *
 * -- Why one bad edit fails the whole confirm ---------------------
 *
 * Applying the valid ones and dropping the rest would leave some commitments as
 * the user wanted them and others as the extractor guessed, with nothing on
 * screen to say which is which. Refusing all of it is recoverable; a silently
 * mixed result is not.
 *
 * -- Why an allow-list rather than a merge ------------------------
 *
 * Only title, time and priority are editable, because those are the three the
 * review screen shows -- an edit to anything else would be editing something
 * the user never saw. The server reads those three fields and ignores the rest
 * of the object, so a field added to the client cannot become a field the
 * server writes.
 */
import {
  CAPTURE_EDIT_TITLE_MAX,
  CAPTURE_EDIT_TITLE_MIN,
  type CaptureItemEditContract,
} from '../../../src/contracts/v1/captureContracts';
import {
  LocationTriggerValidationError,
  parseLocationTrigger,
  type LocationTrigger,
} from '../../../src/contracts/v1/locationTriggerContracts';
import type { Command } from '../../../src/domain/stateMachine';
import { isPastCommitmentTime } from '../commitments/timeRules';
import { isDateOnly, parseIsoInstant } from '../mobile/time';

export class InvalidEditError extends Error {
  constructor(readonly itemId: string, readonly field: string, readonly detail: string) {
    // No value in the message: an edit carries the user's own title.
    super(`invalid edit on ${field}`);
    this.name = 'InvalidEditError';
  }
}

/**
 * Control characters, which a title must not contain even after trimming.
 *
 * Written as escapes rather than as literal characters so that the rule is
 * readable in a diff and cannot be altered by an invisible byte.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export interface NormalisedEdit {
  title?: string;
  resolvedTime?: string | null;
  priority?: 'low' | 'normal' | 'high';
  /** `null` is "no place reminder", which a new commitment has anyway. */
  locationTrigger?: LocationTrigger | null;
}

/**
 * Checks one edit against the rules, and returns it normalised.
 *
 * Deterministic and total: every refusal names a field, and nothing here
 * depends on the clock except the past-time rule, which takes `now` as an
 * argument rather than reading it.
 */
export function validateEdit(
  edit: CaptureItemEditContract,
  knownItemIds: ReadonlySet<string>,
  now: Date,
): NormalisedEdit {
  if (typeof edit?.itemId !== 'string' || !knownItemIds.has(edit.itemId)) {
    throw new InvalidEditError(String(edit?.itemId ?? ''), 'itemId', 'not part of this proposal');
  }

  const normalised: NormalisedEdit = {};

  if (edit.title !== undefined) {
    if (typeof edit.title !== 'string') throw new InvalidEditError(edit.itemId, 'title', 'not a string');
    const title = edit.title.trim();
    if (title.length < CAPTURE_EDIT_TITLE_MIN || title.length > CAPTURE_EDIT_TITLE_MAX) {
      throw new InvalidEditError(edit.itemId, 'title', 'length out of range');
    }
    // Checked after trimming, so trailing whitespace is not an error while an
    // embedded newline still is -- a title is one line.
    if (CONTROL_CHARACTERS.test(title)) throw new InvalidEditError(edit.itemId, 'title', 'control character');
    normalised.title = title;
  }

  if (edit.resolvedTime !== undefined) {
    if (edit.resolvedTime === null) {
      // "No time" is a choice a user is allowed to make.
      normalised.resolvedTime = null;
    } else {
      if (typeof edit.resolvedTime !== 'string') {
        throw new InvalidEditError(edit.itemId, 'resolvedTime', 'not a string');
      }
      // Refused for being a date, before anything gives it an hour (#375).
      //
      // `Date.parse('2099-01-15')` is UTC midnight, which is a real instant and
      // so passes every check below — including the past-time rule, when the
      // date is far enough ahead. That midnight is 03:00 for this product's
      // default Asia/Jerusalem user, so a bare date was accepted and scheduled
      // a reminder at three in the morning on an hour nobody chose. #352 fixed
      // the same hole on the PATCH path and left this one, because its brief
      // was to keep this file's behaviour identical; the two answer the same
      // question now.
      //
      // The shape test is shared with that boundary (`isDateOnly`) while the
      // refusal stays this path's own, the same split the past-time rule uses.
      // No caller in the app can reach this: both edit sheets convert a picked
      // wall clock through `toISOString()`. `editsFrom` in
      // `mobileCaptureService.ts` validates shape and not format, though, so
      // any other client of `POST /api/mobile/capture/confirm` can.
      if (isDateOnly(edit.resolvedTime)) {
        throw new InvalidEditError(edit.itemId, 'resolvedTime', 'a date with no time of day');
      }
      // `parseIsoInstant`, not `Date.parse`: an offset-less datetime is read
      // as UTC rather than as the server's zone, so the stored instant is the
      // same on a developer's machine and on Cloud Run (#121).
      let parsed: number;
      try {
        parsed = parseIsoInstant(edit.resolvedTime, 'resolvedTime').getTime();
      } catch {
        throw new InvalidEditError(edit.itemId, 'resolvedTime', 'not an instant');
      }
      // A reminder in the past is one that will never fire, and saving it
      // silently is worse than refusing it. The comparison itself is shared
      // with `PATCH /api/mobile/commitments/:id` (#352) so that the two paths
      // cannot drift apart again; only the refusal below is this path's own.
      if (isPastCommitmentTime(parsed, now)) {
        throw new InvalidEditError(edit.itemId, 'resolvedTime', 'in the past');
      }
      normalised.resolvedTime = new Date(parsed).toISOString();
    }
  }

  if (edit.priority !== undefined) {
    if (edit.priority !== 'low' && edit.priority !== 'normal' && edit.priority !== 'high') {
      throw new InvalidEditError(edit.itemId, 'priority', 'not a level');
    }
    normalised.priority = edit.priority;
  }

  if (edit.locationTrigger !== undefined) {
    if (edit.locationTrigger === null) {
      normalised.locationTrigger = null;
    } else {
      try {
        normalised.locationTrigger = parseLocationTrigger(edit.locationTrigger);
      } catch (error) {
        if (error instanceof LocationTriggerValidationError) {
          throw new InvalidEditError(edit.itemId, 'locationTrigger', error.field);
        }
        throw error;
      }
    }
  }

  return normalised;
}

type CreateDraft = Extract<Command, { type: 'CreateDraft' }>;

/**
 * Rewrites the stored commands for one item with what the user changed.
 *
 * A priority set here is `user_explicit`, never `inferred`: the person said it.
 * That provenance is what the next-step baseline already reads as importance,
 * so mislabelling it would quietly change which commitment the product
 * recommends.
 *
 * Clearing the time turns a `due_by` commitment into an `unscheduled` one and
 * drops any `ConfirmCommitment` that followed -- confirming a commitment with
 * nothing to remind anyone about is how a reminder silently never fires.
 */
export function applyEditToCommands(commands: readonly Command[], edit: NormalisedEdit): Command[] {
  if (
    edit.title === undefined && edit.resolvedTime === undefined && edit.priority === undefined
    && !edit.locationTrigger
  ) {
    return [...commands];
  }

  const rewritten = commands.map((command): Command => {
    if (command.type !== 'CreateDraft') return command;
    const draft = command as CreateDraft;
    const commitment = draft.commitment;

    const timeSpec = edit.resolvedTime === undefined
      ? commitment.timeSpec
      : {
        ...commitment.timeSpec,
        kind: edit.resolvedTime === null ? ('unscheduled' as const) : ('due_by' as const),
        dueAt: edit.resolvedTime,
        remindAt: edit.resolvedTime,
      };

    return {
      ...draft,
      commitment: {
        ...commitment,
        ...(edit.title !== undefined ? { title: edit.title } : {}),
        ...(edit.priority !== undefined
          ? {
            priority: {
              ...commitment.priority,
              level: edit.priority,
              // The person said so. This is the whole point of the edit.
              source: 'user_explicit' as const,
              pressureAllowed: false,
              pressureLevel: 'none' as const,
            },
          }
          : {}),
        ...(edit.locationTrigger ? { locationTrigger: edit.locationTrigger } : {}),
        timeSpec,
      },
    };
  });

  if (edit.resolvedTime === null) {
    return rewritten.filter((command) => command.type !== 'ConfirmCommitment');
  }
  return rewritten;
}
