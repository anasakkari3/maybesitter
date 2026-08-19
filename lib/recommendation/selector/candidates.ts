/**
 * Candidate generation and the deterministic hard filters (Sprint 08, issue #34).
 *
 * This file owns three things and nothing else: the shape of a selection
 * request, the evidence graph that request produces, and the verdict on which
 * candidates a hard constraint removes. Ranking, diversity and risk live in
 * `policy.ts`; assembly of the offer lives in `select.ts`. The split is the one
 * `lib/planning` uses between `constraints/` and `scheduler/`, for the same
 * reason: a filter that could also rank would be a place for the ranking to
 * silently become a filter.
 *
 * ── Relationship to the shipped V03 pilot ────────────────────────────────
 *
 * `lib/services/nextStepBaseline.ts` already decides eligibility for the
 * `/api/next-step` surface. Nothing here imports it and nothing here changes
 * it. Where the two decide the same question the relationship is stated at the
 * rule, one of **same rule**, **deliberately stricter**, or **superset** — and a
 * merge-owned cross-track test compares the two on the same inputs, so an
 * unintended difference is a defect rather than a style choice.
 *
 * The summary, so the relationship can be read in one place:
 *
 *   | question                  | pilot                              | here                          |
 *   |---------------------------|------------------------------------|-------------------------------|
 *   | closed statuses           | completed / dropped / archived     | **same rule**, same three     |
 *   | confirmation              | `confirmedAt !== null`             | **same rule**                 |
 *   | effective time            | `dueAt \|\| remindAt`              | **same rule**, same falsiness |
 *   | invalid time              | `Number.isNaN(Date.parse(raw))`    | **same rule**, same predicate |
 *   | blocked by a dependency   | no concept                         | **deliberately stricter**     |
 *   | exclusion vocabulary      | one nullable field                 | **superset**, a non-empty list|
 *   | evidence sufficiency      | `eligible && labels.length > 0`    | **deliberately stricter**     |
 *
 * The three shared hard filters are computed from the *same predicates* rather
 * than from predicates that happen to agree today. `Date.parse` is used for the
 * time check specifically because the pilot uses it: a stricter ISO parser here
 * would reject `"August 3, 2026"` that the pilot accepts, and the cross-track
 * comparison would report a disagreement that is really a difference of
 * leniency. Sprint 06's recorded cost of two implementations of one mechanism
 * was four review rounds; the cheapest way to not pay it again is to share the
 * predicate's *definition* even when the code cannot be shared.
 *
 * ── Why the ids in this file are hashes ──────────────────────────────────
 *
 * Evidence node ids are `sha256(commitmentId)`-prefixed rather than either the
 * commitment id itself or a positional index.
 *
 *   - Not the id: a `nodeId` is exempt from the id rule only because it has its
 *     own typed field, and the exemption is narrow. Node ids end up inside
 *     `derivedFrom`, `supportedBy`, `basis` and `attested`, which are the fields
 *     most likely to be logged whole. A digest is sensitive to the id without
 *     being readable as one, exactly as `lib/planning/scheduler/digest.ts`
 *     folds a title in as its own hash.
 *   - Not a positional index: an index into the canonical candidate list moves
 *     when an unrelated commitment is added, so every node id in a stored
 *     recommendation would change and `evaluateRecommendationStaleness` would
 *     report `SOURCE_UNVERIFIABLE` for all of them. Failing closed is right when
 *     a source really is unverifiable and is noise when it is not.
 *
 * ── No ambient clock ─────────────────────────────────────────────────────
 *
 * Every instant in this module arrives in the input. There is no `Date.now()`,
 * no zero-argument `new Date()`, no `Math.random()` and no `randomUUID`;
 * `tests/recommendation/selectorBoundaries.test.ts` reads the source and
 * enforces it, because a determinism test that ran twice in the same
 * millisecond would pass against a module that read a clock.
 */

import { createHash } from 'node:crypto';

import {
  LIFE_STATE_SOURCE_FIELDS,
  RECOMMENDATION_CONTRACT_VERSION,
  RECOMMENDATION_SCHEMA_VERSION,
  evaluateRecommendationStaleness,
  type CommitmentSourceField,
  type DerivationRuleCode,
  type DerivedEvidence,
  type EvidenceCategory,
  type EvidenceClaim,
  type EvidenceGraph,
  type EvidenceNode,
  type EvidenceNodeId,
  type ExclusionReasonCode,
  type Instant,
  type ObservedEvidence,
  type Recommendation,
  type TrustedSource,
} from '../../../src/contracts/v1/recommendationContracts';
import type { LifeState, LoadBand } from '../../../src/contracts/v1/lifeStateContracts';
import type { PriorityScore } from '../../../src/contracts/v1/priorityContracts';
import type { Plan, TimeInterval } from '../../../src/contracts/v1/planningContracts';
// The one string ordering this repo sorts by. Never `localeCompare`, whose
// result depends on the runtime's ICU data and default locale — an offer's
// order, and therefore every `optionIndex` a decision targets, would change
// with `LANG`. The pilot uses `localeCompare` in two places; that is a known
// pre-existing defect recorded in the roadmap, not a precedent.
import { compareByCodePoint } from '../../planning/shared/compare';

/* ── The request ─────────────────────────────────────────────────── */

/**
 * The commitment lifecycle, restated as a closed union rather than imported
 * from `src/domain/stateMachine`.
 *
 * `stateMachine` is a writer module: `tests/recommendation/selectorBoundaries.test.ts`
 * forbids this module's import closure from reaching it, on the same terms
 * `lib/planning` is forbidden. Restating the union is not the Sprint 06
 * duplicate-arithmetic hazard — it is a vocabulary, not a computation, and the
 * `CLOSED_COMMITMENT_STATUSES` set below is the only judgement made over it.
 */
export type CommitmentLifecycleStatus =
  | 'draft'
  | 'needs_clarification'
  | 'pending_confirmation'
  | 'active'
  | 'deferred'
  | 'missed'
  | 'completed'
  | 'dropped'
  | 'archived';

/**
 * Statuses a hard filter treats as finished.
 *
 * **Same rule as the pilot**, whose `CLOSED` set in `nextStepBaseline.ts` is
 * these same three. `missed` is deliberately *not* here, matching
 * `OPEN_COMMITMENT_STATUSES` in `lifeStateContracts`: a missed commitment is
 * live work, and excluding it would hide exactly the items a user most needs a
 * next step for.
 */
/** Every status this module knows how to read. An unknown one is refused. */
export const KNOWN_COMMITMENT_STATUSES = Object.freeze([
  'draft',
  'needs_clarification',
  'pending_confirmation',
  'active',
  'deferred',
  'missed',
  'completed',
  'dropped',
  'archived',
] as const) satisfies readonly CommitmentLifecycleStatus[];

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

