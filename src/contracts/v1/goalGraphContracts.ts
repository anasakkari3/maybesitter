/**
 * The goal execution graph: how a stored Goal becomes reviewable work (#526).
 *
 * Today a confirmed Goal is a `RuntimeMemoryRecord` of kind `goal` (#168,
 * #202) and that is where it stops. "أريد أخلّص الرسالة" is filed, retrievable,
 * and asks for nothing. This contract is the projection that carries it
 * forward — Goal → proposals → confirmed nodes → canonical Commitments and
 * Habits → time — without any step of that happening on its own.
 *
 * ── A projection, not a second copy of the world ────────────────
 *
 * The graph is rooted in `goalMemoryId` and owns nothing else. That is why
 * `linked_commitment` holds a `commitmentId` and no title, no time and no
 * state, and `linked_habit` holds a `habitId` and nothing else: #526 says not
 * to duplicate canonical Commitment/Habit state inside graph nodes, and the
 * way to be sure of that is for the node to have nowhere to put it. A node
 * that carried a copy of a commitment's due date would be a second answer to
 * "when is this", and the two would disagree the first time the user moved it.
 *
 * `tests/goalGraph/goalGraphBoundaries.test.ts` pins the field lists of both
 * linked node kinds exactly, because the natural next commit is a
 * denormalised `title` "just for the list screen".
 *
 * ── Nothing here carries a date ─────────────────────────────────
 *
 * There is no `dueAt`, no `deadlineAt`, no `startAt` and no `scheduledFor` on
 * any node in this file, and that absence is the "no invented deadlines"
 * acceptance criterion. The only time a proposal node may carry is
 * `statedTiming`: the source text's own words, verbatim and unresolved, which
 * is exactly what `DecompositionStepProposal.statedTiming` already means and
 * exactly what `INVENTED_TIMING` already polices. Resolving "next week"
 * against a clock is Capture's job and always has been; a goal graph that did
 * it would be inventing the one thing a user would then be held to.
 *
 * `generatedAt` is the caller's instant, passed in. Nothing in this module or
 * the one that builds it reads an ambient clock.
 *
 * ── Nothing actionable persists by generating ───────────────────
 *
 * Generation produces proposal nodes and a checkpoint. It cannot produce a
 * `linked_commitment` or a `linked_habit`, and `validateGoalExecutionGraph`
 * reports `CANONICAL_LINK_IN_PROPOSAL` when asked to check a freshly generated
 * graph that contains one. The materialization that creates canonical entities
 * from selected nodes is the confirmation slice's, and it goes through the
 * existing Commitment/Habit boundaries rather than through anything here.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import type {
  AtomicReason,
  DecompositionProvenance,
  DecompositionViolation,
  DependencyKind,
  SourceSpan,
} from './decompositionContracts';

export const GOAL_GRAPH_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const GOAL_GRAPH_SCHEMA_VERSION = 'goal-graph-v1' as const;

/**
 * The first generation number. Generations count up from here; a regeneration
 * is a new graph with the next number rather than an edit of this one, which
 * is what lets the follow-up slice carry confirmed links across without having
 * to reconcile two mutable objects.
 */
export const GOAL_GRAPH_FIRST_GENERATION = 1;

/** A graph wider than this is a review screen nobody can read. */
export const GOAL_GRAPH_MAX_NODES = 64;

export type GoalNodeKind =
  | 'milestone_proposal'
  | 'decomposition_step_proposal'
  | 'linked_commitment'
  | 'linked_habit'
  | 'checkpoint';

/**
 * Where a node stands with the user.
 *
 * Generation only ever writes `proposed`; `confirmed` is written by the
 * confirmation slice once the canonical entity exists, and `dismissed` by the
 * user turning a proposal down. A `dismissed` node is kept rather than removed
 * so that regenerating does not offer the same rejected milestone again.
 */
export type GoalNodeStatus = 'proposed' | 'confirmed' | 'dismissed';

interface GoalNodeBase {
  readonly nodeId: string;
  readonly status: GoalNodeStatus;
}

/**
 * A stage somebody could be at on the way to the goal.
 *
 * Nothing in the generation slice produces one: the deterministic detector
 * reads steps out of a sentence and has no notion of a stage, and a model that
 * suggested "finish chapter two by June" would be inventing both the stage and
 * the date. The kind exists because the model path and the confirmation slice
 * will produce them, and because it is better for the validator to know how to
 * refuse a bad one now than to meet the first one in production.
 */
