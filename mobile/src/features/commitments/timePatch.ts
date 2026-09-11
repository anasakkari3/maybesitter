/**
 * Which time field an edit of a commitment sends to
 * PATCH /api/mobile/commitments/:id.
 *
 * Not wired yet. Its consumers are the /api/mobile client's usePatchCommitment
 * (UC-1.R4, #157) and the details edit sheet (UC-2.R3, #173). The input is the
 * server's time spec — `dueAt` / `remindAt` as ISO instants — not the design
 * prototype's sample-week Commitment. The output keys are exactly the ones the
 * server's patchTimeSpec reads.
 *
 * The screen shows and edits `dueAt`, falling back to `remindAt` only when an
 * item has no due time. A plain move sends `dueDate` alone, and the server
 * shifts `remindAt` by the same delta, so the lead the user chose survives
 * (UC-0.2c, #134). Sending both fields — what the retired Flutter client did on
 * every edit, even a title fix — collapsed the reminder onto the due time.
 */
export type CommitmentTimes = { dueAt: string | null; remindAt: string | null };

export type TimePatch = { dueDate?: string; reminderTime?: string };

export function buildTimePatch(current: CommitmentTimes, editedInstant?: string): TimePatch {
  // A title, description or priority edit never touches time.
  if (editedInstant === undefined) return {};

  const shown = current.dueAt ?? current.remindAt;
  if (shown !== null && Date.parse(shown) === Date.parse(editedInstant)) return {};

  // An item with only a reminder moves its reminder; everything else moves its
  // due time and lets the server carry the reminder along.
  if (current.dueAt === null && current.remindAt !== null) return { reminderTime: editedInstant };
  return { dueDate: editedInstant };
}
