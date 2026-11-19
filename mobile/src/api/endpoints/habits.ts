import { apiRequest } from '../client';
import {
  habitChangedSchema,
  habitDeletedSchema,
  habitListSchema,
  habitOutcomeSchema,
  habitUndoSchema,
  type Habit,
  type HabitOccurrenceDecision,
  type HabitOccurrenceRef,
  type HabitOutcome,
  type HabitToday,
  type HabitUndo,
  type NewHabitInput,
} from '../schemas/habits';

const path = (id?: string) => `/api/mobile/habits${id ? `/${encodeURIComponent(id)}` : ''}`;

export async function listHabits(): Promise<readonly Habit[]> {
  const response = await apiRequest('GET', path(), { schema: habitListSchema });
  return response.items;
}

/** Today's occurrences, on the caller's local date (CA5.4); null from a server that sends none. */
export async function listHabitsToday(timezone: string): Promise<HabitToday | null> {
  const response = await apiRequest('GET', `${path()}?timezone=${encodeURIComponent(timezone)}`, { schema: habitListSchema });
  return response.today ?? null;
}

/**
 * «تمّت» or «مش اليوم» on one occurrence. A repeat answers 200 unchanged, so a
 * retried press is safe; a reversal answers 409 and is shown, not retried.
 */
export function decideHabitOccurrence(decision: HabitOccurrenceDecision, timezone: string): Promise<HabitOutcome> {
  const verb = decision.outcome === 'completed' ? 'complete' : 'skip';
  return apiRequest('POST', `${path(decision.habitId)}/occurrences/${encodeURIComponent(decision.occurrenceId)}/${verb}?timezone=${encodeURIComponent(timezone)}`, {
    body: {},
    schema: habitOutcomeSchema,
  });
}

/**
 * «تراجع» on a decided day (QA v3, V3-F23-02): the day is open again and takes
 * either answer. A repeat answers 200 unchanged; a skip whose make-up date was
 * already decided answers 409 and is shown, not retried.
 */
export function undoHabitOccurrence(ref: HabitOccurrenceRef, timezone: string): Promise<HabitUndo> {
  return apiRequest('POST', `${path(ref.habitId)}/occurrences/${encodeURIComponent(ref.occurrenceId)}/undo?timezone=${encodeURIComponent(timezone)}`, {
    body: {},
    schema: habitUndoSchema,
  });
}

export async function createHabit(input: NewHabitInput, timezone: string): Promise<Habit> {
  const response = await apiRequest('POST', `${path()}?timezone=${encodeURIComponent(timezone)}`, {
    body: input,
    schema: habitChangedSchema,
    expectStatus: 201,
  });
  return response.habit;
}

export async function setHabitStatus(id: string, status: Habit['status'], timezone: string): Promise<Habit> {
  const response = await apiRequest('PATCH', `${path(id)}?timezone=${encodeURIComponent(timezone)}`, {
    body: { status },
    schema: habitChangedSchema,
  });
  return response.habit;
}

export async function deleteHabit(id: string): Promise<string> {
  const response = await apiRequest('DELETE', path(id), { schema: habitDeletedSchema });
  return response.habitId;
}