export interface MilestoneProposalNode extends GoalNodeBase {
  readonly kind: 'milestone_proposal';
  readonly title: string;
  /** Verbatim source words, or null. Never a date anything computed. */
  readonly statedTiming: string | null;
}

/**
 * One step of the existing decomposition, carried through unchanged.
 *
 * Every field below is copied from `DecompositionStepProposal` and none is
 * re-derived. The engine already validated the spans against the source text
 * and already refused invented timings and owners; re-deriving any of it here
 * would be a second reading of the same sentence, and the two would diverge the
 * day one of them was improved.
 */
export interface DecompositionStepNode extends GoalNodeBase {
  readonly kind: 'decomposition_step_proposal';
  /** The `stepId` inside the decomposition proposal this came from. */
  readonly stepId: string;
  readonly title: string;
  readonly sourceSpans: readonly SourceSpan[];
  readonly inferred: boolean;
  readonly statedTiming: string | null;
  readonly statedOwner: string | null;
}

/**
 * A reference, and deliberately nothing more.
 *
 * Adding any second field here — a title, a due date, a completion flag —
 * makes this a cache of canonical state, and #526's progress criterion
 * ("linked Commitment completion changes derived progress automatically")
 * stops holding the moment the cache is a day old.
 */
export interface LinkedCommitmentNode extends GoalNodeBase {
  readonly kind: 'linked_commitment';
  readonly commitmentId: string;
}

/**
 * A reference to a `HabitDefinition` by its `habitId`, and nothing more.
 *
 * Deliberately an opaque string rather than an import of the habit contract:
 * the graph's claim is "this goal is served by that habit", which is true
 * whatever shape the habit type has, and a structural dependency here would
 * make the goal graph re-compile — and potentially re-validate — every time
 * the habit cadence model changed. Same reasoning as `commitmentId` above.
 */
export interface LinkedHabitNode extends GoalNodeBase {
  readonly kind: 'linked_habit';
  readonly habitId: string;
}

/**
 * A point the user can be said to have reached.
 *
 * Generation produces exactly one: the goal itself, as the sink every step
 * contributes to. It carries the goal's own words as its title so the review
 * screen has a label, and it carries no time at all — the goal record has no
 * date either, and a checkpoint is the most tempting place to put one.
 */
export interface CheckpointNode extends GoalNodeBase {
  readonly kind: 'checkpoint';
  readonly title: string;
  /** Verbatim source words, or null. Generation always emits null. */
  readonly statedTiming: string | null;
}

export type GoalNode =
  | MilestoneProposalNode
  | DecompositionStepNode
  | LinkedCommitmentNode
  | LinkedHabitNode
  | CheckpointNode;

/**
 * `contributes_to` is structural: doing the `from` node advances the `to` one.
 * `depends_on` is ordering, and carries the decomposition's own
 * `DependencyKind` so the distinction between "must follow" and "shares a
 * resource" survives the trip — it is the distinction the scheduler reads, and
 * flattening it here would mean re-deriving it later from nothing.
 */
export type GoalEdge =
  | {
    readonly edgeId: string;
    readonly kind: 'contributes_to';
    readonly fromNodeId: string;
    readonly toNodeId: string;
  }
  | {
    readonly edgeId: string;
    readonly kind: 'depends_on';
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly dependencyKind: DependencyKind;
  };

/**
 * How this graph was produced, in the vocabulary the decomposition module
 * already uses.
 *
 * Carried rather than summarised: an operator asking "why does this goal have
 * no steps" needs `atomicReason` and the engine provenance, and a graph that
 * said only "empty" would send them to read logs.
 */
export interface GoalGraphProvenance {
  /** The `proposalId` of the decomposition run this graph was built from. */
  readonly decompositionProposalId: string;
  readonly decompositionOutcome: 'decomposed' | 'atomic' | 'rejected';
  readonly decomposition: DecompositionProvenance;
  /** Set only when the outcome is `atomic`. */
  readonly atomicReason: AtomicReason | null;
  /** The engine's own violations, when it rejected its attempt. Else empty. */
  readonly violations: readonly DecompositionViolation[];
}

