import {
  ANALYTICS_EVENT_CONTRACT_VERSION,
  ANALYTICS_EVENT_NAMES,
  type AnalyticsEventName,
  type AnalyticsValidationResult,
  type PrivacySafeAnalyticsEvent,
} from '../../src/contracts/v1/analyticsEventContracts';
import { RATING_SCALE, isRating } from '../../src/contracts/v1/experimentContracts';

const SEED_KIND_VALUES = new Set(['consideration', 'waiting_for', 'idea', 'possible_goal']);
const PROMOTED_TO_VALUES = new Set(['commitment', 'goal']);

const EVENT_PROPERTIES: Record<AnalyticsEventName, readonly string[]> = {
  capture_submitted: ['inputLength', 'locale'],
  // #519. A count of what was offered, never what was offered.
  seed_proposed: ['proposedCount'],
  seed_confirmed: ['seedKind'],
  seed_snoozed: ['seedKind', 'hasRevisitAt'],
  seed_promoted: ['seedKind', 'promotedToKind'],
  seed_dismissed: ['seedKind'],
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
  // No properties at all: which screens somebody saw on the way through
  // onboarding is not something worth knowing about them (#171).
  onboarding_completed: [],
  calendar_connect_started: ['provider'],
  calendar_connected: ['provider'],
  data_deleted: ['deletionScope'],
  pricing_viewed: ['surface'],
  purchase_intent: ['priceCents', 'currency'],
  recommendation_rated: ['proposalId', 'utilityRating', 'invasivenessRating'],
  voice_capture_started: [
    'source', 'locale',
    'flagWidget', 'flagVoice', 'flagAwareness', 'flagWatch', 'flagImports',
  ],
  voice_capture_completed: [
    'source', 'locale', 'inputLength',
    'flagWidget', 'flagVoice', 'flagAwareness', 'flagWatch', 'flagImports',
  ],
  voice_capture_abandoned: [
    'source', 'locale', 'reason', 'inputLength',
    'flagWidget', 'flagVoice', 'flagAwareness', 'flagWatch', 'flagImports',
  ],
  widget_impression: [
    'surface', 'widgetFamily', 'widgetState',
    'flagWidget', 'flagVoice', 'flagAwareness', 'flagWatch', 'flagImports',
  ],
  widget_tap: [
    'surface', 'targetRoute',
    'flagWidget', 'flagVoice', 'flagAwareness', 'flagWatch', 'flagImports',
  ],
  deep_link_opened: [
    'source', 'targetRoute',
    'flagWidget', 'flagVoice', 'flagAwareness', 'flagWatch', 'flagImports',
  ],
  // Presence, intake, and awareness signals. Property names for the five
  // events below are taken from the factory constructors in
  // mobile/lib/models/pilot_loop_analytics.dart; each also carries the five
  // feature flags via flagProperties().
  //
  // widget_snapshot_published is the exception: it is named in the contract
  // and client-reportable, but nothing emits it yet — there is no factory for
  // it in PilotLoopAnalyticsEventName. These two properties are a provisional,
  // deliberately content-free guess. Whoever writes the emitter should confirm
  // them rather than assume they were derived from a real call site.
  widget_snapshot_published: [
    'surface', 'itemCount',
    'flagWidget', 'flagVoice', 'flagAwareness', 'flagWatch', 'flagImports',
  ],
  source_intake_reviewed: [
    'importSource', 'characterCount',
    'flagWidget', 'flagVoice', 'flagAwareness', 'flagWatch', 'flagImports',
  ],
  source_intake_confirmed: [
    'importSource', 'characterCount',
    'flagWidget', 'flagVoice', 'flagAwareness', 'flagWatch', 'flagImports',
  ],
  pilot_feedback_submitted: [
    'feedbackSurface', 'usefulness', 'annoyance', 'timing',
    'flagWidget', 'flagVoice', 'flagAwareness', 'flagWatch', 'flagImports',
  ],
  soft_awareness_action: [
    'action',
    'flagWidget', 'flagVoice', 'flagAwareness', 'flagWatch', 'flagImports',
  ],
  soft_awareness_missed: [
    'outcome',
    'flagWidget', 'flagVoice', 'flagAwareness', 'flagWatch', 'flagImports',
  ],
  first_value_reached: ['surface', 'reason'],
  // UC-2.R2 (#172). Counts, and deliberately nothing that could carry what
  // somebody wrote: no title, no item ids, no proposal id.
  //
  // `confirmedCount` is how many commitments the confirm actually left
  // confirmed in the user's own state. `undoneCount` and `stillSavedCount`
  // split an undo the same way the screen does, because an undo that half
  // worked is the outcome worth being able to count.
  capture_confirmed: ['confirmedCount'],
  capture_undone: ['undoneCount', 'stillSavedCount'],
  // UC-3.10b (#195). Shapes, not contents: how much was in the plan, which
  // generation it was, and what the person did about it.
  //
  // `explanationSource` is deliberately not called `source` — `source` is
  // canonicalised against SOURCE_VALUES below, and 'model'/'template' are a
  // different question from 'app'/'widget'/'external'. Sharing the name would
  // have meant either a wrong rejection or a widened enumeration.
  //
  // `reason` on an edit is the server's own refusal code (`overlaps_fixed_event`
  // and its siblings), which says why a placement was refused without saying
  // what was being placed.
  plan_opened: ['generation', 'scheduledCount', 'unscheduledCount', 'explanationSource', 'status'],
  plan_accepted: ['generation', 'scheduledCount', 'unscheduledCount'],
  plan_edited: ['movedCount', 'removedCount', 'outcome', 'reason'],
  plan_regenerated: ['generation'],
  plan_dismissed: ['generation'],
  // UC-3.17 (#469). How many of the five setup questions were answered — a
  // count, never the answers. `answeredCount` is held to an integer 0-5 below
  // for the same reason ratings are: a "count" that accepted any number or a
  // string would be a field that could carry something else.
  onboarding_setup_answered: ['answeredCount'],
};

