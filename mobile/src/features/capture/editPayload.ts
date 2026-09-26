import { instantForLocalDateTime } from './localInstant';
import type { CaptureItemEdit } from './captureMachine';

/**
 * The edits, as the confirm endpoint takes them (UC-2.4, #164).
 *
 * ── Wall clock in, instant out ───────────────────────────────────
 *
 * The sheet works in the user's own clock — "tomorrow, 18:00" — because that is
 * what they picked and what they will check. The server takes an instant. The
 * conversion happens here, once, in the device zone the request already
 * carries, so the hour that is persisted is the hour that was on screen.
 *
 * ── The empty string is an answer ────────────────────────────────
 *
 * `localDateTime: ''` is the "No time" switch: a change the user made, sent as
 * `resolvedTime: null`. An absent `localDateTime` is a field they did not
 * touch, and is not sent at all. Collapsing the two would let toggling a switch
 * be indistinguishable from never opening the sheet.
 */
export interface ServerItemEdit {
  itemId: string;
  title?: string;
  resolvedTime?: string | null;
  priority?: 'high' | 'normal' | 'low';
  locationTrigger?: { kind: 'arrive' | 'leave'; placeId: string; label: string };
}

export function toServerEdits(
  edits: Record<string, CaptureItemEdit>,
  timezone: string,
): ServerItemEdit[] {
  return Object.entries(edits).flatMap(([itemId, edit]): ServerItemEdit[] => {
    const payload: ServerItemEdit = { itemId };
    if (edit.title !== undefined) payload.title = edit.title;
    if (edit.priority !== undefined) payload.priority = edit.priority;
    // The three fields by name, so nothing else about the place can ride along.
    if (edit.locationTrigger) {
      const { kind, placeId, label } = edit.locationTrigger;
      payload.locationTrigger = { kind, placeId, label };
    }

    if (edit.localDateTime !== undefined) {
      if (edit.localDateTime === '') {
        payload.resolvedTime = null;
      } else {
        const instant = instantForLocalDateTime(edit.localDateTime, timezone);
        // An unparseable wall clock is dropped rather than sent as `null`,
        // which the server would read as "no time" — a different edit from the
        // one the user made.
        if (instant) payload.resolvedTime = instant.toISOString();
      }
    }

    // An entry with nothing but an id asks the server to validate a change
    // nobody made.
    return Object.keys(payload).length > 1 ? [payload] : [];
  });
}
