/**
 * The capture chat's gentle follow-up (owner decision 2026-11-12, spec Part 1,
 * design item 3, lane E3).
 *
 * After «احكيها» has finished what the person came to say, it asks once,
 * briefly, about things in «ما اتصرّفت فيها» (`unhandledService`). The phone
 * words the question from the items («اجتماعك مع … مبارح — طلع منه إشي لازم
 * تعمله؟»), and every answer is an ordinary action the person confirms: a new
 * commitment said in the chat, done, a new date, dropped, or «لا تسألني عنها».
 *
 * ── The no-pressure rules are here, in code ──────────────────────
 *
 *   - at most one follow-up per capture session: the conversation remembers
 *     that it asked (`followUpAskedAt`), and the phone says when it already
 *     showed one in this session (`followUpShown`);
 *   - at most `MAX_FOLLOW_UP_ITEMS` items in it;
 *   - no item asked about more than `MAX_UNHANDLED_ASKS` times;
 *   - a dismissed item is never in the place, so it is never asked about;
 *   - an ask is counted (`recordUnhandledAsked`) only for the answer that
 *     carries it, and a follow-up whose count could not be written is not sent.
 *
 * ── No model ─────────────────────────────────────────────────────
 *
 * The items are chosen here and the words are the phone's templates. The
 * model is never shown the place, the question or its answers, so the chat
 * call that is already made costs exactly what it did. Nothing here logs.
 *
 * Behind `MAYBESITTER_FEATURE_CAPTURE_FOLLOW_UP` (off by default) and its kill
 * switch, and refused outside local, test and staging.
 */
import { readRuntimeBoolean } from '../../../src/contracts/v1/runtimeControls';
import {
  listUnhandled,
  MAX_UNHANDLED_ASKS,
  recordUnhandledAsked,
  type UnhandledItem,
  type UnhandledReason,
} from '../mobile/unhandledService';

/** At most two items in the one question (spec, "No pressure"). */
export const MAX_FOLLOW_UP_ITEMS = 2;

export interface CaptureChatFollowUpItem {
  commitmentId: string;
  title: string;
  reason: UnhandledReason;
  /** When it ended, or when the deadline passed. */
  since: string;
}

export interface CaptureChatFollowUp {
  items: CaptureChatFollowUpItem[];
}

export function resolveCaptureFollowUp(env: Record<string, string | undefined> = process.env): boolean {
  const environment = (env.MAYBESITTER_ENV ?? 'local').trim().toLowerCase() || 'local';
  if (!['local', 'test', 'staging'].includes(environment)) return false;
  if (readRuntimeBoolean(env.MAYBESITTER_KILL_SWITCH_CAPTURE_FOLLOW_UP, false)) return false;
  return readRuntimeBoolean(env.MAYBESITTER_FEATURE_CAPTURE_FOLLOW_UP, false);
}

/** The items to ask about, in the place's order (most recent first). Pure. */
export function pickFollowUpItems(items: readonly UnhandledItem[]): UnhandledItem[] {
  return items.filter((item) => item.askCount < MAX_UNHANDLED_ASKS).slice(0, MAX_FOLLOW_UP_ITEMS);
}

/**
 * The follow-up for this answer, with its asks already counted, or null when
 * there is nothing to ask. A failed count is no follow-up: an ask that was not
 * counted is never shown.
 */
export async function followUpFor(uid: string, options: { now: Date }): Promise<CaptureChatFollowUp | null> {
  const { items } = await listUnhandled(uid, { now: options.now });
  const picked = pickFollowUpItems(items);
  if (picked.length === 0) return null;
  try {
    await recordUnhandledAsked(uid, picked.map((item) => item.commitment.id), { now: options.now });
  } catch {
    return null;
  }
  return {
    items: picked.map((item) => ({
      commitmentId: item.commitment.id,
      title: item.commitment.title,
      reason: item.reason,
      since: item.since,
    })),
  };
}
