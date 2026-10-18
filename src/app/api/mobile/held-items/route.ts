import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { listHeldFixtures } from '../../../../../lib/football/projectFixtures';
import { resolveExternalClashHold } from '../../../../../lib/release/m4bCapabilities';
import { listHeldIcsItems } from '../../../../../lib/calendar/icsFeeds';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  if (!resolveExternalClashHold()) return Response.json({ success: false, error: 'feature_unavailable' }, { status: 404 });
  const [football, ics] = await Promise.all([listHeldFixtures(user.uid), listHeldIcsItems(user.uid)]);
  const items = [
    ...football.held.map((row) => ({ source: 'football' as const, id: row.fixtureId, title: `${row.homeTeamName} – ${row.awayTeamName}`, startsAt: row.kickoffUtc })),
    ...ics.map((row) => ({ source: 'ics' as const, ...row })),
  ].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return Response.json({ success: true, count: items.length, items: items.slice(0, 20) });
}
