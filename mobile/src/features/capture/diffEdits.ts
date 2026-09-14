/**
 * What changed between what the server proposed and what the user left on screen
 * (UC-2.4, #164).
 *
 * Pure, and deliberately so: it decides what is sent to the server, and "what is
 * sent" is the kind of thing that should be readable as a function of two
 * objects rather than inferred from a component's state.
 *
 * Only *changed* fields are emitted. Sending every field of every item would
 * make an untouched proposal indistinguishable from one the user retyped
 * identically, and would ask the server to re-validate values it produced
 * itself — including a time that has since drifted into the past while the
 * review screen was open.
 */
import type { CaptureProposal, CaptureProposalItem } from '../../api/schemas/capture';
import { instantForWallClock } from '../../lib/time/zoneOffset';
import type { CaptureItemEdit } from './captureMachine';

/** One edit, in the shape the confirm request carries. */
export interface CaptureItemEditRequest {
  itemId: string;
  title?: string;
  resolvedTime?: string | null;
  priority?: 'low' | 'normal' | 'high';
}

/**
 * The local wall clock an edit names, as an instant.
 *
 * The sheet works in `YYYY-MM-DDTHH:mm` on the device's own clock, because that
 * is what a person picked; the server wants an instant. Anything unparseable is
 * dropped rather than guessed at -- a wrong instant is worse than no edit.
 */
export function instantFromLocalEdit(localDateTime: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localDateTime.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  try {
    // Two passes, so a zone offset is removed at the offset in force *at* that
    // moment rather than at whatever it is today -- a one-hour error twice a
    // year, on exactly the days a reminder matters most.
    return instantForWallClock(
      {
        year: Number(year),
        month: Number(month),
        day: Number(day),
        hour: Number(hour),
        minute: Number(minute),
      },
      timeZone,
    ).toISOString();
  } catch {
    return null;
  }
}

function itemById(proposal: CaptureProposal | null, itemId: string): CaptureProposalItem | undefined {
  return proposal?.items.find((item) => item.itemId === itemId);
}

/**
 * The edits to send, for the selected items only.
 *
 * An edit for an item the user deselected is dropped: it would ask the server to
 * validate a change to something that is not being written, which can fail the
 * confirm for a reason the user cannot see on screen.
 */
export function diffEdits(
  original: CaptureProposal | null,
  edits: Record<string, CaptureItemEdit>,
  selectedItemIds: readonly string[],
  timeZone: string,
): CaptureItemEditRequest[] {
  const selected = new Set(selectedItemIds);
  const requests: CaptureItemEditRequest[] = [];

  for (const [itemId, edit] of Object.entries(edits)) {
    if (!selected.has(itemId)) continue;
    const item = itemById(original, itemId);
    if (!item) continue;

    const request: CaptureItemEditRequest = { itemId };
    let changed = false;

    if (edit.title !== undefined && edit.title.trim() !== item.title.trim()) {
      request.title = edit.title.trim();
      changed = true;
    }

    if (edit.localDateTime !== undefined) {
      // An empty string is the "No time" switch, which is a change the user made
      // and not an absent value.
      const next = edit.localDateTime === '' ? null : instantFromLocalEdit(edit.localDateTime, timeZone);
      if (edit.localDateTime !== '' && next === null) {
        // Unparseable: dropped rather than sent as something else.
      } else if (next !== item.resolvedTime) {
        request.resolvedTime = next;
        changed = true;
      }
    }

    if (edit.priority !== undefined && edit.priority !== item.priority) {
      request.priority = edit.priority;
      changed = true;
    }

    if (changed) requests.push(request);
  }

  // Sorted, so two confirms that differ only in the order the client collected
  // the edits share an idempotency key rather than persisting twice.
  return requests.sort((a, b) => a.itemId.localeCompare(b.itemId));
}

/** Must / Should / Nice, as the review screen labels them. */
export function importanceLabelFor(priority: 'low' | 'normal' | 'high' | undefined): 'must' | 'should' | 'nice' {
  if (priority === 'high') return 'must';
  if (priority === 'low') return 'nice';
  return 'should';
}
