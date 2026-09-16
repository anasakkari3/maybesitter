/**
 * Suggestions on read, and what Keep and "Not right" do (UC-3.16, #202).
 *
 * ── Nothing persists without the user's say-so ───────────────────
 *
 * `listMemorySuggestions` reads and writes nothing. A suggestion is recomputed
 * on every read from the event log and exists only in the response. It becomes
 * a memory record only through `decideMemorySuggestion` with `keep`, and that
 * call recomputes the suggestion itself rather than trusting what the phone
 * sends back: the body names a fingerprint and a language, and everything that
 * is stored — the sentence, the confidence, the evidence, the source — comes
 * from the rule run again on the server. A fingerprint the server would no
 * longer suggest is refused as stale, so an old screen cannot keep a claim the
 * data stopped supporting.
 *
 * ── Consent ──────────────────────────────────────────────────────
 *
 * Growth is personalization, and it is off unless personalization consent
 * (`lib/personalizationControls/consentStore.ts`) reads `enabled`. That store
 * fails closed: never asked, unreadable or disabled all read as off. Listing,
 * editing and deleting memory are not gated — they are how a person sees and
 * removes what is held, and those must work whatever they have agreed to.
 *
 * The planner's use of a kept window is gated on the same consent, in
 * `keptFocusWindow`: withdrawing consent stops behaviour-derived memory from
 * shaping the next plan without deleting what the user chose to keep.
 *
 * ── Already answered ─────────────────────────────────────────────
 *
 * A suggestion is not offered if its fingerprint was dismissed, or if any
 * active record already carries it — kept as-is, or kept and then rewritten
 * in the user's own words. Either way the user has answered that claim.
 */
import type {
  MemoryLanguage,
  RuntimeMemoryRecord,
  RuntimeMemoryStore,
} from '../../src/contracts/v1/memoryContracts';
import {
  createStoragePersonalizationConsentStore,
  type PersonalizationConsentStore,
} from '../personalizationControls/consentStore';
import { createStorageRuntimeMemoryStore } from '../runtimeMemory/runtimeMemoryStore';
import { listEventsInRange } from '../services/mobile/eventLog';
import { memoryToDto, type MemoryDto } from '../services/mobile/memoryService';
import { normalizeTimezone } from '../services/mobile/time';
import { getStorage, requireUserId, userDoc, type StorageAdapter } from '../storage';
import { isMemoryGrowthRuleId, readDismissedFingerprint, recordDismissal } from './dismissals';
import {
  R1_FOCUS_WINDOW,
  R1_LOOKBACK_DAYS,
  parseFocusWindowFingerprint,
  suggestFocusWindow,
  type CompletionObservation,
  type FocusWindowSuggestion,
  type LocalWindow,
} from './rules';
import { KEPT_SUGGESTION_LANGUAGES, keptFocusWindowContent, type KeptSuggestionLanguage } from './templates';

/**
 * How many events one read may scan for R1.
 *
 * The range read is ordered oldest first, so a truncated read would silently
 * drop the *newest* completions and describe an old habit as a current one.
 * A read that fills this bound yields no suggestion rather than a skewed one.
 */
export const GROWTH_EVENT_READ_LIMIT = 2_000;

const MS_PER_DAY = 86_400_000;

/** What the phone receives. The evidence ids stay on the server. */
export interface MemorySuggestionDto {
  ruleId: typeof R1_FOCUS_WINDOW;
  fingerprint: string;
  window: LocalWindow;
  confidence: number;
  evidence: { matchingCount: number; totalCount: number; lookbackDays: number };
}

export interface MemoryGrowthOptions {
  storage?: StorageAdapter;
  memory?: RuntimeMemoryStore;
  consent?: PersonalizationConsentStore;
}

export class MemorySuggestionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemorySuggestionValidationError';
  }
}

export class UnknownMemoryRuleError extends Error {
  constructor() {
    super('unknown memory rule');
    this.name = 'UnknownMemoryRuleError';
  }
}

