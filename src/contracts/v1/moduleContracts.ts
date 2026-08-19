import { LIFE_STATE_SCHEMA_VERSION } from './lifeStateContracts';
import { MEMORY_RECORD_SCHEMA_VERSION } from './memoryContracts';

export const MODULE_CONTRACT_VERSION = 'v1' as const;

export const INTELLIGENCE_MODULES = [
  'capture',
  'lifeState',
  'memory',
  'priority',
  'decomposition',
  'planning',
  'recommendation',
  'coaching',
  'feedback',
  'safety',
  'evaluation',
] as const;

export type IntelligenceModuleName = (typeof INTELLIGENCE_MODULES)[number];

export type ContractErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNSUPPORTED_INPUT'
  | 'POLICY_REJECTED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ContractProvenance {
  traceId: string;
  producedAt: string;
  source: 'user_input' | 'deterministic_rule' | 'model_output' | 'system';
  confidence: number | null;
}

export interface ModuleInvocation<TInput> {
  scopeId: string;
  input: TInput;
  provenance: ContractProvenance;
}

export interface ModuleFailure {
  code: ContractErrorCode;
  message: string;
  retriable: boolean;
}

export interface ModuleResult<TOutput> {
  ok: true;
  output: TOutput;
  provenance: ContractProvenance;
}

export interface ModuleErrorResult {
  ok: false;
  error: ModuleFailure;
  provenance: ContractProvenance;
}

export type ModuleExecutionResult<TOutput> = ModuleResult<TOutput> | ModuleErrorResult;

export interface IntelligenceModuleContract<TInput, TOutput> {
  version: typeof MODULE_CONTRACT_VERSION;
  module: IntelligenceModuleName;
  owner: 'backend';
  allowsDirectStateWrites: false;
  allowedDependencyLayers: readonly ['contracts', 'deterministic-services', 'adapters'];
  inputDescription: string;
  outputDescription: string;
  execute: (invocation: ModuleInvocation<TInput>) => Promise<ModuleExecutionResult<TOutput>>;
}

interface CaptureInput {
  text: string;
  timezone: string;
  referenceTime: string;
}

interface CaptureOutput {
  disposition: 'proposed' | 'needs_clarification' | 'no_commitment' | 'unsupported_request';
  commitmentCount: number;
}

interface GenericModuleInput {
  scopeId: string;
  payload: Record<string, unknown>;
}

interface GenericModuleOutput {
  status: 'not_implemented_in_sprint_00';
}

/**
 * Reported by a module that has a real implementation behind it. The registry
 * entry stays a descriptor rather than a live call: modules are reached through
 * their own entry points, and routing every call through this table would make
 * it a dependency hub that every module has to import.
 */
interface ImplementedModuleOutput {
  status: 'implemented';
  module: IntelligenceModuleName;
  schemaVersion: string;
  entryPoint: string;
}

async function placeholderExecutor<TOutput>(provenance: ContractProvenance, output: TOutput): Promise<ModuleExecutionResult<TOutput>> {
  return { ok: true, output, provenance };
}

