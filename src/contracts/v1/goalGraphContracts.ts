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
  /**
   * What the step looks like it wants to become, when a goal planner proposed
   * it (CL3). Absent on a step split out of the goal's own sentence, where the
   * engine has no opinion. Only ever a default for the review screen: the user
   * still picks commitment or habit, and a habit still needs the cadence they
   * state — #520's rule does not bend because a model guessed "habit".
   */
  readonly suggestedAs?: GoalStepSuggestedKind;
  /**
   * A coarse "when would this fit" bucket for the review screen, or absent.
   *
   * Deliberately a closed vocabulary rather than a time: it is never resolved
   * against a clock, never copied onto the commitment the step becomes, and
   * never read by the planner. "No invented deadlines" holds because there is
   * still nowhere on a node to put a date; this is a hint a person reads.
   */
  readonly suggestedWhen?: GoalStepSuggestedWhen;
}

/** One-off work, or something that repeats. */
export type GoalStepSuggestedKind = 'commitment' | 'habit';

/** The whole vocabulary of a suggested timing. Nothing finer exists. */
export const GOAL_STEP_SUGGESTED_WHEN = Object.freeze(['today', 'this_week', 'this_month'] as const);
export type GoalStepSuggestedWhen = typeof GOAL_STEP_SUGGESTED_WHEN[number];

/**
 * Where the step nodes of a graph came from (CL3).
 *
 * - `sentence` — the decomposition engine split the goal's own sentence.
 * - `model`    — the goal planner model proposed them, and they passed
 *                `validateGoalStepDraft`. Stored per generation, so a confirm
 *                resolves the same steps the user reviewed.
 * - `sentence_and_model` — the sentence split, and its clauses come first;
 *                the model's steps that are not the same clauses follow,
 *                up to six in all. The model adds; it never replaces what
 *                the person already wrote.
 * - `template` — neither of the above produced steps, so a deterministic
 *                starting point for the goal's shape was offered instead of
 *                an empty screen.
 */
export type GoalStepSource = 'sentence' | 'sentence_and_model' | 'model' | 'template';

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
  /** Which reading the step nodes are (CL3). */
  readonly stepSource: GoalStepSource;
  /**
   * Why the goal planner model did not supply the steps, as a reason code —
   * `consent_required`, `provider_none`, `model_output_invalid:too_few`, … —
   * or null when it did. Never the model's words and never the goal's.
   */
  readonly stepSourceReason: string | null;
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
  /**
   * The graph itself is never stored. What is (CL3) is the goal planner
   * model's validated step list for one generation, in `goalGraphProposals`,
   * because a model does not answer the same way twice and a confirm has to
   * resolve the steps the user actually reviewed. Nothing canonical, and
   * nothing when the steps came from the sentence or a template.
   */
  persists: 'model_steps_only',
  /** It resolves no relative time and emits no computed date. */
  resolvesTiming: false,
  /** A graph node never reaches `schedulePlan`; only materialized work does. */
  reachesScheduler: false,
} as const);

/* ── Confirmation and progress (#526, slice 2) ──────────────────── */

/**
 * What one confirmed node became.
 *
 * The whole of what slice 2 persists. Not the graph — the nodes and edges are
 * still recomputed from the goal's sentence every time, because a proposal
 * nobody accepted is worth nothing the next morning. What is worth keeping is
 * the decision: this user, on this node, said yes, and this is the id of the
 * thing that answer created.
 *
 * `entityId` is the Commitment id or the Habit id, and there is deliberately
 * no copy of the entity beside it — no title, no status, no due date. Progress
 * is read from the canonical entity through this pointer, which is what makes
 * "linked Commitment completion changes derived progress automatically" true
 * by construction instead of by a sync job.
 *
 * `state` exists because creating the canonical entity is not atomic with
 * claiming the link. `pending` is the window between the two; see
 * `confirmGoalGraphNodes`, which is the only writer of either value.
 */
