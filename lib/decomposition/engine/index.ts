/**
 * The decomposition engine: rules first, model optional, giving up explicitly.
 *
 * The control flow has one invariant worth stating up front, because every
 * branch below is arranged to preserve it: **nothing leaves this module that
 * has not been through `validateDecomposition`.** Model output, rules output
 * and model-output-repaired-by-rules all pass through the same check, so a
 * consumer never has to ask which engine produced a proposal in order to know
 * how much to trust its spans.
 *
 * The second invariant is that a fallback always says why. `DecompositionProvenance`
 * makes `fallbackUsed: true` without a reason unrepresentable, and the reason
 * strings below name the *cause* (`kill_switch_active`, `model_provider_failed`)
 * rather than the effect ("used rules") — a week later "used rules" is
 * indistinguishable from a deliberate rules-only run, which is the confusion
 * the field exists to prevent.
 */

import {
  DECOMPOSITION_CONTRACT_VERSION,
  DECOMPOSITION_SCHEMA_VERSION,
  type AtomicProposal,
  type AtomicReason,
  type DecompositionProposal,
  type DecompositionProvenance,
  type DecompositionStepProposal,
  type DecompositionViolation,
  type RejectedProposal,
  type SourceSpan,
  type StepDependency,
} from '../../../src/contracts/v1/decompositionContracts';
import { resolveModuleRuntime, type RuntimeControlSnapshot } from '../../../src/contracts/v1/runtimeControls';
import { detectSteps } from './rulesDetector';
import { validateDecomposition } from './validator';
import type { DecompositionModelProvider } from './modelProvider';

export * from './modelProvider';
export * from './rulesDetector';
export * from './validator';

/**
 * Decomposition runs under the `planning` runtime module.
 *
 * There is no `decomposition` entry in `INTELLIGENCE_MODULES`, and adding one
 * would edit a contract three tracks share mid-sprint. `planning` is the module
 * the roadmap files this capability under, so its feature flag and kill switch
 * are the ones an operator would reach for anyway.
 */
const RUNTIME_MODULE = 'planning' as const;

export interface DecompositionEngineInput {
  readonly proposalId: string;
  readonly commitmentId: string;
  readonly sourceText: string;
  /** Defaults to `'model'`; `'rules'` asks for the deterministic path on purpose. */
  readonly requestedEngine?: 'model' | 'rules';
  /** Splits scoring below this are withheld as `below_confidence`. Defaults to 0. */
  readonly minimumConfidence?: number;
  /**
   * Defaults to true. Setting it false is how a caller says "model or nothing":
   * it converts every fallback into an explicit atomic outcome instead of
   * silently substituting a different engine's answer.
   */
  readonly allowRulesFallback?: boolean;
  /** Ground truth from outside the engine that this commitment is one action. */
  readonly declaredAtomic?: boolean;
}

export interface DecompositionEngineDependencies {
  readonly modelProvider?: DecompositionModelProvider;
  readonly controls?: RuntimeControlSnapshot;
}

interface ProposalBaseFields {
  readonly version: typeof DECOMPOSITION_CONTRACT_VERSION;
  readonly schema: typeof DECOMPOSITION_SCHEMA_VERSION;
  readonly proposalId: string;
  readonly commitmentId: string;
  readonly sourceText: string;
}

function baseFields(input: DecompositionEngineInput): ProposalBaseFields {
  return {
    version: DECOMPOSITION_CONTRACT_VERSION,
    schema: DECOMPOSITION_SCHEMA_VERSION,
    proposalId: input.proposalId,
    commitmentId: input.commitmentId,
    sourceText: input.sourceText,
  };
}

function atomic(
  input: DecompositionEngineInput,
  provenance: DecompositionProvenance,
  reason: AtomicReason,
): AtomicProposal {
  return { ...baseFields(input), provenance, outcome: 'atomic', reason };
}

function rejected(
  input: DecompositionEngineInput,
  provenance: DecompositionProvenance,
  violations: readonly DecompositionViolation[],
): RejectedProposal {
  return {
    ...baseFields(input),
    provenance,
    outcome: 'rejected',
    violations: violations as unknown as RejectedProposal['violations'],
  };
}

/**
 * Turn a validated step list into a proposal.
 *
 * The length check is the type's own precondition rather than a policy: a
 * `DecomposedProposal` is a two-or-more tuple, so a one-step list has no
 * representation here and must become an atomic outcome upstream. Returning
 * null makes that unavoidable at the call site.
 */
function decomposed(
  input: DecompositionEngineInput,
  provenance: DecompositionProvenance,
  steps: readonly DecompositionStepProposal[],
): DecompositionProposal | null {
  if (steps.length < 2) return null;
  return {
    ...baseFields(input),
    provenance,
    outcome: 'decomposed',
    steps: steps as unknown as Extract<DecompositionProposal, { outcome: 'decomposed' }>['steps'],
  };
}

