import type { DailyPlan } from '../../api/schemas/plan';
import type { PlanEdit } from '../../api/endpoints/plans';

/**
 * The plan as it would look if the server said yes (UC-3.10b, #195).
 *
 * ── Why an optimistic update at all ──────────────────────────────
 *
 * Elsewhere in this app an optimistic update is refused on purpose: a consent
 * switch must never show a position the server has not agreed to, because it is
 * a claim about somebody's privacy. A plan is the opposite — it is a proposal
 * the user is rearranging, the drag has already happened under their finger,
 * and snapping back after a round trip reads as the app undoing them.
 *
 * So the move lands immediately and is **put back exactly** when the server
 * refuses. `usePlanEdit` keeps the pre-edit plan and restores it on error; this
 * function is the forward half, and it is pure so the rollback has something to
 * be the inverse of.
 *
 * ── It mirrors the server's own arithmetic, and no more ──────────
 *
 * `effectiveSchedule` in `lib/services/dailyPlan/planActions.ts` removes,
 * moves, then sorts by start. This does the same three things. It deliberately
 * does **not** re-validate: whether a placement is allowed is decided against
 * the constraints the plan was built from, which the client is not given and
 * must not guess at. A client-side "that looks busy to me" would refuse moves
 * the server would have accepted, and would still have to handle the 422.
 */
export function applyEditLocally(plan: DailyPlan, edit: PlanEdit): DailyPlan {
  const removed = new Set(edit.removals ?? []);
  const moves = new Map((edit.moves ?? []).map(move => [move.itemId, move]));

  const scheduled = plan.scheduled
    .filter(item => !removed.has(item.itemId))
    .map(item => {
      const move = moves.get(item.itemId);
      return move ? { ...item, startsAt: move.startsAt, endsAt: move.endsAt } : item;
    })
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));

  // `edited` is the server's flag for "the user has moved or removed
  // something", and the screen reads it. Setting it here keeps the optimistic
  // plan the same shape as the one that comes back, so nothing flickers when
  // the real answer arrives.
  return { ...plan, scheduled, edited: true };
}

/**
 * A move that keeps the length the planner gave the item.
 *
 * `endsAt` is computed here and always sent. The route would infer it from an
 * absent `endsAt`, but then the optimistic copy on screen and the document on
 * the server would be computing the same number in two places — and the one on
 * screen would be the one nobody tested.
 */
export function moveKeepingLength(
  item: { itemId: string; startsAt: string; endsAt: string },
  startsAt: Date,
): { itemId: string; startsAt: string; endsAt: string } {
  const lengthMs = Date.parse(item.endsAt) - Date.parse(item.startsAt);
  return {
    itemId: item.itemId,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + lengthMs).toISOString(),
  };
}
