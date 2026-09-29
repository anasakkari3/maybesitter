/**
 * The weekly-block form's rules, pure (Settings → «الثابت الأسبوعي»).
 *
 * The server keeps the same rules (`weeklyBlockContracts.ts`) and is the one
 * that decides; these say it first, in the person's language, and name only
 * what changed on an edit — a patch that restated every field would be one
 * more way to overwrite a change made on another phone.
 */
import { WeeklyBlockRefusedError } from '../../api/errors';
import { userFacingMessageKey, type UserFacingKey } from '../../api/ui/userFacingMessage';
import type { WeeklyBlockPatch } from '../../api/endpoints/weeklyBlocks';
import type { WeeklyBlock } from '../../api/schemas/weeklyBlocks';

export interface WeeklyDraft {
  title: string;
  weekdays: number[];
  start: string;
  end: string;
}

function minutes(clock: string): number {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
}

/** The first thing wrong with the draft, as a copy key, or null. */
export function validateWeeklyDraft(draft: WeeklyDraft): UserFacingKey | null {
  if (draft.title.trim() === '') return 'wbErrNoTitle';
  if (draft.weekdays.length === 0) return 'wbErrNoDay';
  // Same day, end after start: 22:00–06:00 is not refused as "invalid", it is
  // said for what it is — overnight — as the server would.
  if (minutes(draft.end) <= minutes(draft.start)) return 'wbErrOvernight';
  return null;
}

function sameDays(a: readonly number[], b: readonly number[]): boolean {
  const left = [...new Set(a)].sort((x, y) => x - y);
  const right = [...new Set(b)].sort((x, y) => x - y);
  return left.length === right.length && left.every((day, index) => day === right[index]);
}

/** Only the fields the person changed. */
export function patchFor(block: WeeklyBlock, draft: WeeklyDraft): WeeklyBlockPatch {
  const patch: WeeklyBlockPatch = {};
  const title = draft.title.trim();
  if (title !== block.title) patch.title = title;
  if (!sameDays(block.weekdays, draft.weekdays)) patch.weekdays = [...draft.weekdays].sort((a, b) => a - b);
  if (draft.start !== block.start) patch.start = draft.start;
  if (draft.end !== block.end) patch.end = draft.end;
  return patch;
}

const CODE_KEYS: Record<string, UserFacingKey> = {
  overnight_not_supported: 'wbErrOvernight',
  invalid_title: 'wbErrNoTitle',
  invalid_weekdays: 'wbErrNoDay',
};

/** The server's refusal in the person's words; anything else, the app's one table. */
export function weeklyErrorKey(error: unknown): UserFacingKey {
  if (error instanceof WeeklyBlockRefusedError) return CODE_KEYS[error.code] ?? 'errorsGeneric';
  return userFacingMessageKey(error);
}
