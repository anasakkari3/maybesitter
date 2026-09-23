import { apiRequest } from '../client';
import { habitChangedSchema, habitDeletedSchema, habitListSchema, type Habit, type NewHabitInput } from '../schemas/habits';

const path = (id?: string) => `/api/mobile/habits${id ? `/${encodeURIComponent(id)}` : ''}`;

export async function listHabits(): Promise<readonly Habit[]> {
  const response = await apiRequest('GET', path(), { schema: habitListSchema });
  return response.items;
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
