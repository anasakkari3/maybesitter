/**
 * "You already have something then" (UC-3.2, #186 step 7).
 *
 * The Flutter build had this and hid it: `summarizeCalendarConflicts` was
 * called from one place, `trust_center_screen.dart`, three taps inside
 * Settings. A conflict is only useful at the moment somebody is about to agree
 * to something, so this is the same question asked where the answer changes
 * what they do — on the review card and on Today.
 *
 * ── A commitment is a point, not a block ────────────────────────
 *
 * `TodayScreen` says why at length: a captured commitment names an instant —
 * a `due_by`, or since CL1 a `scheduled_event` for "at 5" — and no end, so
 * a card drawn as a block would imply the user told us how long something
 * takes when they only said when it was. So the question here is "is this
 * *instant* inside a busy interval", half-open like every other interval in the
 * product: a commitment at exactly 15:00 conflicts with 14:00–15:00 not at all
 * and with 15:00–16:00 completely.
 *
 * ── It never blocks a confirm ────────────────────────────────────
 *
 * There is no path from a conflict to a refusal. People double-book on purpose,
 * they leave a lecture early, and a calendar is not a court. The product says
 * what it noticed and gets out of the way — which is also why this returns the
 * blocks rather than a boolean: the chip shows *when*, and "you are busy" with
 * no time attached is an accusation rather than a reminder.
 *
 * ── Why all-day entries are in here and not in the planner ───────
 *
 * #186's decision. An all-day entry does not block a day for scheduling — see
 * `toFixedEvents` on the server — because a birthday is not eight hours of
 * unavailable time. It is still worth mentioning, so it comes back here and the
 * chip words it differently.
 */
import type { DeviceBusyBlock } from './busyBlocks';

/** Anything the screens want checked: a proposal, or a commitment on Today. */
export interface ConflictSubject {
  readonly id: string;
  /** When it is due, as an instant. Null for anything with no time yet. */
  readonly at: string | null;
}

/** The blocks covering one instant, earliest first. Empty when nothing does. */
export function busyAt(at: string, blocks: readonly DeviceBusyBlock[]): DeviceBusyBlock[] {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return [];
  return blocks
    .filter((block) => {
      const start = Date.parse(block.startAt);
      const end = Date.parse(block.endAt);
      return Number.isFinite(start) && Number.isFinite(end) && start <= ms && ms < end;
    })
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
}

/**
 * The blocks a proposed item runs into, earliest first: `busyAt` for a point,
 * and for a range the person said («من 4 لـ 8», audit 2026-10-06 #2) every
 * block overlapping it, half-open on both sides — a range ending at 20:00 does
 * not clash with a block starting at 20:00, and one across midnight clashes
 * with what is on the next morning.
 */
export function busyDuring(start: Date, end: Date | null, blocks: readonly DeviceBusyBlock[]): DeviceBusyBlock[] {
  if (!end) return busyAt(start.toISOString(), blocks);
  const from = start.getTime();
  const to = end.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return busyAt(start.toISOString(), blocks);
  return blocks
    .filter((block) => {
      const blockStart = Date.parse(block.startAt);
      const blockEnd = Date.parse(block.endAt);
      return Number.isFinite(blockStart) && Number.isFinite(blockEnd) && blockStart < to && from < blockEnd;
    })
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
}

/**
 * Per subject, what it runs into.
 *
 * A `Map` rather than a decorated copy of the list: the screens already hold
 * their own items and a second shape of them is a second thing to keep in step.
 * Subjects with no time and subjects with no conflict are simply absent, so
 * `map.get(id) ?? []` is the whole reading of it.
 */
export function conflictsFor(
  subjects: readonly ConflictSubject[],
  blocks: readonly DeviceBusyBlock[],
): Map<string, DeviceBusyBlock[]> {
  const found = new Map<string, DeviceBusyBlock[]>();
  if (blocks.length === 0) return found;
  for (const subject of subjects) {
    if (subject.at === null) continue;
    const hits = busyAt(subject.at, blocks);
    if (hits.length > 0) found.set(subject.id, hits);
  }
  return found;
}

/**
 * The one block a chip should name, out of however many overlap.
 *
 * A timed one, in preference to an all-day one. "Overlaps 13:30–15:00" is an
 * answer; "overlaps an all-day entry" is a shrug, and on a day with both the
 * useful sentence is the one with times in it.
 */
export function chipBlock(blocks: readonly DeviceBusyBlock[]): DeviceBusyBlock | null {
  return blocks.find((block) => !block.allDay) ?? blocks[0] ?? null;
}