export const INTELLIGENCE_MODULE_CONTRACTS: Record<IntelligenceModuleName, IntelligenceModuleContract<unknown, unknown>> = {
  capture: {
    version: MODULE_CONTRACT_VERSION,
    module: 'capture',
    owner: 'backend',
    allowsDirectStateWrites: false,
    allowedDependencyLayers: ['contracts', 'deterministic-services', 'adapters'],
    inputDescription: 'Untrusted text capture requests resolved into proposal/clarification outcomes.',
    outputDescription: 'Capture disposition with count of commitment candidates.',
    execute: async (invocation: ModuleInvocation<unknown>) => placeholderExecutor(invocation.provenance, {
      disposition: 'proposed',
      commitmentCount: 0,
    } satisfies CaptureOutput),
  },
  lifeState: {
    version: MODULE_CONTRACT_VERSION,
    module: 'lifeState',
    owner: 'backend',
    allowsDirectStateWrites: false,
    allowedDependencyLayers: ['contracts', 'deterministic-services', 'adapters'],
    inputDescription: 'A DomainState snapshot plus an explicit `now`, projected without writes.',
    outputDescription: 'A LifeState read model; see lifeStateContracts and lib/lifeState.',
    execute: async (invocation: ModuleInvocation<unknown>) => placeholderExecutor(invocation.provenance, {
      status: 'implemented',
      module: 'lifeState',
      schemaVersion: LIFE_STATE_SCHEMA_VERSION,
      entryPoint: 'lib/lifeState/lifeStateProjection#projectLifeState',
    } satisfies ImplementedModuleOutput),
  },
  memory: {
    version: MODULE_CONTRACT_VERSION,
    module: 'memory',
    owner: 'backend',
    allowsDirectStateWrites: false,
    allowedDependencyLayers: ['contracts', 'deterministic-services', 'adapters'],
    inputDescription: 'Provenance-aware runtime memory writes, retrieval, revocation, and export.',
    outputDescription: 'RuntimeMemoryRecords; see memoryContracts and lib/runtimeMemory.',
    execute: async (invocation: ModuleInvocation<unknown>) => placeholderExecutor(invocation.provenance, {
      status: 'implemented',
      module: 'memory',
      schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
      entryPoint: 'lib/runtimeMemory/runtimeMemoryStore#createFileRuntimeMemoryStore',
    } satisfies ImplementedModuleOutput),
  },
  priority: {
    version: MODULE_CONTRACT_VERSION,
    module: 'priority',
    owner: 'backend',
    allowsDirectStateWrites: false,
    allowedDependencyLayers: ['contracts', 'deterministic-services', 'adapters'],
    inputDescription: 'Priority scoring requests from deterministic features.',
    outputDescription: 'Non-operative placeholder until Sprint 04+ gates pass.',
    execute: async (invocation: ModuleInvocation<unknown>) => placeholderExecutor(invocation.provenance, { status: 'not_implemented_in_sprint_00' } satisfies GenericModuleOutput),
  },
  decomposition: {
    version: MODULE_CONTRACT_VERSION,
    module: 'decomposition',
    owner: 'backend',
    allowsDirectStateWrites: false,
    allowedDependencyLayers: ['contracts', 'deterministic-services', 'adapters'],
    inputDescription: 'One commitment\'s text, proposed as multiple steps without rewriting it.',
    outputDescription: 'A DecompositionProposal; see decompositionContracts and lib/decomposition.',
    execute: async (invocation: ModuleInvocation<unknown>) => placeholderExecutor(invocation.provenance, {
      status: 'implemented',
      module: 'decomposition',
      // Spelled out rather than imported from `decompositionContracts`, which
      // imports `MODULE_CONTRACT_VERSION` from this file. Importing it back
      // closes a cycle, and ESM resolves that cycle by evaluating
      // `decompositionContracts` while this module's body has not run — so
      // `DECOMPOSITION_CONTRACT_VERSION = MODULE_CONTRACT_VERSION` throws a
      // TDZ ReferenceError at import time. `tsc` reports nothing; the crash is
      // runtime-only. `contract: the decomposition module descriptor matches
      // the decomposition schema version` pins the two together instead.
      schemaVersion: 'decomposition-v1',
      entryPoint: 'lib/decomposition/engine#proposeDecomposition',
    } satisfies ImplementedModuleOutput),
  },
  planning: {
    version: MODULE_CONTRACT_VERSION,
    module: 'planning',
    owner: 'backend',
    allowsDirectStateWrites: false,
    allowedDependencyLayers: ['contracts', 'deterministic-services', 'adapters'],
    inputDescription: 'PlanningConstraints plus a PlanningConfig; no ambient clock, every instant from the input.',
    outputDescription: 'A Plan; see planningContracts and lib/planning.',
    execute: async (invocation: ModuleInvocation<unknown>) => placeholderExecutor(invocation.provenance, {
      status: 'implemented',
      module: 'planning',
      // Spelled out for the same reason as `decomposition` above:
      // `planningContracts` imports `MODULE_CONTRACT_VERSION` from this file,
      // so importing `PLANNING_SCHEMA_VERSION` back closes a cycle that ESM
      // resolves by evaluating `planningContracts` before this module's body
      // has run — a TDZ ReferenceError at import time that `tsc` reports
      // nothing about. `the planning module descriptor matches the planning
      // schema version` in tests/contract/intelligenceModuleBoundaries.test.ts
      // pins the two spellings together instead.
      schemaVersion: 'planning-v1',
      entryPoint: 'lib/planning/scheduler#schedulePlan',
    } satisfies ImplementedModuleOutput),
  },
  recommendation: {
    version: MODULE_CONTRACT_VERSION,
    module: 'recommendation',
    owner: 'backend',
    allowsDirectStateWrites: false,
    allowedDependencyLayers: ['contracts', 'deterministic-services', 'adapters'],
    inputDescription: 'Priority and Planning outputs plus an explicit `now`; no ambient clock, every instant from the input.',
    outputDescription: 'A Recommendation; see recommendationContracts and lib/recommendation.',
    execute: async (invocation: ModuleInvocation<unknown>) => placeholderExecutor(invocation.provenance, {
      status: 'implemented',
      module: 'recommendation',
      // Spelled out for the same reason as `decomposition` and `planning`
      // above: `recommendationContracts` imports `MODULE_CONTRACT_VERSION`
      // from this file, so importing `RECOMMENDATION_SCHEMA_VERSION` back
      // closes a cycle that ESM resolves by evaluating `recommendationContracts`
      // before this module's body has run — a TDZ ReferenceError at import
      // time that `tsc` reports nothing about. `the recommendation module
      // descriptor matches the recommendation schema version` in
      // tests/contract/intelligenceModuleBoundaries.test.ts pins the two
      // spellings together instead.
      schemaVersion: 'recommendation-v1',
      entryPoint: 'lib/recommendation#selectRecommendation',
    } satisfies ImplementedModuleOutput),
  },
  coaching: {
    version: MODULE_CONTRACT_VERSION,
    module: 'coaching',
    owner: 'backend',
    allowsDirectStateWrites: false,
    allowedDependencyLayers: ['contracts', 'deterministic-services', 'adapters'],
    inputDescription: 'Coaching response planning requests bounded by safety policies.',
    outputDescription: 'Non-operative placeholder until Sprint 09+ gates pass.',
    execute: async (invocation: ModuleInvocation<unknown>) => placeholderExecutor(invocation.provenance, { status: 'not_implemented_in_sprint_00' } satisfies GenericModuleOutput),
  },
  feedback: {
    version: MODULE_CONTRACT_VERSION,
    module: 'feedback',
    owner: 'backend',
    allowsDirectStateWrites: false,
    allowedDependencyLayers: ['contracts', 'deterministic-services', 'adapters'],
    inputDescription: 'Behavioral feedback ingestion and aggregation inputs.',
    outputDescription: 'Non-operative placeholder until Sprint 03+ gates pass.',
    execute: async (invocation: ModuleInvocation<unknown>) => placeholderExecutor(invocation.provenance, { status: 'not_implemented_in_sprint_00' } satisfies GenericModuleOutput),
  },
  safety: {
    version: MODULE_CONTRACT_VERSION,
    module: 'safety',
    owner: 'backend',
    allowsDirectStateWrites: false,
    allowedDependencyLayers: ['contracts', 'deterministic-services', 'adapters'],
    inputDescription: 'A candidate output carrying claims and evidence references, plus the request it answers and an explicit `now`; no ambient clock.',
    outputDescription: 'A SafetyVerdict and its audit record; see safetyContracts and lib/safety.',
    execute: async (invocation: ModuleInvocation<unknown>) => placeholderExecutor(invocation.provenance, {
      status: 'implemented',
      module: 'safety',
      // Spelled out for the same reason as `decomposition`, `planning` and
      // `recommendation` above: `safetyContracts` imports
      // `MODULE_CONTRACT_VERSION` from this file, so importing
      // `SAFETY_SCHEMA_VERSION` back closes a cycle that ESM resolves by
      // evaluating `safetyContracts` before this module's body has run — a TDZ
      // ReferenceError at import time that `tsc` reports nothing about. The
      // cycle would be two hops long here rather than one, because
      // `safetyContracts` also imports `recommendationContracts`, which imports
      // this file; a longer cycle is not a safer one. `the safety module
      // descriptor matches the safety schema version` in
      // tests/contract/intelligenceModuleBoundaries.test.ts pins the two
      // spellings together instead.
      schemaVersion: 'safety-v1',
      entryPoint: 'lib/safety#evaluateSafetyGate',
    } satisfies ImplementedModuleOutput),
  },
  evaluation: {
    version: MODULE_CONTRACT_VERSION,
    module: 'evaluation',
    owner: 'backend',
    allowsDirectStateWrites: false,
    allowedDependencyLayers: ['contracts', 'deterministic-services', 'adapters'],
    inputDescription: 'Offline evaluation requests and gate evidence assembly.',
    outputDescription: 'Non-operative placeholder until sprint-specific gates execute.',
    execute: async (invocation: ModuleInvocation<unknown>) => placeholderExecutor(invocation.provenance, { status: 'not_implemented_in_sprint_00' } satisfies GenericModuleOutput),
  },
};

export const HARD_CONSTRAINT_DETERMINISTIC_SERVICES = [
  'commandService',
  'stateMachine',
] as const;

export const STATE_WRITE_POLICY = Object.freeze({
  rule: 'Intelligence modules MAY NOT write canonical user state directly.',
  requiredPath: 'Intelligence -> deterministic service command -> persistence adapter',
});

export type _CaptureInputExample = CaptureInput;
export type _GenericModuleInputExample = GenericModuleInput;