export class MemorySuggestionConsentError extends Error {
  constructor() {
    super('personalization consent is required for suggestions');
    this.name = 'MemorySuggestionConsentError';
  }
}

export class MemorySuggestionStaleError extends Error {
  constructor() {
    super('that suggestion is no longer offered');
    this.name = 'MemorySuggestionStaleError';
  }
}

function storageOf(options: MemoryGrowthOptions): StorageAdapter {
  return options.storage ?? getStorage();
}

function memoryOf(options: MemoryGrowthOptions): RuntimeMemoryStore {
  return options.memory ?? createStorageRuntimeMemoryStore(undefined, options.storage);
}

async function consentGranted(uid: string, options: MemoryGrowthOptions): Promise<boolean> {
  const store = options.consent ?? createStoragePersonalizationConsentStore(options.storage);
  return (await store.read(uid)).state === 'enabled';
}

function toDto(suggestion: FocusWindowSuggestion): MemorySuggestionDto {
  return {
    ruleId: suggestion.ruleId,
    fingerprint: suggestion.fingerprint,
    window: { start: suggestion.window.start, end: suggestion.window.end },
    confidence: suggestion.confidence,
    evidence: {
      matchingCount: suggestion.matchingCount,
      totalCount: suggestion.totalCount,
      lookbackDays: suggestion.lookbackDays,
    },
  };
}

/** Every suggestion the rules would make now, before consent and answers. */
async function computeRuleSuggestions(
  uid: string,
  now: string,
  storage: StorageAdapter,
): Promise<FocusWindowSuggestion[]> {
  const user = await storage.get<{ timezone?: unknown }>(userDoc(uid));
  const timezone = normalizeTimezone(user?.timezone);
  const from = new Date(Date.parse(now) - R1_LOOKBACK_DAYS * MS_PER_DAY).toISOString();
  const events = await listEventsInRange(uid, from, now, GROWTH_EVENT_READ_LIMIT, storage);
  if (events.length >= GROWTH_EVENT_READ_LIMIT) return [];

  const completions: CompletionObservation[] = [];
  events.forEach((event) => {
    if (event.type !== 'commitment_completed') return;
    if (typeof event.aggregateId !== 'string' || event.aggregateId === '') return;
    completions.push({ id: event.id, at: event.at, commitmentId: event.aggregateId });
  });

  const r1 = suggestFocusWindow(completions, timezone, now);
  return r1 ? [r1] : [];
}

/** Suggestions still worth offering: consented, not dismissed, not already held. */
async function openSuggestions(
  uid: string,
  now: string,
  options: MemoryGrowthOptions,
): Promise<FocusWindowSuggestion[]> {
  const storage = storageOf(options);
  const candidates = await computeRuleSuggestions(uid, now, storage);
  if (candidates.length === 0) return [];

  const held = new Set<string>();
  (await memoryOf(options).retrieve({ scopeId: uid, now })).forEach((record) => {
    if (record.provenance?.origin === 'behaviour_rule' && record.provenance.originRef) {
      held.add(record.provenance.originRef);
    }
  });

  const open: FocusWindowSuggestion[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (held.has(candidate.fingerprint)) continue;
    if ((await readDismissedFingerprint(storage, uid, candidate.ruleId)) === candidate.fingerprint) continue;
    open.push(candidate);
  }
  return open;
}

/**
 * What MaybeSitter could suggest it noticed, right now. Writes nothing.
 *
 * Empty without personalization consent — checked first, so an account that
 * has not agreed does not even have its event log read for this.
 */
export async function listMemorySuggestions(
  uid: string,
  now: string,
  options: MemoryGrowthOptions = {},
): Promise<MemorySuggestionDto[]> {
  requireUserId(uid);
  if (!(await consentGranted(uid, options))) return [];
  return (await openSuggestions(uid, now, options)).map(toDto);
}

export interface MemorySuggestionDecisionInput {
  decision: unknown;
  fingerprint: unknown;
  language?: unknown;
}

