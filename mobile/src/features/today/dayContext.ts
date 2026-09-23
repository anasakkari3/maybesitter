import type { Commitment } from '../../api/schemas/common';
import type { DailyPlan } from '../../api/schemas/plan';
import { dayKey } from '../../i18n/format';
import { toViewModel } from '../commitments/model';

export interface PlanPreviewItem {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  state: 'done' | 'next' | 'planned' | 'proposed';
}

/** A plan's slots are not evidence of completion or of work happening now.
 * Join only to current records; omit missing/dropped records, preserve proposal
 * status, and call the first open accepted slot “next in plan”, never “now”. */
export function planPreview(plan: DailyPlan | null | undefined, records: readonly Commitment[]): PlanPreviewItem[] {
  if (!plan || plan.status === 'dismissed') return [];
  const byId = new Map(records.map(item => [item.id, item]));
  const seen = new Set<string>();
  let hasNext = false;
  return [...plan.scheduled]
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .flatMap(slot => {
      const item = byId.get(slot.itemId);
      if (!item || seen.has(item.id)) return [];
      seen.add(item.id);
      const status = toViewModel(item, plan.generatedAt).status;
      if (status === 'dropped') return [];
      const state = status === 'done' ? 'done'
        : plan.status !== 'accepted' ? 'proposed'
        : !hasNext ? 'next' : 'planned';
      if (status === 'active') hasNext = true;
      return [{ id: item.id, title: item.title, startsAt: slot.startsAt, endsAt: slot.endsAt, state } as PlanPreviewItem];
    }).slice(0, 4);
}

/** Count actual completions on this local day, never drops or old completions. */
export function dayProgress(records: readonly Commitment[], date: string, timezone: string) {
  const unique = [...new Map(records.map(item => [item.id, item])).values()];
  const done = unique.filter(item => item.status === 'completed' && item.completedAt
    && dayKey(new Date(item.completedAt), timezone) === date).length;
  const open = unique.filter(item => toViewModel(item, item.updatedAt).status === 'active').length;
  return done > 0 && done + open > 1 ? { done, total: done + open } : null;
}

/** One user-marked important deadline within the explicitly queried day keys.
 * Reminders and scheduled events are not deadlines. No workload/free-time claim
 * is made from partial calendar coverage or from inferred importance. */
export function importantDeadline(records: readonly Commitment[], keys: readonly string[], timezone: string): Commitment | null {
  const days = new Set(keys);
  return records.filter(item => toViewModel(item, item.updatedAt).status === 'active'
    && item.priority.level === 'high' && item.priority.source === 'user_explicit'
    && item.timeSpec.kind === 'due_by' && item.timeSpec.dueAt
    && days.has(dayKey(new Date(item.timeSpec.dueAt), timezone)))
    .sort((a, b) => Date.parse(a.timeSpec.dueAt!) - Date.parse(b.timeSpec.dueAt!))[0] ?? null;
}
