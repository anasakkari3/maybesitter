import type { Commitment, DomainEvent } from '../../src/domain/stateMachine';
import {
  EVENTS,
  COMMITMENTS,
  INTELLIGENCE_OBSERVATIONS,
  getStorage,
  userCol,
  userDoc,
  type StorageAdapter,
  type StorageReader,
  type StorageTransaction,
} from '../storage';
import { personalizationGrowthAllowed } from '../consents/personalizationConsentService';
import { loadDomainState } from '../services/mobile/participantState';
import { purgeOf } from '../personalization/purgeFence';
import { resolveMemoryLearning } from '../release/m5bCapabilities';
import {
  observationId,
  observationPath,
  putReaddMarkerInTransaction,
  type StoredObservation,
} from './observationStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const READD_PREFIX = 'readd:';

export const COMMITMENT_OUTCOME_EVENT_TYPES = {
  completed: 'commitment_completed',
  postponed: 'commitment_postponed',
  dropped: 'commitment_dropped',
} as const;

export const READD_PROMPT_LINE = 'Re-added means the person added again something they dropped or finished; a hint it still matters, never proof.';

type ReaddAfter = 'dropped' | 'completed';
type CommitmentMap = Readonly<Record<string, Commitment>>;
type OutcomeCommitment = ReadonlyMap<string, string>;

export interface ReaddProjection {
  after: ReaddAfter;
  title: string;
}

export interface ReaddSuggestionLike {
  observationIds: readonly string[];
}

export function clientSupportsReadd(request: Request): boolean {
  return (request.headers.get('X-MaybeSitter-Client-Features') ?? '')
    .split(',')
    .some(feature => feature.trim().toLowerCase() === 'readd');
}

export function isReaddMarker(value: unknown): value is StoredObservation & { matchedOutcomeId: string } {
  const row = value as Partial<StoredObservation> | null;
  return row?.source === 'behavior'
    && row.kind === 'outcome'
    && typeof row.sourceRef === 'string'
    && row.sourceRef.startsWith(READD_PREFIX)
    && typeof row.matchedOutcomeId === 'string';
}

export function readdKey(title: string): string {
  return title.normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0640\u064b-\u065f\u0670\u06d6-\u06ed]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function afterOfOutcome(outcome: StoredObservation): ReaddAfter | null {
  if (/^Dropped: /.test(outcome.evidence)) return 'dropped';
  if (/^Completed: /.test(outcome.evidence)) return 'completed';
  return null;
}

function eventAfter(type: string): ReaddAfter | null {
  if (type === COMMITMENT_OUTCOME_EVENT_TYPES.dropped) return 'dropped';
  if (type === COMMITMENT_OUTCOME_EVENT_TYPES.completed) return 'completed';
  return null;
}

function safeEventPath(uid: string, sourceRef: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(sourceRef) ? `${userCol(uid, EVENTS)}/${sourceRef}` : null;
}

/** Resolve learned outcomes through the persisted event that names D. */
export async function resolveOutcomeCommitments(
  uid: string,
  outcomes: readonly StoredObservation[],
  reader: StorageReader,
): Promise<Map<string, string>> {
  const candidates = outcomes.filter(outcome => outcome.source === 'behavior'
    && outcome.kind === 'outcome' && !isReaddMarker(outcome) && afterOfOutcome(outcome));
  const refs = Array.from(new Set(candidates.map(outcome => outcome.sourceRef)));
  const paths = refs.map(ref => safeEventPath(uid, ref));
  const validPaths = paths.filter((path): path is string => path !== null);
  const loaded = reader.getMany
    ? await reader.getMany<DomainEvent>(validPaths)
    : await Promise.all(validPaths.map(path => reader.get<DomainEvent>(path)));
  const byPath = new Map(validPaths.map((path, index) => [path, loaded[index] ?? null]));
  const result = new Map<string, string>();
  for (const outcome of candidates) {
    const path = safeEventPath(uid, outcome.sourceRef);
    const event = path ? byPath.get(path) : null;
    const after = afterOfOutcome(outcome);
    if (!event || !after || eventAfter(event.type) !== after || typeof event.aggregateId !== 'string' || !event.aggregateId) continue;
    result.set(outcome.id, event.aggregateId);
  }
  return result;
}

