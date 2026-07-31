import type { AnalyticsEventName, PrivacySafeAnalyticsEvent } from '../../src/contracts/v1/analyticsEventContracts';
import { requireValidAnalyticsEvent } from './privacySafeEvents';

const FUNNEL: AnalyticsEventName[] = ['capture_submitted', 'commitment_detected', 'commitment_confirmed', 'recommendation_shown', 'recommendation_accepted', 'recommendation_completed'];
const ACTIVITY = new Set<AnalyticsEventName>(['capture_submitted', 'commitment_confirmed', 'recommendation_accepted', 'recommendation_completed']);
const DAY = 86400000;

export interface ProductMetricsReport {
  totalUsers: number;
  activatedUsers: number;
  activationRate: number;
  funnel: Record<string, number>;
  retention: { week4Eligible: number; week4Retained: number; week4Rate: number; week8Eligible: number; week8Retained: number; week8Rate: number };
  consent: { calendarStarted: number; calendarConnected: number; deletions: number };
}

function rate(numerator: number, denominator: number): number {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 0;
}

export function buildProductMetricsReport(values: readonly unknown[], reportAt: Date): ProductMetricsReport {
  const events = values.map(requireValidAnalyticsEvent).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.eventId.localeCompare(b.eventId));
  const users = new Set(events.map((event) => event.anonymousUserId));
  const usersFor = (name: AnalyticsEventName) => new Set(events.filter((event) => event.eventName === name).map((event) => event.anonymousUserId));
  const confirmed = usersFor('commitment_confirmed');
  const shown = usersFor('recommendation_shown');
  const activated = new Set(Array.from(confirmed).filter((user) => shown.has(user)));
  const firstActivity = new Map<string, number>();
  for (const event of events.filter((item) => ACTIVITY.has(item.eventName))) {
    const at = Date.parse(event.occurredAt);
    if (!firstActivity.has(event.anonymousUserId)) firstActivity.set(event.anonymousUserId, at);
  }
  const retained = (week: number) => {
    const eligible = Array.from(firstActivity.entries()).filter(([, first]) => reportAt.getTime() - first >= week * 7 * DAY);
    const count = eligible.filter(([user, first]) => events.some((event) => event.anonymousUserId === user && ACTIVITY.has(event.eventName) && Date.parse(event.occurredAt) >= first + week * 7 * DAY && Date.parse(event.occurredAt) < first + (week + 1) * 7 * DAY)).length;
    return { eligible: eligible.length, retained: count, rate: rate(count, eligible.length) };
  };
  const week4 = retained(4);
  const week8 = retained(8);
  return {
    totalUsers: users.size,
    activatedUsers: activated.size,
    activationRate: rate(activated.size, users.size),
    funnel: Object.fromEntries(FUNNEL.map((name) => [name, usersFor(name).size])),
    retention: { week4Eligible: week4.eligible, week4Retained: week4.retained, week4Rate: week4.rate, week8Eligible: week8.eligible, week8Retained: week8.retained, week8Rate: week8.rate },
    consent: { calendarStarted: usersFor('calendar_connect_started').size, calendarConnected: usersFor('calendar_connected').size, deletions: events.filter((event) => event.eventName === 'data_deleted').length },
  };
}
