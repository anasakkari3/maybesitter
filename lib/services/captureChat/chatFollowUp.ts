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
 *   - at most `MAX_FOLLOW_UP_ITEMS` item in it;
 *   - no item asked about more than `MAX_UNHANDLED_ASKS` times;
 *   - a dismissed item is never in the place, so it is never asked about.
 *
 * ── It never breaks the chat ─────────────────────────────────────
 *
 * The question is extra. A read of the place that fails, or takes longer
 * than `FOLLOW_UP_READ_TIMEOUT_MS`, or a turn with less than
 * `FOLLOW_UP_MIN_BUDGET_MS` of its budget left, is simply no question.
 *
 * ── The order of the writes ──────────────────────────────────────
 *
 * The conversation is saved first, holding `followUpAskedAt` and the answer
 * that carries the question; only then is the ask counted
 * (`countFollowUpAsked`). A conversation that could not be saved sent no
 * answer, so nothing is counted. A count that fails after the save still
 * leaves the question shown: one ask too few is better than a cap reached by
 * questions the person never saw.
 *
 * Two devices at once: two conversations can both read an item at one ask,
 * both show it and both count it, so it ends at three. That is accepted, not
 * fixed: the counter is a ceiling on nagging, not a ledger, and closing the
 * race would need a transaction around the whole chat turn.
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

/** One item in the one question (owner review, 2026-11-19). */
export const MAX_FOLLOW_UP_ITEMS = 1;
/** How long the place may take to read before the turn answers without a question. */
export const FOLLOW_UP_READ_TIMEOUT_MS = 500;
/** Less of the turn's budget left than this, and no question is looked for. */
export const FOLLOW_UP_MIN_BUDGET_MS = 1_500;

export interface CaptureChatFollowUpItem {
  commitmentId: string;
  title: string;
  reason: UnhandledReason;
  /** When it ended, or when the deadline passed. */
  since: string;
  /** The instant whose day the phone names: an all-day item's own day (`UnhandledAnchor.shownAt`). */
  shownAt: string;
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
 * The follow-up for this answer, or null. Never throws and never waits longer
 * than `FOLLOW_UP_READ_TIMEOUT_MS`; writes nothing.
 */
export async function followUpFor(
  uid: string,
  options: { now: Date; budgetLeftMs: number },
): Promise<CaptureChatFollowUp | null> {
  if (options.budgetLeftMs < FOLLOW_UP_MIN_BUDGET_MS) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const listed = await Promise.race([
      listUnhandled(uid, { now: options.now }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), FOLLOW_UP_READ_TIMEOUT_MS); }),
    ]);
    if (!listed) return null;
    const picked = pickFollowUpItems(listed.items);
    if (picked.length === 0) return null;
    return {
      items: picked.map((item) => ({
        commitmentId: item.commitment.id,
        title: item.commitment.title,
        reason: item.reason,
        since: item.since,
        shownAt: item.shownAt,
      })),
    };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Counts the ask, after the conversation carrying it was saved. Never throws. */
export async function countFollowUpAsked(uid: string, followUp: CaptureChatFollowUp, options: { now: Date }): Promise<void> {
  try {
    await recordUnhandledAsked(uid, followUp.items.map((item) => item.commitmentId), { now: options.now });
  } catch {
    // The question was shown; a missing count only means one more ask later.
  }
}