export type MemorySuggestionDecision =
  | { decision: 'keep'; memory: MemoryDto }
  | { decision: 'dismiss' };

export async function decideMemorySuggestion(
  uid: string,
  ruleId: unknown,
  input: MemorySuggestionDecisionInput,
  now: string,
  options: MemoryGrowthOptions = {},
): Promise<MemorySuggestionDecision> {
  requireUserId(uid);
  if (!isMemoryGrowthRuleId(ruleId)) throw new UnknownMemoryRuleError();
  const decision = input.decision;
  if (decision !== 'keep' && decision !== 'dismiss') {
    throw new MemorySuggestionValidationError('decision must be keep or dismiss');
  }
  let language: KeptSuggestionLanguage | null = null;
  if (decision === 'keep') {
    if (typeof input.language !== 'string' || !(KEPT_SUGGESTION_LANGUAGES as readonly string[]).includes(input.language)) {
      throw new MemorySuggestionValidationError(`language must be one of ${KEPT_SUGGESTION_LANGUAGES.join(', ')}`);
    }
    language = input.language as KeptSuggestionLanguage;
  }
  if (!(await consentGranted(uid, options))) throw new MemorySuggestionConsentError();

  const current = (await openSuggestions(uid, now, options))
    .find((suggestion) => suggestion.ruleId === ruleId && suggestion.fingerprint === input.fingerprint);
  if (!current) throw new MemorySuggestionStaleError();

  if (decision === 'dismiss') {
    await recordDismissal(storageOf(options), uid, current.fingerprint, now);
    return { decision: 'dismiss' };
  }

  const store = memoryOf(options);
  const record = {
    scopeId: uid,
    kind: 'preference' as const,
    content: keptFocusWindowContent(current.window, language!),
    language: language! as MemoryLanguage,
    source: 'deterministic_rule' as const,
    confidence: current.confidence,
    observedAt: now,
    evidenceIds: current.evidenceIds,
    exportPolicy: 'personal_never_export' as const,
    provenance: { origin: 'behaviour_rule' as const, originRef: current.fingerprint, confirmedByUserAt: now },
  };

  // One kept window per rule. A new window the user keeps replaces the one they
  // kept before, as a supersession, so the planner never has two to choose from
  // and the earlier claim stays in the chain a delete removes.
  const previous = (await activeRuleRecords(store, uid, now))
    .filter((existing) => existing.provenance?.originRef?.split(':')[0] === ruleId);
  const saved = previous.length > 0
    ? await store.supersede(previous[0]!.id, record, now)
    : await store.put(record, now);
  return { decision: 'keep', memory: memoryToDto(saved) };
}

/** Active records a rule produced and the user kept unedited, newest first. */
async function activeRuleRecords(
  store: RuntimeMemoryStore,
  uid: string,
  now: string,
): Promise<RuntimeMemoryRecord[]> {
  return (await store.retrieve({ scopeId: uid, now }))
    .filter((record) => record.source === 'deterministic_rule' && record.provenance?.origin === 'behaviour_rule')
    .sort((left, right) => (
      Date.parse(right.createdAt) - Date.parse(left.createdAt)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    ));
}

/**
 * The focus window the user kept from R1, for the daily plan — or null.
 *
 * Only an unedited, rule-produced record counts: once the user rewrites the
 * sentence it is theirs, and their words are not a window this code may parse.
 * Null without personalization consent, and null for a fingerprint this
 * version cannot read.
 */
export async function keptFocusWindow(
  uid: string,
  now: string,
  options: MemoryGrowthOptions = {},
): Promise<LocalWindow | null> {
  requireUserId(uid);
  if (!(await consentGranted(uid, options))) return null;
  const records = await activeRuleRecords(memoryOf(options), uid, now);
  for (let index = 0; index < records.length; index += 1) {
    const window = parseFocusWindowFingerprint(records[index]!.provenance?.originRef);
    if (window) return window;
  }
  return null;
}
