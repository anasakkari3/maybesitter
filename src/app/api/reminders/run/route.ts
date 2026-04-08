import { runDueReminders } from '@/server/reminderRunner';

export const dynamic = 'force-dynamic';

export async function POST() {
  return Response.json(await runDueReminders());
}
