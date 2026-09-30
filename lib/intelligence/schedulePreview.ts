import type { TimeInterval, PlanningItem } from '../../src/contracts/v1/planningContracts';
import { getStorage, userDoc, type StorageAdapter } from '../storage';
import { composeDailyPlanRequest, readPlanSettings } from '../services/dailyPlan/dailyPlanService';
import { addCivilDays } from '../services/dailyPlan/weekHolds';
import { localDateOf } from '../services/dailyPlan/planSettings';
import { schedulePlan } from '../planning/scheduler';
import type { IntelligenceSuggestion } from './proposalEngine';
import { listObservations } from './observationStore';

export interface SuggestionSchedulePreview {
  suggestionId: string;
  slot: TimeInterval | null;
  reason: string | null;
}

/** Preview against the real daily planner's current commitments, busy time and routine. */
export async function previewSuggestionSchedule(
  uid: string,
  suggestions: readonly IntelligenceSuggestion[],
  now: string,
  storage: StorageAdapter = getStorage(),
): Promise<SuggestionSchedulePreview[]> {
  const actions = suggestions.filter(item => item.kind === 'action' && item.status === 'pending' && item.durationMinutes);
  if (actions.length === 0) return [];
  const settings = await readPlanSettings(uid, { storage });
  const userDocument = await storage.get(userDoc(uid));
  const observations = new Map((await listObservations(uid, storage)).map(item => [item.id, item]));
  const today = localDateOf(now, settings.timezone);
  const unplaced = new Map(actions.map(action => [action.id, action]));
  const result = new Map<string, SuggestionSchedulePreview>();
  for (const date of [today, addCivilDays(today, 1)]) {
    if (unplaced.size === 0) break;
    const request = await composeDailyPlanRequest({
      uid, date, timezone: settings.timezone, now, userDocument, previousBlocks: null,
    }, { storage });
    const hypothetical: PlanningItem[] = Array.from(unplaced.values())
      .filter(item => date === today || !item.observationIds.some(id => observations.get(id)?.kind === 'event'))
      .map(item => ({
      itemId: `suggestion:${item.id}`, title: item.title,
      effort: { kind: 'known', minutes: item.durationMinutes as number },
      earliestStartAt: date === today ? now : null, deadlineAt: null, priority: 50,
      dependsOn: [], bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
    }));
    const plan = schedulePlan({ ...request.constraints, items: [...request.constraints.items, ...hypothetical] }, request.config);
    for (const placed of plan.scheduled) {
      if (!placed.itemId.startsWith('suggestion:')) continue;
      const id = placed.itemId.slice('suggestion:'.length);
      if (!unplaced.has(id)) continue;
      result.set(id, { suggestionId: id, slot: placed.interval, reason: null });
      unplaced.delete(id);
    }
    for (const missed of plan.unscheduled) {
      if (!missed.itemId.startsWith('suggestion:')) continue;
      const id = missed.itemId.slice('suggestion:'.length);
      if (unplaced.has(id)) result.set(id, { suggestionId: id, slot: null, reason: missed.reason.code });
    }
  }
  return actions.map(action => result.get(action.id) ?? { suggestionId: action.id, slot: null, reason: 'NO_SLOT' });
}
