import {
  ANALYTICS_EVENT_CONTRACT_VERSION,
  ANALYTICS_EVENT_NAMES,
  type AnalyticsEventName,
  type AnalyticsValidationResult,
  type PrivacySafeAnalyticsEvent,
} from '../../src/contracts/v1/analyticsEventContracts';
import { RATING_SCALE, isRating } from '../../src/contracts/v1/experimentContracts';

const EVENT_PROPERTIES: Record<AnalyticsEventName, readonly string[]> = {
  capture_submitted: ['inputLength', 'locale'],
  commitment_detected: ['commitmentId', 'detectionSource'],
  commitment_confirmed: ['commitmentId'],
  commitment_edited: ['commitmentId', 'changedFieldCount'],
  recommendation_shown: ['proposalId', 'commitmentId', 'baselineVersion', 'latencyMs', 'costMicros'],
  recommendation_accepted: ['proposalId'],
  recommendation_edited: ['proposalId', 'changedFieldCount'],
  recommendation_deferred: ['proposalId', 'deferMinutes'],
  recommendation_dismissed: ['proposalId'],
  recommendation_completed: ['proposalId', 'commitmentId'],
  reason_opened: ['proposalId'],
  calendar_connect_started: ['provider'],
  calendar_connected: ['provider'],
  data_deleted: ['deletionScope'],
  pricing_viewed: ['surface'],
  purchase_intent: ['priceCents', 'currency'],
  recommendation_rated: ['proposalId', 'utilityRating', 'invasivenessRating'],
};

const RATING_KEYS = ['utilityRating', 'invasivenessRating'];
const PRIVATE_KEY = /(raw|message|text|title|description|person|email|phone|prompt|content)/i;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export function validateAnalyticsEvent(value: unknown): AnalyticsValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['event must be an object'] };
  const event = value as Record<string, unknown>;
  const top = ['version', 'eventId', 'eventName', 'occurredAt', 'anonymousUserId', 'cohortId', 'experiment', 'consent', 'properties'];
  for (const key of Object.keys(event)) if (!top.includes(key)) errors.push(`unknown top-level field: ${key}`);
  if (event.version !== ANALYTICS_EVENT_CONTRACT_VERSION) errors.push('unsupported version');
  if (!ANALYTICS_EVENT_NAMES.includes(event.eventName as AnalyticsEventName)) errors.push('unknown eventName');
  for (const key of ['eventId', 'anonymousUserId', 'cohortId']) {
    if (typeof event[key] !== 'string' || !ID.test(event[key] as string)) errors.push(`${key} is invalid`);
  }
  if (typeof event.occurredAt !== 'string' || Number.isNaN(Date.parse(event.occurredAt))) errors.push('occurredAt is invalid');
  if (event.consent !== 'granted' && event.consent !== 'essential') errors.push('consent is invalid');
  if (event.consent === 'essential' && event.eventName !== 'data_deleted') errors.push('analytics consent is required');
  if (event.experiment !== null) {
    const experiment = event.experiment as Record<string, unknown>;
    if (!experiment || typeof experiment !== 'object' || !ID.test(String(experiment.experimentId || '')) || !ID.test(String(experiment.arm || ''))) errors.push('experiment is invalid');
  }
  if (!event.properties || typeof event.properties !== 'object' || Array.isArray(event.properties)) {
    errors.push('properties must be an object');
  } else if (ANALYTICS_EVENT_NAMES.includes(event.eventName as AnalyticsEventName)) {
    const allowed = EVENT_PROPERTIES[event.eventName as AnalyticsEventName];
    for (const [key, property] of Object.entries(event.properties as Record<string, unknown>)) {
      if (!allowed.includes(key)) errors.push(`property is not allowed for ${String(event.eventName)}: ${key}`);
      if (PRIVATE_KEY.test(key)) errors.push(`private property is forbidden: ${key}`);
      if (!['string', 'number', 'boolean'].includes(typeof property) && property !== null) errors.push(`property must be scalar: ${key}`);
      if (typeof property === 'string' && property.length > 128) errors.push(`property is too long: ${key}`);
      if (RATING_KEYS.includes(key) && !isRating(property)) errors.push(`rating must be an integer ${RATING_SCALE.minimum}-${RATING_SCALE.maximum}: ${key}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function requireValidAnalyticsEvent(value: unknown): PrivacySafeAnalyticsEvent {
  const validation = validateAnalyticsEvent(value);
  if (!validation.valid) throw new Error(validation.errors.join('; '));
  return value as PrivacySafeAnalyticsEvent;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function assignExperiment(anonymousUserId: string, experimentId: string, arms: readonly string[]): { experimentId: string; arm: string } {
  if (!ID.test(anonymousUserId) || !ID.test(experimentId) || arms.length < 2 || arms.some((arm) => !ID.test(arm))) throw new Error('valid user, experiment, and at least two arms are required');
  return { experimentId, arm: arms[stableHash(`${experimentId}:${anonymousUserId}`) % arms.length] };
}

export function cohortFor(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function applyUserDeletion(events: readonly PrivacySafeAnalyticsEvent[], anonymousUserId: string): PrivacySafeAnalyticsEvent[] {
  return events.filter((event) => event.anonymousUserId !== anonymousUserId || event.eventName === 'data_deleted');
}