/** The single live projection used by both the inbox and model context. */
export function projectReadd(
  marker: unknown,
  commitments: CommitmentMap,
  outcomes: readonly StoredObservation[],
  outcomeCommitment: OutcomeCommitment,
): ReaddProjection | null {
  if (!isReaddMarker(marker) || marker.review === 'dismissed') return null;
  const commitmentId = marker.sourceRef.slice(READD_PREFIX.length);
  const commitment = commitments[commitmentId];
  const outcome = outcomes.find(row => row.id === marker.matchedOutcomeId);
  if (!commitment || !outcome || outcome.review !== 'confirmed') return null;
  const after = afterOfOutcome(outcome);
  const earlierId = outcomeCommitment.get(outcome.id);
  const earlier = earlierId ? commitments[earlierId] : undefined;
  if (!after || !earlier || readdKey(commitment.title) !== readdKey(earlier.title)) return null;
  return { after, title: commitment.title };
}

function markerId(commitmentId: string): string {
  return observationId('behavior', `${READD_PREFIX}${commitmentId}`, {
    kind: 'outcome', evidence: 'Re-added', confidence: 0.6,
  });
}

/** Separate from outcome learning: it always sees stored outcomes and current commitments. */
export async function learnReadds(
  uid: string,
  storage: StorageAdapter = getStorage(),
  now = new Date().toISOString(),
): Promise<StoredObservation[]> {
  const user = await storage.get(userDoc(uid));
  const purge = purgeOf(user);
  if (purge.state !== 'active') return [];
  if (!(await personalizationGrowthAllowed(uid, { storage }))) return [];
  const since = new Date(Date.parse(now) - 60 * DAY_MS).toISOString();
  const [state, rows] = await Promise.all([
    loadDomainState(storage, uid),
    storage.list<StoredObservation>(userCol(uid, INTELLIGENCE_OBSERVATIONS), {
      where: [['observedAt', '>=', since]],
    }),
  ]);
  const observations = rows.map(row => row.data);
  const outcomeCommitment = await resolveOutcomeCommitments(uid, observations, storage);
  const newestConfirm = Date.parse(now) - 30 * DAY_MS;
  const purgeCutoff = purge.completedAt && Number.isFinite(Date.parse(purge.completedAt))
    ? Date.parse(purge.completedAt) : Number.NEGATIVE_INFINITY;
  const existing = new Set(observations.filter(isReaddMarker).map(row => row.id));
  const candidates: Array<{ commitment: Commitment; outcome: StoredObservation }> = [];
  for (const commitment of Object.values(state.commitments)) {
    const confirmed = commitment.confirmedAt ? Date.parse(commitment.confirmedAt) : Number.NaN;
    if (!Number.isFinite(confirmed) || confirmed < newestConfirm || confirmed > Date.parse(now)
      || existing.has(markerId(commitment.id))) continue;
    const matches = observations.filter(outcome => {
      if (outcome.review !== 'confirmed' || !afterOfOutcome(outcome) || isReaddMarker(outcome)) return false;
      const observed = Date.parse(outcome.observedAt);
      if (!Number.isFinite(observed) || observed <= purgeCutoff
        || observed < confirmed - 30 * DAY_MS || observed >= confirmed) return false;
      const earlierId = outcomeCommitment.get(outcome.id);
      const earlier = earlierId ? state.commitments[earlierId] : undefined;
      return Boolean(earlier && readdKey(earlier.title) === readdKey(commitment.title));
    }).sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id));
    if (matches[0]) candidates.push({ commitment, outcome: matches[0] });
  }
  candidates.sort((a, b) => b.commitment.confirmedAt!.localeCompare(a.commitment.confirmedAt!)
    || a.commitment.id.localeCompare(b.commitment.id));
  const written: StoredObservation[] = [];
  for (const candidate of candidates.slice(0, 20)) {
    const marker = await putReaddMarkerInTransaction(
      uid,
      candidate.commitment.id,
      candidate.commitment.confirmedAt!,
      candidate.outcome.id,
      purge.epoch,
      storage,
    );
    if (marker) written.push(marker);
  }
  return written;
}

