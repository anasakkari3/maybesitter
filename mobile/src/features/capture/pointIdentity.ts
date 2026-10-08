import type { CaptureProposal, UnderstoodPoint } from '../../api/schemas/capture';

/**
 * A point's identity across the four families (M3b, contract v8).
 *
 * The server mints a new family id when a point changes family — a habit
 * turned into a commitment gets an `itemId` — and keeps one `pointId` for it
 * the whole way (R2-011). Choices the person made (selection, staged
 * edits) follow the `pointId`, so a card they took out stays out after it
 * changes kind. A proposal from an older server, or with the feature off,
 * has no `pointId`; there the family id stands in for it, which is exactly
 * how the app behaved before (R3-003).
 */
export type PointTarget = { itemId: string } | { seedItemId: string } | { habitItemId: string } | { goalItemId: string };

export function familyIdOf(target: PointTarget): string {
  if ('itemId' in target) return target.itemId;
  if ('seedItemId' in target) return target.seedItemId;
  if ('habitItemId' in target) return target.habitItemId;
  return target.goalItemId;
}

/** Every point of a proposal with its family target and logical id, in family order. */
export function pointsOf(proposal: CaptureProposal): Array<{ pointId: string; target: PointTarget }> {
  return [
    ...(proposal.items ?? []).map((item) => ({ pointId: item.pointId ?? item.itemId, target: { itemId: item.itemId } as PointTarget })),
    ...(proposal.seeds ?? []).map((seed) => ({ pointId: seed.pointId ?? seed.seedItemId, target: { seedItemId: seed.seedItemId } as PointTarget })),
    ...(proposal.habits ?? []).map((habit) => ({ pointId: habit.pointId, target: { habitItemId: habit.habitItemId } as PointTarget })),
    ...(proposal.goals ?? []).map((goal) => ({ pointId: goal.pointId, target: { goalItemId: goal.goalItemId } as PointTarget })),
  ];
}

/** The logical id of the point a family id names in this proposal; the family id itself when unknown. */
export function pointIdFor(proposal: CaptureProposal | null, familyId: string): string {
  if (!proposal) return familyId;
  return pointsOf(proposal).find((point) => familyIdOf(point.target) === familyId)?.pointId ?? familyId;
}

/** The family target of a logical point in this proposal, or null when it is gone. */
export function targetForPoint(proposal: CaptureProposal | null, pointId: string): PointTarget | null {
  if (!proposal) return null;
  return pointsOf(proposal).find((point) => point.pointId === pointId)?.target ?? null;
}

/** Whether a family id still names a point of the proposal. */
export function hasPoint(proposal: CaptureProposal, familyId: string): boolean {
  return pointsOf(proposal).some((point) => familyIdOf(point.target) === familyId);
}

/** The family id an understood line points at. */
export function familyIdOfLine(point: UnderstoodPoint): string {
  if ('itemId' in point) return point.itemId;
  if ('seedItemId' in point) return point.seedItemId;
  if ('habitItemId' in point) return point.habitItemId;
  return point.goalItemId;
}