const RATING_KEYS = ['utilityRating', 'invasivenessRating'];
/** The setup chat has five questions; the count of answered ones is 0-5. */
const SETUP_QUESTION_COUNT = 5;
const PRIVATE_KEY = /(raw|message|text|title|description|person|email|phone|prompt|content)/i;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const TARGET_ROUTES = new Set(['capture', 'today', 'commitment_detail']);
const SOURCE_VALUES = new Set(['app', 'widget', 'external']);

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
      if (key === 'targetRoute' && (typeof property !== 'string' || !TARGET_ROUTES.has(property))) errors.push(`targetRoute is not canonical: ${String(property)}`);
      if (key === 'source' && (typeof property !== 'string' || !SOURCE_VALUES.has(property))) errors.push(`source is not canonical: ${String(property)}`);
      if (RATING_KEYS.includes(key) && !isRating(property)) errors.push(`rating must be an integer ${RATING_SCALE.minimum}-${RATING_SCALE.maximum}: ${key}`);
      // Closed sets, checked rather than trusted: a `seedKind` that is really
      // a fragment of somebody's sentence is exactly the leak these events are
      // shaped to make impossible, and a string field with no value check is
      // how that stops being true later (#519).
      if (key === 'seedKind' && (typeof property !== 'string' || !SEED_KIND_VALUES.has(property))) {
        errors.push(`seedKind is not a known seed kind: ${String(property)}`);
      }
      if (key === 'promotedToKind' && (typeof property !== 'string' || !PROMOTED_TO_VALUES.has(property))) {
        errors.push(`promotedToKind is not commitment or goal: ${String(property)}`);
      }
      if (key === 'proposedCount' && !(Number.isInteger(property) && (property as number) >= 0)) {
        errors.push(`proposedCount must be a non-negative integer: ${String(property)}`);
      }
      if (key === 'answeredCount' && !(Number.isInteger(property) && (property as number) >= 0 && (property as number) <= SETUP_QUESTION_COUNT)) {
        errors.push(`answeredCount must be an integer 0-${SETUP_QUESTION_COUNT}: ${String(property)}`);
      }
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