export interface GoalExecutionGraph {
  readonly version: typeof GOAL_GRAPH_CONTRACT_VERSION;
  readonly schema: typeof GOAL_GRAPH_SCHEMA_VERSION;
  readonly graphId: string;
  /** The `RuntimeMemoryRecord.id` of the confirmed goal this projects. */
  readonly goalMemoryId: string;
  readonly scopeId: string;
  /** The goal's own language, so a review screen renders AR/HE/EN correctly. */
  readonly language: GoalGraphLanguage;
  readonly nodes: readonly GoalNode[];
  readonly edges: readonly GoalEdge[];
  /** The caller's instant. Nothing in this module reads a clock. */
  readonly generatedAt: string;
  readonly generation: number;
  readonly provenance: GoalGraphProvenance;
}

/** Structurally `MemoryLanguage`; named here so the graph does not import it. */
export type GoalGraphLanguage = 'ar' | 'he' | 'en' | 'mixed';

/**
 * What can be wrong with a graph.
 *
 * `INVENTED_TIMING` is deliberately the decomposition module's own code and
 * the decomposition module's own rule — `statedValueAdmission`, which both
 * validators call — rather than a second spelling of the same judgement. The
 * others are topology, which decomposition has no opinion about.
 *
 * - `EMPTY_TITLE`                 — a node the reviewer would see as blank.
 * - `DUPLICATE_NODE_ID`           — two nodes sharing an id.
 * - `DUPLICATE_EDGE_ID`           — two edges sharing an id.
 * - `UNKNOWN_EDGE_ENDPOINT`       — an edge naming a node not in this graph.
 * - `SELF_EDGE`                   — a node pointing at itself.
 * - `CYCLIC_DEPENDENCY`           — the `depends_on` edges are not acyclic.
 * - `MISSING_REFERENCE`           — a linked node with no id to link to.
 * - `UNROOTED_NODE`               — a node with no path to a checkpoint, so
 *                                   nothing it represents advances anything.
 * - `CANONICAL_LINK_IN_PROPOSAL`  — a freshly generated graph containing a
 *                                   `linked_commitment` or `linked_habit`.
 *                                   Generation writes no canonical entity, so
 *                                   it has nothing to link to; a link here
 *                                   means something wrote one.
 * - `GRAPH_TOO_LARGE`             — more than `GOAL_GRAPH_MAX_NODES` nodes.
 * - `NOT_PROPOSED`                — a freshly generated node already claiming
 *                                   `confirmed`, which only the user can make
 *                                   a node.
 */
export type GoalGraphViolationCode =
  | 'EMPTY_TITLE'
  | 'DUPLICATE_NODE_ID'
  | 'DUPLICATE_EDGE_ID'
  | 'UNKNOWN_EDGE_ENDPOINT'
  | 'SELF_EDGE'
  | 'CYCLIC_DEPENDENCY'
  | 'INVENTED_TIMING'
  | 'MISSING_REFERENCE'
  | 'UNROOTED_NODE'
  | 'CANONICAL_LINK_IN_PROPOSAL'
  | 'GRAPH_TOO_LARGE'
  | 'NOT_PROPOSED';

export interface GoalGraphViolation {
  readonly code: GoalGraphViolationCode;
  /** The node or edge id at fault, or null for a graph-level finding. */
  readonly subjectId: string | null;
  /** Detail for an operator. Never the user's own text — see the audit policy. */
  readonly detail: string;
}

/**
 * What generating a graph may and may not do, as data.
 *
 * Stated here so that the claim is checkable rather than a paragraph in a
 * commit message — `tests/goalGraph/goalGraphIsolation.test.ts` reads it.
 */
export const GOAL_GRAPH_GENERATION_POLICY = Object.freeze({
  /** Generation is a pure function of the goal record and the engine's answer. */
  readonly: true,
  /** It creates no Commitment, no Habit, no plan and no reminder. */
  writesCanonicalState: false,
  /** It persists nothing at all, including the graph itself, in this slice. */
  persists: false,
  /** It resolves no relative time and emits no computed date. */
  resolvesTiming: false,
  /** A graph node never reaches `schedulePlan`; only materialized work does. */
  reachesScheduler: false,
} as const);