export const CLOSED_COMMITMENT_STATUSES = Object.freeze([
  'completed',
  'dropped',
  'archived',
] as const) satisfies readonly CommitmentLifecycleStatus[];

/**
 * One commitment as this module reads it.
 *
 * `planItemId`, `decompositionProposalId` and `decompositionStepId` are stated
 * per commitment rather than as a `Record` keyed by commitment id. A record's
 * key order is not part of its value but *is* part of its serialisation, and
 * Sprint 07 shipped a determinism defect of exactly that shape — a plan echoing
 * a caller's object by reference so key order leaked into the output. A field on
 * a row cannot leak an order because a row has no order.
 *
 * `blockedByCommitmentIds` names commitments this one must wait for. See
 * `resolveBlockers` for why an id naming nothing in this request does not block.
 */
export interface CommitmentSnapshot {
  readonly commitmentId: string;
  readonly status: CommitmentLifecycleStatus;
  /** Null when the user has not confirmed it. See the `NOT_CONFIRMED` filter. */
  readonly confirmedAt: Instant | null;
  readonly dueAt: Instant | null;
  readonly remindAt: Instant | null;
  readonly importance: 'low' | 'normal' | 'high' | null;
  readonly blockedByCommitmentIds: readonly string[];
  /** The `PlannedItem.itemId` this commitment was planned as, or null. */
  readonly planItemId: string | null;
  readonly decompositionProposalId: string | null;
  readonly decompositionStepId: string | null;
}

/**
 * Everything a selection run reads.
 *
 * `lifeState` is required, not nullable, and the requirement is structural
 * rather than convenient. `OptionSet`'s `only_candidate` variant needs
 * `attested` evidence that nothing else existed, and a `WithheldRecommendation`
 * needs evidence for "there is nothing for you to do". Sprint 02's projection is
 * the only source in this repo that distinguishes known-zero from unknown, so
 * without it those two claims would be the one place decision 1 had to be
 * carved out for — and a carve-out in the empty case is a carve-out in the case
 * a new user sees first.
 *
 * `recommendationId` is supplied. This module mints no identifiers: two runs
 * over the same input must agree on every field, and a generated id is the one
 * field that can never agree.
 */
export interface RecommendationSelectorInput {
  readonly scopeId: string;
  readonly recommendationId: string;
  /** The instant every judgement in the run is made against. */
  readonly now: Instant;
  readonly lifeState: LifeState;
  readonly commitments: readonly CommitmentSnapshot[];
  readonly priorityScores: readonly PriorityScore[];
  readonly plan: Plan | null;
}

/**
 * Input this module refuses rather than reports.
 *
 * `RECOMMENDATION_INPUT_POLICY.throwOnlyWhenNoCodeApplies` is the rule, and the
 * bar is high: a malformed `dueAt` has a code (`INVALID_SOURCE_TIME`) and comes
 * back as a finding, and a non-finite priority total simply contributes nothing.
 * What is left are the three conditions the taxonomy has no word for, each of
 * which makes the *whole run* meaningless rather than one candidate wrong:
 *
 *   - a `now` that does not parse — every judgement is made against it;
 *   - a duplicated `commitmentId` — `actionKey`, the ordering's final key and
 *     every evidence node id would be ambiguous, so the run would double-book
 *     one commitment while looking complete;
 *   - a duplicated `commitmentId` among `priorityScores` — the same ambiguity
 *     one input over;
 *   - a commitment with no usable id, or a status outside the known lifecycle —
 *     the first makes every evidence node about it unaddressable, the second
 *     makes eligibility unreadable, and defaulting either way is a guess about
 *     the user's state;
 *   - an unusable `config` value. `ttlMinutes: NaN` used to escape as a raw
 *     `TypeError` from instant arithmetic several frames down, `1e15` as a raw
 *     `RangeError`, and `-120` produced a recommendation valid at no instant at
 *     all with zero reported defects — `EXPIRY_NOT_AFTER_BASIS` is a staleness
 *     code, so `checkRecommendation` cannot see it. Each was invisible to a
 *     typed caller and immediate at the untyped boundary, which is the exact
 *     shape `PLANNING_INPUT_POLICY` records three instances of.
 *
 * This mirrors `lib/planning/scheduler`, which reports a `NaN` buffer and
 * throws on a duplicated `itemId`, and it is deliberately not extended: the
 * temptation is to add "and a blank scope id", at which point the policy has
 * quietly inverted.
 */
export type RecommendationInputField = 'now' | 'commitments' | 'priorityScores' | 'config';

export class RecommendationInputError extends Error {
  readonly field: RecommendationInputField;

  constructor(field: RecommendationInputField, message: string) {
    super(message);
    this.name = 'RecommendationInputError';
    this.field = field;
  }
}

/* ── Instants ────────────────────────────────────────────────────── */

/**
 * A recommendation that exists only to be handed to the contract's own instant
 * validator. See `isContractInstant`.
 *
 * Its graph is empty, so no fingerprint finding can be produced, and its window
 * is well-formed, so the only `INVALID_INSTANT` it can ever report is about the
 * `now` under test.
 */
const INSTANT_PROBE: Recommendation = {
  version: RECOMMENDATION_CONTRACT_VERSION,
  schema: RECOMMENDATION_SCHEMA_VERSION,
  recommendationId: 'instant-probe',
  scopeId: 'instant-probe',
  validity: { basisAt: '1970-01-01T00:00:00.000Z', expiresAt: '9999-12-31T23:59:59.000Z' },
  evidence: { nodes: [] },
  inputDigest: '',
  outcome: 'withheld',
  reasons: [
    {
      code: 'INSUFFICIENT_EVIDENCE',
      supportedBy: ['instant-probe'],
      detail: 'this value is never offered; it exists to reuse the contract instant check',
    },
  ],
};

/**
 * Is this string an `Instant` as the contract defines one?
 *
 * **The definition is delegated, not copied.** #33 added `INSTANT_PATTERN` —
 * requiring an explicit `Z` or `±HH:MM` offset before `Date.parse` is reached —
 * because an offset-less date-time is host-local under the ECMAScript rule, so
 * a verdict moves with `TZ`. This module had the same hole: the same request
 * produced `OVERDUE / 0.9` under `TZ=UTC` and `DUE_SOON / 0.7` under
 * `TZ=America/Los_Angeles` **with an identical `inputDigest`**, so the replay
 * check said "same input" across two different recommendations.
 *
 * The ruling is reject, not normalise. `INSTANT_PATTERN` is `const` and not on
 * the contract's export surface, so it cannot be cited by name; re-spelling the
 * regex here would be a second definition of "what is a valid instant", which
 * is the duplication this sprint keeps paying for. So this asks the contract
 * instead — `evaluateRecommendationStaleness` runs the shape check and reports
 * `INVALID_INSTANT` on `field: 'now'` — and the answer can only ever be the
 * contract's. Exporting `INSTANT_PATTERN`, or a one-line `isInstant`, would let
 * this collapse to a single call; that is a request filed against #33, and until
 * it lands this indirection is the version with no second copy in it.
 */