function provenanceOf(
  requestedEngine: 'model' | 'rules',
  executedEngine: 'model' | 'rules',
  fallbackReason: string | null,
): DecompositionProvenance {
  if (fallbackReason === null) return { requestedEngine, executedEngine, fallbackUsed: false };
  return { requestedEngine, executedEngine, fallbackUsed: true, fallbackReason };
}

/**
 * Turn whatever the provider returned into plain, bounded data — or nothing.
 *
 * `DecompositionModelDraft` is a TypeScript type and TypeScript is erased, so a
 * provider is free to return anything: values of the wrong type, accessors that
 * throw, accessors that answer differently each time, a `Proxy` that traps
 * `every`, or an object nested deeply enough to overflow the stack in
 * `structuredClone`. An earlier version type-checked the fields but did the
 * checking *outside* any `try`, which made the guard itself the unprotected
 * surface.
 *
 * Three properties, none of which a bare type-check provides:
 *
 *  1. **Every field is read exactly once**, into a fresh plain object. A value
 *     that changes between reads therefore cannot be validated as one thing and
 *     used as another.
 *  2. **Only known fields are copied**, so a hostile extra property — however
 *     deep — never reaches `structuredClone` or the store.
 *  3. **Cardinality is bounded** before anything is allocated per element, so a
 *     draft cannot ask this process to build a million steps or thirty million
 *     violations.
 *
 * The whole thing runs inside one `try`: any throw at all means the draft is
 * not usable, which is a rules fallback, not an exception out of the boundary.
 */
const MAX_DRAFT_STEPS = 200;
const MAX_SPANS_PER_STEP = 20;
const MAX_TOTAL_SPANS = 500;
const MAX_EDGES_PER_STEP = 50;

const DEPENDENCY_KINDS: ReadonlySet<string> = new Set(['temporal', 'resource', 'informational']);

/**
 * Step ids travel into violation `detail` strings and become persistence keys,
 * so a provider does not get to choose their shape.
 */
const DRAFT_STEP_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface NormalisedDraft {
  readonly steps: readonly DecompositionStepProposal[];
  readonly confidence: number;
}

function normaliseSpan(value: unknown): SourceSpan {
  if (!isRecord(value)) throw new Error('span is not an object');
  const start = value.start;
  const end = value.end;
  const text = value.text;
  if (!Number.isInteger(start) || !Number.isInteger(end) || typeof text !== 'string') {
    throw new Error('span field has the wrong type');
  }
  return { start: start as number, end: end as number, text };
}

function normaliseEdge(value: unknown): StepDependency {
  if (!isRecord(value)) throw new Error('edge is not an object');
  const dependsOnStepId = value.dependsOnStepId;
  const kind = value.kind;
  if (typeof dependsOnStepId !== 'string' || typeof kind !== 'string' || !DEPENDENCY_KINDS.has(kind)) {
    throw new Error('edge field has the wrong type');
  }
  return { dependsOnStepId, kind: kind as StepDependency['kind'] };
}

function normaliseDraft(draft: unknown): NormalisedDraft | null {
  try {
    if (!isRecord(draft)) return null;

    const confidence = draft.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;

    const rawSteps = draft.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length > MAX_DRAFT_STEPS) return null;

    const steps: DecompositionStepProposal[] = [];
    let totalSpans = 0;

    for (let index = 0; index < rawSteps.length; index += 1) {
      const raw: unknown = rawSteps[index];
      if (!isRecord(raw)) return null;

      const stepId = raw.stepId;
      const title = raw.title;
      const inferred = raw.inferred;
      const statedTiming = raw.statedTiming;
      const statedOwner = raw.statedOwner;
      const rawSpans = raw.sourceSpans;
      const rawEdges = raw.dependsOn;

      if (typeof stepId !== 'string' || !DRAFT_STEP_ID.test(stepId)) return null;
      if (typeof title !== 'string') return null;
      if (typeof inferred !== 'boolean') return null;
      if (statedTiming !== null && typeof statedTiming !== 'string') return null;
      if (statedOwner !== null && typeof statedOwner !== 'string') return null;
      if (!Array.isArray(rawSpans) || rawSpans.length > MAX_SPANS_PER_STEP) return null;
      if (!Array.isArray(rawEdges) || rawEdges.length > MAX_EDGES_PER_STEP) return null;

      totalSpans += rawSpans.length;
      if (totalSpans > MAX_TOTAL_SPANS) return null;

      steps.push({
        stepId,
        title,
        inferred,
        statedTiming,
        statedOwner,
        sourceSpans: rawSpans.map(normaliseSpan),
        dependsOn: rawEdges.map(normaliseEdge),
      });
    }
    return { steps, confidence };
  } catch {
    // Any throw at all — a hostile accessor, a proxy trap, a stack overflow
    // from something nested — means the draft is not usable. That is a
    // fallback, not an exception out of the boundary.
    return null;
  }
}