export interface GoalNodeLink {
  readonly schemaVersion: typeof GOAL_GRAPH_LINK_SCHEMA_VERSION;
  readonly linkId: string;
  readonly scopeId: string;
  readonly goalMemoryId: string;
  /**
   * Which node this link answers for, without the generation it was confirmed
   * at — `step.s1`, not `g1.step.s1`. See `goalNodeKeyOf`.
   *
   * Regeneration mints new node ids for the same steps, so a link keyed on the
   * raw id would detach from its node the first time a user pressed
   * regenerate, and confirming that node again would create a second
   * Commitment for work they already have.
   */
  readonly nodeKey: string;
  /** The generation the user was looking at. Provenance, never a key. */
  readonly confirmedFromGeneration: number;
  readonly entityKind: GoalLinkEntityKind;
  /** Null only while `state` is `pending`. */
  readonly entityId: string | null;
  readonly state: 'pending' | 'linked';
  readonly confirmedByUserAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const GOAL_GRAPH_LINK_SCHEMA_VERSION = 1 as const;

export type GoalLinkEntityKind = 'commitment' | 'habit';

/**
 * The node kinds a user may turn into canonical work.
 *
 * A `checkpoint` is not among them, and that is a rule rather than an
 * oversight: the checkpoint *is* the goal, so materializing it would create a
 * commitment that duplicates the goal record and a second place for the same
 * sentence to be edited. The linked kinds are excluded because a node that is
 * already a link has nothing left to create.
 */
export const CONFIRMABLE_GOAL_NODE_KINDS: readonly GoalNodeKind[] = Object.freeze([
  'milestone_proposal',
  'decomposition_step_proposal',
]);

/**
 * One node the user picked, and what they picked it to be.
 *
 * `as: 'habit'` carries the habit's own fields rather than defaulting them,
 * and that is #520's invariant restated here: a habit is a standing claim on
 * somebody's week, so the cadence and the duration must be things the person
 * stated. Defaulting them from a goal sentence would be the product deciding
 * how often somebody goes to the gym.
 */
export type GoalNodeSelection =
  | { readonly nodeId: string; readonly as: 'commitment' }
  | {
    readonly nodeId: string;
    readonly as: 'habit';
    /** Validated by the habits API's own `parseNewHabit`; never trusted raw. */
    readonly habit: Record<string, unknown>;
  };

/** Why one selected node produced nothing. */
export type GoalConfirmationRefusalCode =
  | 'unknown_node'
  | 'node_not_confirmable'
  | 'habit_input_invalid';

export interface GoalConfirmationRefusal {
  readonly nodeId: string;
  readonly nodeKey: string;
  readonly code: GoalConfirmationRefusalCode;
  readonly detail: string;
}

export interface GoalConfirmationResult {
  /**
   * The graph with every linked node replaced in place. The `nodeId` is
   * unchanged, so every edge that pointed at the proposal still points at the
   * link — and the title is gone, because after confirmation the title lives
   * on the Commitment and a second copy would be the one that went stale.
   */
  readonly graph: GoalExecutionGraph;
  /** Links this call created. Empty on a replay. */
  readonly created: readonly GoalNodeLink[];
  /** Links that already existed, handed back rather than created again. */
  readonly replayed: readonly GoalNodeLink[];
  readonly refused: readonly GoalConfirmationRefusal[];
}

/**
 * Progress, derived and never stored.
 *
 * #526's rule is "do not let the model set 73% complete", and the shape here
 * is the structural half of that: there is no percentage field, no score, and
 * nothing a writer could put a number into. Every value below is counted from
 * the canonical entities the links point at, at the moment of the read, by a
 * function that performs no write at all.
 *
 * Counts rather than a fraction because the issue's own examples are counts —
 * "3 of 5", "2 of 3 commitments", "occurrences achieved this period" — and
 * because a single number is the field a model would eventually be asked to
 * fill in.
 */
export interface GoalGraphProgress {
  readonly scopeId: string;
  readonly goalMemoryId: string;
  /** How many nodes the user has confirmed into canonical work. */
  readonly confirmedCount: number;
  /** How many of those the canonical entity says are done. */
  readonly completedCount: number;
  readonly nodes: readonly GoalNodeProgress[];
  /** The caller's instant. Nothing here reads a clock. */
  readonly derivedAt: string;
}

/**
 * `missing` is a real state, not an error: a user may delete a Commitment that
 * a goal node points at, and #526 says unlinking must not destroy canonical
 * work — the converse is that destroying canonical work must not corrupt the
 * graph. A missing entity counts as not completed and says so.
 */
export type GoalNodeProgress =
  | {
    readonly nodeKey: string;
    readonly entityKind: 'commitment';
    readonly entityId: string;
    readonly status: string | 'missing';
    readonly completed: boolean;
  }
  | {
    readonly nodeKey: string;
    readonly entityKind: 'habit';
    readonly entityId: string;
    /** Occurrences marked completed inside the period the caller asked about. */
    readonly completedOccurrences: number;
    /** The habit's own `minimumOccurrences`, or 0 when the habit is gone. */
    readonly targetOccurrences: number;
    readonly completed: boolean;
  };

/** The window "this period" means, as civil dates. Supplied, never guessed. */
export interface GoalProgressPeriod {
  readonly fromLocalDate: string;
  readonly toLocalDate: string;
}