export function isContractInstant(value: string): boolean {
  const verdict = evaluateRecommendationStaleness({
    recommendation: INSTANT_PROBE,
    now: value,
    currentFingerprints: {},
  });
  if (verdict.fresh) return true;
  for (let index = 0; index < verdict.reasons.length; index += 1) {
    const reason = verdict.reasons[index];
    if (reason.code === 'INVALID_INSTANT' && reason.field === 'now') return false;
  }
  return true;
}

/**
 * Epoch millis, or null when the value is not a well-formed `Instant`.
 *
 * A local non-throwing parse rather than `lib/planning/shared/time#toEpochMs`,
 * which throws — and this module's whole job at that moment is to *report* an
 * unusable time as `INVALID_SOURCE_TIME`.
 *
 * The shape is checked **before** `Date.parse`, because `Date.parse` accepts a
 * superset of `Instant` and reads the host zone for the part of that superset
 * carrying no offset.
 *
 * This is where this module and the shipped pilot **deliberately diverge**, and
 * the direction is the safe one. The pilot calls `Date.parse` bare, so it
 * accepts `'2026-08-19T11:00:00'` and reads it as host-local. This module
 * rejects it as `INVALID_SOURCE_TIME`. The cross-track comparison in
 * `selectorCandidates.test.ts` pins the divergence to exactly that class — every
 * instant carrying an explicit offset is judged identically by both — so the
 * difference is a stated one rather than a surprise at merge.
 */