/**
 * At least as many sourced steps as inferred ones.
 *
 * `inferred: true` legitimately exempts a step from title provenance — it
 * admits having no source — but the exemption is one provider-supplied boolean,
 * and a draft of entirely inferred steps passed validation with zero violations
 * and carried arbitrary text to the user and the adapter. A decomposition
 * claims to decompose *this sentence*: if the sourced steps do not outnumber
 * the invented ones, it is the engine's plan, not a reading of what the user
 * wrote. The non-arbitrary part is that a proposal with no sourced step at all
 * is not grounded in anything; the exact ratio is a policy choice, set here at
 * "the majority must be sourced" and stated rather than buried.
 *
 * It bounds *proportion*, not content: a minority inferred step's title is
 * still provider-authored text that no check can ground, which is recorded in
 * the validator's own "what this proves" section and survives to the persisted
 * record as `inferred: true`.
 */
function isMostlySourced(steps: readonly DecompositionStepProposal[]): boolean {
  const inferred = steps.filter((step) => step.inferred).length;
  return steps.length - inferred > inferred;
}

export async function proposeDecomposition(
  input: DecompositionEngineInput,
  dependencies: DecompositionEngineDependencies = {},
): Promise<DecompositionProposal> {
  const requestedEngine = input.requestedEngine ?? 'model';
  const minimumConfidence = input.minimumConfidence ?? 0;
  const allowRulesFallback = input.allowRulesFallback ?? true;
  const runtime = resolveModuleRuntime(RUNTIME_MODULE, dependencies.controls);

  const validate = (steps: readonly DecompositionStepProposal[]): readonly DecompositionViolation[] =>
    validateDecomposition({
      sourceText: input.sourceText,
      steps,
      declaredAtomic: input.declaredAtomic,
    });

  /** Run the deterministic path, or say why we are not allowed to. */
  const runRules = (fallbackReason: string | null): DecompositionProposal => {
    if (fallbackReason !== null && !allowRulesFallback) {
      // The caller asked for model-or-nothing. Substituting a different
      // engine's answer here would be the exact thing they disabled.
      const reason: AtomicReason = fallbackReason.includes('output_invalid')
        ? 'validation_rejected'
        : fallbackReason.includes('below_confidence')
          ? 'below_confidence'
          : 'engine_unavailable';
      // `executedEngine` has no "neither" value in the contract; the model is
      // the engine this attempt belongs to, and the atomic reason carries the
      // fact that it produced nothing.
      return atomic(input, provenanceOf(requestedEngine, 'model', null), reason);
    }

    const provenance = provenanceOf(requestedEngine, 'rules', fallbackReason);
    const detected = detectSteps(input.sourceText);
    if (detected.steps.length < 2) return atomic(input, provenance, 'not_decomposable');
    if (detected.confidence < minimumConfidence) return atomic(input, provenance, 'below_confidence');

    const violations = validate(detected.steps);
    if (violations.length > 0) return rejected(input, provenance, violations);
    return decomposed(input, provenance, detected.steps)
      ?? atomic(input, provenance, 'not_decomposable');
  };

  if (requestedEngine === 'rules') return runRules(null);
  if (runtime.mode === 'rules_only') return runRules(`rules_only_runtime:${runtime.reason}`);
  if (!dependencies.modelProvider) return runRules('model_provider_absent');

  let draft;
  try {
    draft = await dependencies.modelProvider.propose({ sourceText: input.sourceText });
  } catch {
    // The error itself is not carried into the reason: provider errors quote
    // upstream payloads often enough that a reason string is a leak waiting to
    // happen, and provenance travels with the proposal.
    return runRules('model_provider_failed');
  }

  const normalised = normaliseDraft(draft);
  if (normalised === null) return runRules('model_output_invalid:malformed');
  const draftSteps = normalised.steps;

  if (normalised.confidence < minimumConfidence) return runRules('model_below_confidence');
  if (draftSteps.length === 0) {
    // The model's considered verdict that this is one action. Overriding it
    // with the rules detector would make the model's opinion decorative.
    return atomic(input, provenanceOf(requestedEngine, 'model', null), 'not_decomposable');
  }
  if (draftSteps.length === 1) return runRules('model_returned_single_step');
  if (!isMostlySourced(draftSteps)) return runRules('model_output_invalid:mostly_inferred');

  // Belt and braces: the shape guard above is what makes validation safe, but a
  // field it does not know about must not be able to throw out of the boundary.
  let violations: readonly DecompositionViolation[];
  try {
    violations = validate(draftSteps);
  } catch {
    return runRules('model_output_invalid:validation_threw');
  }
  if (violations.length > 0) return runRules('model_output_invalid');

  const provenance = provenanceOf(requestedEngine, 'model', null);
  return decomposed(input, provenance, draftSteps)
    ?? atomic(input, provenance, 'not_decomposable');
}