export interface ReaddPolicy {
  readonly markerIds: ReadonlySet<string>;
  readonly projections: ReadonlyMap<string, ReaddProjection>;
  readonly allowsSuggestion: (suggestion: ReaddSuggestionLike) => boolean;
  readonly inboxObservations: (rows?: readonly StoredObservation[]) => Array<StoredObservation | (StoredObservation & { readd: ReaddProjection })>;
  readonly modelObservations: (rows: readonly StoredObservation[]) => StoredObservation[];
}

/** Central visibility policy for flag, client capability and bound-outcome validity. */
export async function resolveReaddPolicy(
  uid: string,
  observations: readonly StoredObservation[],
  clientSupported: boolean,
  storage: StorageAdapter = getStorage(),
  commitments?: CommitmentMap,
): Promise<ReaddPolicy> {
  const markers = observations.filter(isReaddMarker);
  const markerIds = new Set(markers.map(marker => marker.id));
  const projections = new Map<string, ReaddProjection>();
  if (markers.length > 0 && resolveMemoryLearning() && clientSupported) {
    const stateCommitments = commitments ?? (await loadDomainState(storage, uid)).commitments;
    const outcomeCommitment = await resolveOutcomeCommitments(uid, observations, storage);
    for (const marker of markers) {
      const projection = projectReadd(marker, stateCommitments, observations, outcomeCommitment);
      if (projection) projections.set(marker.id, projection);
    }
  }
  const allowsSuggestion = (suggestion: ReaddSuggestionLike) => suggestion.observationIds.every(id =>
    !markerIds.has(id) || projections.has(id));
  return {
    markerIds,
    projections,
    allowsSuggestion,
    inboxObservations: (rows = observations) => rows.flatMap(observation => {
      if (!markerIds.has(observation.id)) return [observation];
      const readd = projections.get(observation.id);
      return readd ? [{ ...observation, readd }] : [];
    }),
    modelObservations: rows => rows.flatMap(observation => {
      if (!markerIds.has(observation.id)) return [observation];
      const readd = projections.get(observation.id);
      return readd ? [{ ...observation, evidence: `Re-added after ${readd.after}: ${readd.title}`, confidence: 0.6 }] : [];
    }),
  };
}

/** Transactional claim guard for the exact outcome bound into every cited marker. */
export async function readdCitationsAllowedInTransaction(
  tx: StorageTransaction,
  uid: string,
  cited: readonly (StoredObservation | null)[],
  clientSupported: boolean,
): Promise<boolean> {
  const markers = cited.filter(isReaddMarker);
  if (markers.length === 0) return true;
  if (!resolveMemoryLearning() || !clientSupported) return false;
  const outcomes = await Promise.all(markers.map(marker => tx.get<StoredObservation>(observationPath(uid, marker.matchedOutcomeId))));
  const events = await Promise.all(outcomes.map(outcome => {
    const path = outcome ? safeEventPath(uid, outcome.sourceRef) : null;
    return path ? tx.get<DomainEvent>(path) : Promise.resolve(null);
  }));
  const commitmentPairs = await Promise.all(markers.map(async (marker, index) => {
    const event = events[index];
    const currentId = marker.sourceRef.slice(READD_PREFIX.length);
    if (!event || typeof event.aggregateId !== 'string') return [null, null] as const;
    return Promise.all([
      tx.get<Commitment>(`${userCol(uid, COMMITMENTS)}/${currentId}`),
      tx.get<Commitment>(`${userCol(uid, COMMITMENTS)}/${event.aggregateId}`),
    ]);
  }));
  return markers.every((marker, index) => {
    const outcome = outcomes[index];
    const event = events[index];
    const [current, earlier] = commitmentPairs[index] ?? [null, null];
    const after = outcome ? afterOfOutcome(outcome) : null;
    return marker.review !== 'dismissed'
      && outcome?.review === 'confirmed'
      && outcome.source === 'behavior'
      && outcome.kind === 'outcome'
      && !isReaddMarker(outcome)
      && Boolean(event && after && eventAfter(event.type) === after)
      && Boolean(current && earlier && readdKey(current.title) === readdKey(earlier.title));
  });
}