export function epochMsOrNull(value: string | null): number | null {
  if (value === null || typeof value !== 'string') return null;
  if (!isContractInstant(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The time a candidate is judged against.
 *
 * **Same rule as the pilot**, down to the falsiness: `nextStepBaseline.ts`
 * writes `candidate.dueAt || candidate.remindAt`, so an empty-string `dueAt`
 * falls through to `remindAt` rather than being read as a present-but-broken
 * due date. Written the same way here on purpose — the two must agree about
 * which field they read before they can agree about whether it parses.
 */
export function effectiveTimeSource(snapshot: CommitmentSnapshot): {
  readonly raw: string | null;
  readonly field: CommitmentSourceField;
} {
  const raw = snapshot.dueAt || snapshot.remindAt || null;
  return { raw, field: snapshot.dueAt ? 'due_at' : 'remind_at' };
}

/* ── Node identity and fingerprints ──────────────────────────────── */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A short, stable, unreadable handle for a commitment. See the header. */
function commitmentHandle(commitmentId: string): string {
  return sha256Hex(`commitment ${commitmentId}`).slice(0, 16);
}

/**
 * An opaque digest of a value that was read.
 *
 * `ObservedEvidence.valueFingerprint` must be non-empty
 * (`EMPTY_FINGERPRINT`), and this always produces 64 hex characters. The field
 * tag is folded in so two fields holding the same value do not produce the same
 * fingerprint — otherwise a commitment whose `status` and `importance` both read
 * `"high"` would have one of them change and the other report unchanged.
 */
function fingerprint(tag: string, parts: readonly (string | number | boolean | null)[]): string {
  return sha256Hex(`${tag} ${parts.map((part) => JSON.stringify(part)).join(' ')}`);
}

/* ── The claim vocabulary, applied ───────────────────────────────── */

function statusCategory(status: CommitmentLifecycleStatus): EvidenceCategory {
  return (CLOSED_COMMITMENT_STATUSES as readonly string[]).includes(status)
    ? 'status_closed'
    : 'status_open';
}

function importanceCategory(level: 'low' | 'normal' | 'high'): EvidenceCategory {
  if (level === 'high') return 'importance_high';
  if (level === 'normal') return 'importance_normal';
  return 'importance_low';
}

function loadCategory(band: LoadBand): EvidenceCategory {
  if (band === 'overloaded') return 'load_overloaded';
  if (band === 'heavy') return 'load_heavy';
  if (band === 'moderate') return 'load_moderate';
  return 'load_light';
}

/* ── Evidence assembly ───────────────────────────────────────────── */

/**
 * The graph under construction.
 *
 * Nodes are appended in the order they are built and the order is the graph's
 * order, which is what `checkEvidenceGraph`, `resolveEvidenceRoots` and
 * `evaluateRecommendationStaleness` all sort their findings by. Nothing here
 * sorts nodes afterwards: the build order is already canonical because the
 * candidates were put in canonical order first, so a second ordering pass would
 * be a second statement of the same thing.
 */
class EvidenceBuilder {
  private readonly nodes: EvidenceNode[] = [];

  private readonly seen = new Set<EvidenceNodeId>();

  observe(
    nodeId: EvidenceNodeId,
    source: TrustedSource,
    claim: EvidenceClaim,
    observedAt: Instant | null,
    valueFingerprint: string,
  ): EvidenceNodeId {
    if (this.seen.has(nodeId)) return nodeId;
    this.seen.add(nodeId);
    this.nodes.push({ kind: 'observed', nodeId, source, claim, observedAt, valueFingerprint });
    return nodeId;
  }

  derive(
    nodeId: EvidenceNodeId,
    rule: DerivationRuleCode,
    claim: EvidenceClaim,
    derivedFrom: readonly [EvidenceNodeId, ...EvidenceNodeId[]],
  ): EvidenceNodeId {
    if (this.seen.has(nodeId)) return nodeId;
    this.seen.add(nodeId);
    this.nodes.push({ kind: 'derived', nodeId, rule, claim, derivedFrom });
    return nodeId;
  }

  graph(): EvidenceGraph {
    return { nodes: this.nodes.slice() };
  }
}

/* ── Scope-level evidence ────────────────────────────────────────── */

/** The scope-wide nodes every run emits, whatever the outcome. */
export interface ScopeEvidence {
  /** The projection's commitments view. Attests "nothing else existed". */
  readonly commitmentsNodeId: EvidenceNodeId;
  /** The projection's load view. */
  readonly loadNodeId: EvidenceNodeId;
  /** Derived load band, or null when the projection reported load unknown. */
  readonly capacityNodeId: EvidenceNodeId | null;
}

function buildScopeEvidence(builder: EvidenceBuilder, lifeState: LifeState): ScopeEvidence {
  const commitments = lifeState.commitments;
  const commitmentsNodeId = builder.observe(
    'n-scope-commitments',
    { kind: 'life_state_field', field: 'commitments', known: commitments.known },
    commitments.known
      ? { kind: 'quantity', value: commitments.value.openCount, unit: 'count' }
      : { kind: 'absent', reason: commitments.reason },
    commitments.provenance.derivedFrom,
    fingerprint('life_state.commitments', [
      commitments.known,
      commitments.known ? commitments.value.openCount : commitments.reason,
      commitments.known ? commitments.value.overdueCount : null,
      commitments.provenance.derivedFrom,
    ]),
  );

  const load = lifeState.load;
  const loadNodeId = builder.observe(
    'n-scope-load',
    { kind: 'life_state_field', field: 'load', known: load.known },
    load.known
      ? { kind: 'category', value: loadCategory(load.value.band) }
      : { kind: 'absent', reason: load.reason },
    load.provenance.derivedFrom,
    fingerprint('life_state.load', [
      load.known,
      load.known ? load.value.band : load.reason,
      load.known ? load.value.openCount : null,
      load.provenance.derivedFrom,
    ]),
  );

  const capacityNodeId = load.known
    ? builder.derive(
        'n-scope-capacity',
        'CAPACITY_FROM_LOAD',
        { kind: 'category', value: loadCategory(load.value.band) },
        [loadNodeId],
      )
    : null;

  return { commitmentsNodeId, loadNodeId, capacityNodeId };
}

/* ── Candidates ──────────────────────────────────────────────────── */

/**
 * A candidate after evidence has been built and the hard filters have run.
 *
 * `canonicalIndex` is the position in the canonical (code-point-ordered by
 * commitment id) candidate list, and it is the only way a candidate is named in
 * a human-readable `detail` string. `commitmentId` travels in its own typed
 * field everywhere it is needed.
 *
 * `hardExclusions` is empty for a candidate that survives. When it is not, its
 * **first entry is the pilot-comparable verdict**: the codes are emitted in the
 * pilot's own precedence order (`not_confirmed` before `closed` before
 * `invalid_time`), so `hardExclusions[0]` is the code the pilot's single
 * nullable `exclusionReason` field would have carried. Emitting the whole list
 * rather than only the winner is the superset half of the relationship — the
 * pilot cannot say that a candidate is both unconfirmed and closed, and a user
 * who confirms it then learns it was also closed.
 */
export interface Candidate {
  readonly canonicalIndex: number;
  readonly commitmentId: string;
  readonly snapshot: CommitmentSnapshot;
  readonly hardExclusions: readonly ExclusionReasonCode[];
  /** Blocking commitments that are present in this request and still open. */
  readonly openBlockerIndices: readonly number[];
  /**
   * Blocker ids this request did not supply, so no observation of them exists.
   *
   * They do not block (see `resolveBlockers`), and this field plus the `absent`
   * evidence nodes built for them is what keeps that from being a *silent*
   * drop. A filtered scope — one window, one page, one project — drops
   * prerequisites that fall outside the slice, and "we chose not to watch that
   * one" is precisely the shape the contract's validity section warns about.
   */
  readonly unresolvedBlockerIds: readonly string[];
  /**
   * Canonical indices of candidates that this one, and only this one kind of
   * thing, is holding up.
   *
   * A dependent counts only when `BLOCKED_BY_DEPENDENCY` is its *sole* hard
   * exclusion. That is the whole content of `UNBLOCKS_DEPENDENTS`: finishing
   * this candidate has to actually make the dependent actionable. A completed
   * or unconfirmed dependent is not waiting on anything, so counting it would
   * put a false claim — "this is the open prerequisite of something" — in front
   * of a user, and would buy the blocker 1.5 weight it has not earned.
   */
  readonly dependentIndices: readonly number[];
  readonly effectiveTimeMs: number | null;
  readonly priority: PriorityScore | null;
  readonly slot: TimeInterval | null;
  readonly evidence: CandidateEvidence;
}

/** Node ids this candidate produced. Null where the node was not emitted. */
export interface CandidateEvidence {
  readonly statusNodeId: EvidenceNodeId;
  readonly confirmationNodeId: EvidenceNodeId;
  readonly timeNodeId: EvidenceNodeId;
  readonly importanceNodeId: EvidenceNodeId;
  readonly priorityNodeId: EvidenceNodeId | null;
  readonly slotNodeId: EvidenceNodeId | null;
  readonly decompositionNodeId: EvidenceNodeId | null;
  readonly eligibleStatusNodeId: EvidenceNodeId;
  readonly eligibleConfirmationNodeId: EvidenceNodeId;
  readonly blockedNodeId: EvidenceNodeId | null;
  /** One `absent` observation per blocker id this request did not supply. */
  readonly unresolvedBlockerNodeIds: readonly EvidenceNodeId[];
  readonly overdueNodeId: EvidenceNodeId | null;
  readonly dueSoonNodeId: EvidenceNodeId | null;
  readonly dueSoonCategory: 'due_today' | 'due_this_week' | null;
  readonly rankNodeId: EvidenceNodeId | null;
  readonly slotImminentNodeId: EvidenceNodeId | null;
  readonly effortNodeId: EvidenceNodeId | null;
  readonly effortMinutes: number | null;
}

/** What `generateCandidates` returns: the graph, the scope nodes, the rows. */
export interface CandidateSet {
  readonly evidence: EvidenceGraph;
  readonly scope: ScopeEvidence;
  readonly candidates: readonly Candidate[];
}

/** Thresholds candidate generation needs. A subset of the selector config. */
export interface CandidateGenerationOptions {
  readonly dueTodayHours: number;
  readonly dueSoonHours: number;
  readonly planSlotImminentMinutes: number;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
/** `Date#toISOString` throws beyond this; see `validateSelectorConfig`. */
const MAX_REPRESENTABLE_EPOCH_MS = 8.64e15;

/**
 * Canonical order for candidates: by commitment id, by code point.
 *
 * This runs before anything else reads the array, so no later stage can depend
 * on the order the caller happened to supply. Sprint 07 shipped a determinism
 * defect that was exactly this — a `dependsOn` order leaking into output
 * through a single unsorted `.find` — and the remedy is to canonicalise once, at
 * the entry, rather than to remember to sort at each use.
 */
function canonicalOrder(commitments: readonly CommitmentSnapshot[]): CommitmentSnapshot[] {
  if (!Array.isArray(commitments)) {
    throw new RecommendationInputError('commitments', 'the commitment list is not an array');
  }
  // Normalised *before* sorting, so the sort key is a checked string and every
  // later read sees a fully null-normalised row.
  const ordered = commitments.map(normalizeSnapshot);
  ordered.sort((left, right) => compareByCodePoint(left.commitmentId, right.commitmentId));
  return ordered;
}

/**
 * Blocking commitments that are present in this request and not yet closed.
 *
 * **A blocker naming nothing in this request does not block.** The tempting
 * alternative is to fail closed and treat an unknown id as unfinished, and it is
 * wrong here for a reason specific to this contract: an exclusion is a claim,
 * `BLOCKED_BY_DEPENDENCY` would have to cite evidence, and there is no
 * observation of a commitment that was never supplied. A claim resting on
 * nothing is precisely what decision 1 makes unrepresentable, so the choice is
 * between not making the claim and making it unsourced. Not making it is the
 * only one the type permits.
 *
 * The caller that wants the strict reading gets it by supplying the blocker.
 *
 * **The drop is not silent.** Every unresolved id is returned, recorded on
 * `Candidate.unresolvedBlockerIds`, and given an `absent` observation in the
 * graph — an honest claim ("this request carried no status for that record")
 * that a stricter future policy can cite. Without it the module would propose
 * "do this now" for work that cannot start, with nothing anywhere saying a
 * stated prerequisite had been ignored.
 */
function resolveBlockers(
  snapshot: CommitmentSnapshot,
  indexById: ReadonlyMap<string, number>,
  ordered: readonly CommitmentSnapshot[],
): { readonly open: number[]; readonly unresolved: string[] } {
  const open: number[] = [];
  const openSeen = new Set<number>();
  const unresolved: string[] = [];
  const unresolvedSeen = new Set<string>();
  const selfIndex = indexById.get(snapshot.commitmentId);
  for (let edge = 0; edge < snapshot.blockedByCommitmentIds.length; edge += 1) {
    const blockerId = snapshot.blockedByCommitmentIds[edge];
    const blockerIndex = indexById.get(blockerId);
    if (blockerIndex === undefined) {
      // Reported rather than dropped. See `Candidate.unresolvedBlockerIds`.
      if (!unresolvedSeen.has(blockerId)) {
        unresolvedSeen.add(blockerId);
        unresolved.push(blockerId);
      }
      continue;
    }
    if (blockerIndex === selfIndex) continue;
    const blocker = ordered[blockerIndex];
    if ((CLOSED_COMMITMENT_STATUSES as readonly string[]).includes(blocker.status)) continue;
    // A `Set` rather than `open.indexOf`, which made this quadratic per
    // candidate and cubic over a dense request.
    if (!openSeen.has(blockerIndex)) {
      openSeen.add(blockerIndex);
      open.push(blockerIndex);
    }
  }
  // Sorted, not in declared order: Sprint 07's leak was a dependency array's
  // order reaching the output through an unsorted lookup.
  open.sort((left, right) => left - right);
  unresolved.sort(compareByCodePoint);
  return { open, unresolved };
}

/**
 * A snapshot with every nullable field actually null.
 *
 * `=== null` is a strict test and an **absent** key is `undefined`, not null —
 * so every optional field arriving from an untyped boundary (any JSON payload
 * that simply omits the key) slipped past the hard filters. The observed failure
 * was not subtle: a commitment with no `confirmedAt` key was *offered*, the
 * graph asserted `ELIGIBLE_FROM_CONFIRMATION: {flag: true}` positively, the
 * `confirmed_at` observation carried `{kind: 'instant'}` with no `value` at all
 * — a shape `EvidenceClaim` does not admit — and `checkRecommendation` reported
 * zero defects, because none of those is a condition its taxonomy names.
 *
 * That is why the claim "hard exclusion is structural, not behavioural" needed
 * this function to be true: the structure rested on one `=== null`. Normalising
 * once, at the entry, is the same remedy `canonicalOrder` applies to array
 * order — fix the input shape in one place rather than remembering the wider
 * test at each of six use sites.
 *
 * The direction is fail-closed on purpose: a missing `confirmedAt` becomes
 * "not confirmed" and the commitment is excluded, never offered.
 */
function normalizeSnapshot(snapshot: CommitmentSnapshot): CommitmentSnapshot {
  const commitmentId = snapshot === null || typeof snapshot !== 'object' ? '' : snapshot.commitmentId;
  if (typeof commitmentId !== 'string' || isBlank(commitmentId)) {
    throw new RecommendationInputError(
      'commitments',
      'a commitment in this request carries no usable id, so no evidence about it could be addressed',
    );
  }
  if ((KNOWN_COMMITMENT_STATUSES as readonly string[]).indexOf(snapshot.status) === -1) {
    // No code describes it and every eligibility judgement reads it, so this is
    // a refusal rather than a finding — the same bar `now` and a duplicated id
    // are held to. Defaulting to "open" would offer work whose state we cannot
    // read; defaulting to "closed" would hide it.
    throw new RecommendationInputError(
      'commitments',
      'a commitment in this request states a status outside the known lifecycle',
    );
  }
  const blockedBy = snapshot.blockedByCommitmentIds;
  return {
    commitmentId,
    status: snapshot.status,
    confirmedAt: snapshot.confirmedAt == null ? null : snapshot.confirmedAt,
    dueAt: snapshot.dueAt == null ? null : snapshot.dueAt,
    remindAt: snapshot.remindAt == null ? null : snapshot.remindAt,
    importance: snapshot.importance == null ? null : snapshot.importance,
    blockedByCommitmentIds: Array.isArray(blockedBy) ? blockedBy.slice() : [],
    planItemId: snapshot.planItemId == null ? null : snapshot.planItemId,
    decompositionProposalId:
      snapshot.decompositionProposalId == null ? null : snapshot.decompositionProposalId,
    decompositionStepId: snapshot.decompositionStepId == null ? null : snapshot.decompositionStepId,
  };
}

/**
 * The hard filters, in the pilot's precedence order.
 *
 * Every code here is a *hard constraint*: nothing later in the pipeline can
 * restore a candidate this function excludes, and `select.ts` never consults the
 * list for anything but exclusion. That is the enforcement half of "hard
 * constraints cannot be bypassed" — the ranking stage never sees an excluded
 * candidate at all, so there is no path along which a high score could outweigh
 * one.
 *
 * The first three are **the same rule as the pilot's**, in the pilot's own
 * precedence order, so `codes[0]` maps one-to-one onto its `exclusionReason`:
 * `NOT_CONFIRMED` ↔ `'not_confirmed'`, `ALREADY_CLOSED` ↔ `'closed'`,
 * `INVALID_SOURCE_TIME` ↔ `'invalid_time'`. The fourth,
 * `BLOCKED_BY_DEPENDENCY`, is **deliberately stricter**: the pilot has no
 * dependency concept, so it offers a step whose prerequisite is still open. It
 * is placed last precisely so that it can never displace a pilot-comparable
 * code from position 0.
 */
export function hardExclusionCodes(
  snapshot: CommitmentSnapshot,
  effectiveTimeMs: number | null,
  openBlockerCount: number,
): ExclusionReasonCode[] {
  const codes: ExclusionReasonCode[] = [];
  if (snapshot.confirmedAt === null) codes.push('NOT_CONFIRMED');
  if ((CLOSED_COMMITMENT_STATUSES as readonly string[]).includes(snapshot.status)) {
    codes.push('ALREADY_CLOSED');
  }
  const { raw } = effectiveTimeSource(snapshot);
  if (raw !== null && effectiveTimeMs === null) codes.push('INVALID_SOURCE_TIME');
  // Suppressed for a finished commitment, per the contract's suppression rule:
  // a finding is dropped only when it *borrows a bound* from something already
  // reported. "Waiting on a prerequisite" borrows its entire meaning from the
  // commitment still being live — a completed one is not waiting for anything —
  // so reporting both would be one defect told twice. Nothing wider is
  // suppressed: an unconfirmed commitment genuinely is also blocked, and both
  // have to change before it can be offered.
  const alreadyClosed = codes.indexOf('ALREADY_CLOSED') !== -1;
  if (openBlockerCount > 0 && !alreadyClosed) codes.push('BLOCKED_BY_DEPENDENCY');
  return codes;
}

/**
 * Refuse a config this module cannot compute against.
 *
 * A refusal rather than a finding because no code in the taxonomy describes a
 * broken knob, and because *every* judgement in the run reads these — an
 * unusable `dueSoonHours` does not make one candidate wrong, it makes the whole
 * banding meaningless. Same bar as `now`.
 *
 * `ttlMinutes` is additionally bounded above: the check is that `now` plus the
 * TTL is still a representable instant, so an out-of-range expiry is reported
 * here by name instead of surfacing as a `RangeError` from `Date#toISOString`
 * several frames away.
 */
export function validateSelectorConfig(
  config: CandidateGenerationOptions & {
    readonly ttlMinutes?: number;
    readonly maxInputAgeMinutes?: number;
    readonly quickWinMaxMinutes?: number;
  },
  nowMs: number,
): void {
  const numeric: readonly (readonly [string, unknown, boolean])[] = [
    ['dueTodayHours', config.dueTodayHours, false],
    ['dueSoonHours', config.dueSoonHours, false],
    ['planSlotImminentMinutes', config.planSlotImminentMinutes, false],
    ['quickWinMaxMinutes', config.quickWinMaxMinutes, false],
    ['maxInputAgeMinutes', config.maxInputAgeMinutes, false],
    ['ttlMinutes', config.ttlMinutes, true],
  ];
  for (let index = 0; index < numeric.length; index += 1) {
    const entry = numeric[index];
    const value = entry[1];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new RecommendationInputError(
        'config',
        `the ${entry[0]} setting is not a finite, non-negative number of ${entry[0].endsWith('Hours') ? 'hours' : 'minutes'}`,
      );
    }
    if (entry[2] && value <= 0) {
      throw new RecommendationInputError(
        'config',
        'the ttlMinutes setting is not positive, so the recommendation would be valid at no instant at all',
      );
    }
  }
  const expiresMs = nowMs + (config.ttlMinutes as number) * MS_PER_MINUTE;
  if (!Number.isFinite(expiresMs) || Math.abs(expiresMs) > MAX_REPRESENTABLE_EPOCH_MS) {
    throw new RecommendationInputError(
      'config',
      'the ttlMinutes setting pushes the expiry past the representable instant range',
    );
  }
}

/**
 * Build the evidence graph and the candidate rows.
 *
 * Pure, and it does not mutate its input: every array is copied before it is
 * sorted. `tests/recommendation/selectorDeterminism.test.ts` asserts the input
 * is byte-identical afterwards, because a module that sorted the caller's array
 * in place would be deterministic in its own output and would silently reorder
 * the caller's.
 */
export function generateCandidates(
  input: RecommendationSelectorInput,
  options: CandidateGenerationOptions,
): CandidateSet {
  const nowMs = epochMsOrNull(input.now);
  if (nowMs === null) {
    throw new RecommendationInputError('now', 'the evaluation instant does not parse');
  }

  const ordered = canonicalOrder(input.commitments);
  const indexById = new Map<string, number>();
  for (let index = 0; index < ordered.length; index += 1) {
    const commitmentId = ordered[index].commitmentId;
    if (indexById.has(commitmentId)) {
      throw new RecommendationInputError(
        'commitments',
        'two commitments in this request share an id, so every reference to it is ambiguous',
      );
    }
    indexById.set(commitmentId, index);
  }

  const priorityById = new Map<string, PriorityScore>();
  for (let index = 0; index < input.priorityScores.length; index += 1) {
    const score = input.priorityScores[index];
    if (priorityById.has(score.commitmentId)) {
      throw new RecommendationInputError(
        'priorityScores',
        'two priority scores in this request name the same commitment',
      );
    }
    priorityById.set(score.commitmentId, score);
  }

  const slotByItemId = new Map<string, TimeInterval>();
  const plan = input.plan;
  if (plan !== null) {
    for (let index = 0; index < plan.scheduled.length; index += 1) {
      const placed = plan.scheduled[index];
      // First placement wins. A plan with two placements for one item is a
      // planning defect, not a recommendation one, and picking by input order
      // would put that order into this module's output.
      //
      // **Copied field by field, never stored by reference.** Holding
      // `placed.interval` aliased the caller's object all the way into
      // `RecommendedAction.slot`, and that single reference reproduced Sprint
      // 07's shipped determinism defect exactly: two value-identical requests
      // differing only in the order `{startsAt, endsAt}` were written produced
      // the same `inputDigest` — the canonical encoder re-orders — and
      // byte-different output, because `JSON.stringify` emits keys in insertion
      // order. Under a fuzz that permuted object keys as well as arrays, ~18%
      // of cases mismatched, all from this one line. It also copied any extra
      // property the caller had hung on the interval straight into the output,
      // which was the last surviving identifier-leak channel in the module, and
      // it left the output sharing mutable state with the input while the
      // module claimed purity. Two of the three are invisible to a test that
      // reverses arrays; only the key-order half of the determinism suite sees
      // them, and that half was not reaching the plan.
      if (!slotByItemId.has(placed.itemId)) {
        slotByItemId.set(placed.itemId, {
          startsAt: placed.interval.startsAt,
          endsAt: placed.interval.endsAt,
        });
      }
    }
  }

  const builder = new EvidenceBuilder();
  const scope = buildScopeEvidence(builder, input.lifeState);

  // Blockers and dependents are resolved for every row before any evidence is
  // built, because a candidate's `blocked` node cites its blockers' status
  // nodes and those must already exist.
  const openBlockers: number[][] = [];
  const unresolvedBlockers: string[][] = [];
  const effectiveTimes: (number | null)[] = [];
  const hardExclusions: ExclusionReasonCode[][] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const snapshot = ordered[index];
    const resolved = resolveBlockers(snapshot, indexById, ordered);
    openBlockers.push(resolved.open);
    unresolvedBlockers.push(resolved.unresolved);
    const effectiveTimeMs = epochMsOrNull(effectiveTimeSource(snapshot).raw);
    effectiveTimes.push(effectiveTimeMs);
    hardExclusions.push(hardExclusionCodes(snapshot, effectiveTimeMs, resolved.open.length));
  }

  // Dependents are resolved only *after* every row's hard exclusions are known,
  // because `UNBLOCKS_DEPENDENTS` claims something specific — that finishing
  // this candidate makes another one actionable — and that is true only when
  // being blocked is the dependent's *sole* remaining obstacle. Counting every
  // dependent regardless flipped a withheld verdict into an offer: adding a
  // *completed* commitment that named the candidate as its blocker bought that
  // candidate 1.5 weight, carried it from 0.3 to 0.6 over the lead floor, and
  // showed the user "this is the open prerequisite of another item" about an
  // item that was finished and waiting for nothing.
  const dependents: number[][] = ordered.map(() => []);
  for (let index = 0; index < openBlockers.length; index += 1) {
    const codes = hardExclusions[index];
    const blockedIsTheOnlyObstacle =
      codes.length === 1 && codes[0] === 'BLOCKED_BY_DEPENDENCY';
    if (!blockedIsTheOnlyObstacle) continue;
    for (let edge = 0; edge < openBlockers[index].length; edge += 1) {
      dependents[openBlockers[index][edge]].push(index);
    }
  }
  for (let index = 0; index < dependents.length; index += 1) {
    dependents[index].sort((left, right) => left - right);
  }

  // Pass 1: every observed node, so that pass 2's derivations can cite across
  // rows without depending on which row was visited first.
  const statusNodeIds: EvidenceNodeId[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const snapshot = ordered[index];
    const handle = commitmentHandle(snapshot.commitmentId);
    statusNodeIds.push(
      builder.observe(
        `n-c-${handle}-status`,
        { kind: 'commitment', commitmentId: snapshot.commitmentId, field: 'status' },
        { kind: 'category', value: statusCategory(snapshot.status) },
        null,
        fingerprint('commitment.status', [snapshot.status]),
      ),
    );
  }

  const candidates: Candidate[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const snapshot = ordered[index];
    const handle = commitmentHandle(snapshot.commitmentId);
    const statusNodeId = statusNodeIds[index];

    const confirmationNodeId = builder.observe(
      `n-c-${handle}-confirmed-at`,
      { kind: 'commitment', commitmentId: snapshot.commitmentId, field: 'confirmed_at' },
      snapshot.confirmedAt === null
        ? { kind: 'absent', reason: 'NO_DATA' }
        : { kind: 'instant', value: snapshot.confirmedAt },
      snapshot.confirmedAt,
      fingerprint('commitment.confirmed_at', [snapshot.confirmedAt]),
    );

    const time = effectiveTimeSource(snapshot);
    const effectiveTimeMs = effectiveTimes[index];
    const timeNodeId = builder.observe(
      `n-c-${handle}-${time.field === 'due_at' ? 'due-at' : 'remind-at'}`,
      { kind: 'commitment', commitmentId: snapshot.commitmentId, field: time.field },
      time.raw === null
        ? { kind: 'absent', reason: 'NO_DATA' }
        : effectiveTimeMs === null
          // The value is present and unusable. `INSUFFICIENT_DATA` rather than
          // `NO_DATA`: "we read a time and could not use it" is a different
          // fact from "there is no time", and `NO_DATA` would let a broken
          // due date read as `no_stated_time` downstream.
          ? { kind: 'absent', reason: 'INSUFFICIENT_DATA' }
          : { kind: 'instant', value: time.raw },
      effectiveTimeMs === null ? null : time.raw,
      fingerprint(`commitment.${time.field}`, [snapshot.dueAt, snapshot.remindAt]),
    );

    const importanceNodeId = builder.observe(
      `n-c-${handle}-importance`,
      { kind: 'commitment', commitmentId: snapshot.commitmentId, field: 'importance' },
      snapshot.importance === null
        ? { kind: 'absent', reason: 'NO_DATA' }
        : { kind: 'category', value: importanceCategory(snapshot.importance) },
      null,
      fingerprint('commitment.importance', [snapshot.importance]),
    );

    const priority = priorityById.get(snapshot.commitmentId) || null;
    const priorityNodeId = priority === null
      ? null
      : builder.observe(
          `n-c-${handle}-priority`,
          {
            kind: 'priority_score',
            commitmentId: snapshot.commitmentId,
            policyVersion: priority.policyVersion,
          },
          // A non-finite total is not a defect the taxonomy names, so it is
          // recorded as read rather than repaired. `policy.ts` gives it no
          // ranking weight; `Math.max` "fixing" it into a plausible number is
          // the buffer-clamping defect `planningContracts` records.
          { kind: 'quantity', value: priority.total, unit: 'points' },
          null,
          fingerprint('priority.score', [
            priority.total,
            priority.policyVersion,
            priority.reasonCodes.slice().sort(compareByCodePoint).join(','),
          ]),
        );

    const slot = snapshot.planItemId === null
      ? null
      : slotByItemId.get(snapshot.planItemId) || null;
    const slotNodeId = slot === null || plan === null
      ? null
      : builder.observe(
          `n-c-${handle}-plan-slot`,
          {
            kind: 'plan_slot',
            itemId: snapshot.planItemId as string,
            planDigest: plan.inputDigest,
          },
          { kind: 'instant', value: slot.startsAt },
          null,
          fingerprint('plan.slot', [slot.startsAt, slot.endsAt, plan.inputDigest]),
        );

    const decompositionNodeId =
      snapshot.decompositionProposalId === null || snapshot.decompositionStepId === null
        ? null
        : builder.observe(
            `n-c-${handle}-decomposition`,
            {
              kind: 'decomposition_step',
              proposalId: snapshot.decompositionProposalId,
              stepId: snapshot.decompositionStepId,
            },
            { kind: 'flag', value: true },
            null,
            fingerprint('decomposition.step', [
              snapshot.decompositionProposalId,
              snapshot.decompositionStepId,
            ]),
          );

    /* Derivations. Each cites exactly the observations it used. */

    const isClosed = (CLOSED_COMMITMENT_STATUSES as readonly string[]).includes(snapshot.status);
    const eligibleStatusNodeId = builder.derive(
      `n-c-${handle}-eligible-status`,
      'ELIGIBLE_FROM_STATUS',
      { kind: 'flag', value: !isClosed },
      [statusNodeId],
    );
    const eligibleConfirmationNodeId = builder.derive(
      `n-c-${handle}-eligible-confirmation`,
      'ELIGIBLE_FROM_CONFIRMATION',
      { kind: 'flag', value: snapshot.confirmedAt !== null },
      [confirmationNodeId],
    );

    // One `absent` observation per blocker this request did not supply, so the
    // decision not to block is visible in the audit record rather than living
    // only in a comment. The source is honest: we looked for that commitment's
    // status *in this request* and there was none.
    const unresolvedBlockerNodeIds: EvidenceNodeId[] = [];
    for (let edge = 0; edge < unresolvedBlockers[index].length; edge += 1) {
      const blockerId = unresolvedBlockers[index][edge];
      unresolvedBlockerNodeIds.push(
        builder.observe(
          `n-c-${commitmentHandle(blockerId)}-status-absent`,
          { kind: 'commitment', commitmentId: blockerId, field: 'status' },
          { kind: 'absent', reason: 'NO_DATA' },
          null,
          fingerprint('commitment.status.absent', [blockerId]),
        ),
      );
    }

    const blockers = openBlockers[index];
    const blockedNodeId = blockers.length === 0
      ? null
      : builder.derive(
          `n-c-${handle}-blocked`,
          'BLOCKED_FROM_DEPENDENCY',
          { kind: 'category', value: 'blocked' },
          blockers.map((blockerIndex) => statusNodeIds[blockerIndex]) as [
            EvidenceNodeId,
            ...EvidenceNodeId[],
          ],
        );

    let overdueNodeId: EvidenceNodeId | null = null;
    let dueSoonNodeId: EvidenceNodeId | null = null;
    let dueSoonCategory: 'due_today' | 'due_this_week' | null = null;
    if (effectiveTimeMs !== null) {
      if (effectiveTimeMs < nowMs) {
        overdueNodeId = builder.derive(
          `n-c-${handle}-overdue`,
          'OVERDUE_FROM_DUE_AT',
          { kind: 'category', value: 'overdue' },
          [timeNodeId],
        );
      } else {
        const aheadHours = (effectiveTimeMs - nowMs) / MS_PER_HOUR;
        if (aheadHours <= options.dueTodayHours) dueSoonCategory = 'due_today';
        else if (aheadHours <= options.dueSoonHours) dueSoonCategory = 'due_this_week';
        if (dueSoonCategory !== null) {
          dueSoonNodeId = builder.derive(
            `n-c-${handle}-due-soon`,
            'DUE_SOON_FROM_DUE_AT',
            { kind: 'category', value: dueSoonCategory },
            [timeNodeId],
          );
        }
      }
    }

    const rankNodeId = priorityNodeId === null || priority === null
      ? null
      : builder.derive(
          `n-c-${handle}-rank`,
          'RANK_FROM_PRIORITY',
          { kind: 'quantity', value: priority.total, unit: 'points' },
          [priorityNodeId],
        );

    let slotImminentNodeId: EvidenceNodeId | null = null;
    let effortNodeId: EvidenceNodeId | null = null;
    let effortMinutes: number | null = null;
    if (slot !== null && slotNodeId !== null) {
      const slotStartMs = epochMsOrNull(slot.startsAt);
      const slotEndMs = epochMsOrNull(slot.endsAt);
      if (slotStartMs !== null && slotEndMs !== null && slotEndMs > slotStartMs) {
        effortMinutes = (slotEndMs - slotStartMs) / MS_PER_MINUTE;
        effortNodeId = builder.derive(
          `n-c-${handle}-effort`,
          'EFFORT_FROM_PLAN_SLOT',
          { kind: 'quantity', value: effortMinutes, unit: 'minutes' },
          [slotNodeId],
        );
        const aheadMinutes = (slotStartMs - nowMs) / MS_PER_MINUTE;
        if (aheadMinutes >= 0 && aheadMinutes <= options.planSlotImminentMinutes) {
          slotImminentNodeId = builder.derive(
            `n-c-${handle}-slot-imminent`,
            'SLOT_IMMINENT_FROM_PLAN',
            { kind: 'flag', value: true },
            [slotNodeId],
          );
        }
      }
    }

    candidates.push({
      canonicalIndex: index,
      commitmentId: snapshot.commitmentId,
      snapshot,
      hardExclusions: hardExclusions[index],
      openBlockerIndices: blockers,
      unresolvedBlockerIds: unresolvedBlockers[index],
      dependentIndices: dependents[index],
      effectiveTimeMs,
      priority,
      slot,
      evidence: {
        statusNodeId,
        confirmationNodeId,
        timeNodeId,
        importanceNodeId,
        priorityNodeId,
        slotNodeId,
        decompositionNodeId,
        eligibleStatusNodeId,
        eligibleConfirmationNodeId,
        blockedNodeId,
        unresolvedBlockerNodeIds,
        overdueNodeId,
        dueSoonNodeId,
        dueSoonCategory,
        rankNodeId,
        slotImminentNodeId,
        effortNodeId,
        effortMinutes,
      },
    });
  }

  return { evidence: builder.graph(), scope, candidates };
}

/**
 * Every observed node's fingerprint, recomputed from a current input.
 *
 * This is the other half of `evaluateRecommendationStaleness`: that function
 * needs a `Record<nodeId, string | null>` of what the sources say *now*, and a
 * caller has no way to produce one without knowing how this module fingerprints
 * what it read. Exported so re-verification is a comparison rather than a guess.
 *
 * A node id absent from the result is `SOURCE_UNVERIFIABLE` and therefore stale,
 * which is the correct reading when a commitment has been deleted: its evidence
 * cannot be re-read, and `undefined` is not `unchanged`.
 */
export function currentFingerprints(
  input: RecommendationSelectorInput,
  options: CandidateGenerationOptions,
): Record<EvidenceNodeId, string | null> {
  const set = generateCandidates(input, options);
  const fingerprints: Record<EvidenceNodeId, string | null> = {};
  for (let index = 0; index < set.evidence.nodes.length; index += 1) {
    const node = set.evidence.nodes[index];
    if (node.kind === 'observed') fingerprints[node.nodeId] = node.valueFingerprint;
  }
  return fingerprints;
}

/** Guard: the projection's field list has not grown a view this module ignores. */
export const OBSERVED_LIFE_STATE_FIELDS = Object.freeze(['commitments', 'load'] as const);

export const UNREAD_LIFE_STATE_FIELDS = Object.freeze(
  LIFE_STATE_SOURCE_FIELDS.filter(
    (field) => (OBSERVED_LIFE_STATE_FIELDS as readonly string[]).indexOf(field) === -1,
  ),
);

export type { DerivedEvidence, ObservedEvidence };
