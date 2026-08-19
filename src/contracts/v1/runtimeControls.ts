import {
  INTELLIGENCE_MODULES,
  MODULE_CONTRACT_VERSION,
  type IntelligenceModuleName,
} from './moduleContracts';

export type ModuleFeatureFlags = Readonly<Record<IntelligenceModuleName, boolean>>;
export type ModuleKillSwitches = Readonly<Record<IntelligenceModuleName, boolean>>;

export const MODULE_FEATURE_FLAG_DEFAULTS: ModuleFeatureFlags = Object.freeze({
  capture: true,
  lifeState: false,
  memory: false,
  priority: false,
  decomposition: false,
  planning: false,
  recommendation: false,
  coaching: false,
  feedback: false,
  safety: false,
  evaluation: false,
});

export const MODULE_KILL_SWITCH_DEFAULTS: ModuleKillSwitches = Object.freeze({
  capture: false,
  lifeState: false,
  memory: false,
  priority: false,
  decomposition: false,
  planning: false,
  recommendation: false,
  coaching: false,
  feedback: false,
  safety: false,
  evaluation: false,
});

export type RulesOnlyFallbackReason =
  | 'feature_disabled'
  | 'kill_switch_active'
  | 'module_unavailable';

export interface RulesOnlyFallbackContract {
  version: typeof MODULE_CONTRACT_VERSION;
  module: IntelligenceModuleName;
  mode: 'rules_only';
  reason: RulesOnlyFallbackReason;
  allowsModelExecution: false;
  allowsDirectStateWrites: false;
  captureRemainsAvailable: true;
}

export type ModuleRuntimeDecision =
  | {
      version: typeof MODULE_CONTRACT_VERSION;
      module: IntelligenceModuleName;
      mode: 'enabled';
      allowsModelExecution: true;
    }
  | RulesOnlyFallbackContract;

export interface RuntimeControlSnapshot {
  version: typeof MODULE_CONTRACT_VERSION;
  featureFlags: ModuleFeatureFlags;
  killSwitches: ModuleKillSwitches;
}

export type RuntimeControlEnv = Record<string, string | undefined>;

function envToken(module: IntelligenceModuleName): string {
  return module.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export function readRuntimeControls(
  env: RuntimeControlEnv = process.env,
): RuntimeControlSnapshot {
  const featureFlags = { ...MODULE_FEATURE_FLAG_DEFAULTS };
  const killSwitches = { ...MODULE_KILL_SWITCH_DEFAULTS };

  for (const module of INTELLIGENCE_MODULES) {
    const token = envToken(module);
    featureFlags[module] = readBoolean(
      env[`MAYBESITTER_FEATURE_${token}`],
      MODULE_FEATURE_FLAG_DEFAULTS[module],
    );
    killSwitches[module] = readBoolean(
      env[`MAYBESITTER_KILL_SWITCH_${token}`],
      MODULE_KILL_SWITCH_DEFAULTS[module],
    );
  }

  return {
    version: MODULE_CONTRACT_VERSION,
    featureFlags: Object.freeze(featureFlags),
    killSwitches: Object.freeze(killSwitches),
  };
}

export function resolveModuleRuntime(
  module: IntelligenceModuleName,
  controls: RuntimeControlSnapshot = readRuntimeControls(),
): ModuleRuntimeDecision {
  if (controls.killSwitches[module]) {
    return {
      version: MODULE_CONTRACT_VERSION,
      module,
      mode: 'rules_only',
      reason: 'kill_switch_active',
      allowsModelExecution: false,
      allowsDirectStateWrites: false,
      captureRemainsAvailable: true,
    };
  }

  if (!controls.featureFlags[module]) {
    return {
      version: MODULE_CONTRACT_VERSION,
      module,
      mode: 'rules_only',
      reason: 'feature_disabled',
      allowsModelExecution: false,
      allowsDirectStateWrites: false,
      captureRemainsAvailable: true,
    };
  }

  return {
    version: MODULE_CONTRACT_VERSION,
    module,
    mode: 'enabled',
    allowsModelExecution: true,
  };
}

export type AuditOutcome = 'started' | 'succeeded' | 'rejected' | 'failed' | 'fell_back';

export interface AuditSafeFields {
  outcome: AuditOutcome;
  reasonCode?: string;
  durationMs?: number;
  itemCount?: number;
  inputHash?: string;
  inputLength?: number;
  rulesOnly?: boolean;
}

export interface AuditEventEnvelope {
  version: typeof MODULE_CONTRACT_VERSION;
  eventId: string;
  eventType: 'module_runtime_decision' | 'module_execution';
  occurredAt: string;
  correlationId: string;
  causationId: string | null;
  module: IntelligenceModuleName;
  fields: AuditSafeFields;
}

export interface CreateAuditEventInput {
  eventId: string;
  eventType: AuditEventEnvelope['eventType'];
  occurredAt: string;
  correlationId: string;
  causationId?: string | null;
  module: IntelligenceModuleName;
  fields: AuditSafeFields;
}

/**
 * Builds the public audit envelope by copying an explicit allowlist. Unknown
 * properties (including rawText, prompt, title, and transcript) are dropped
 * even when an untyped caller supplies them at runtime.
 */
export function createAuditEvent(input: CreateAuditEventInput): AuditEventEnvelope {
  const source = input.fields;
  const fields: AuditSafeFields = { outcome: source.outcome };

  if (source.reasonCode !== undefined) fields.reasonCode = source.reasonCode;
  if (source.durationMs !== undefined) fields.durationMs = source.durationMs;
  if (source.itemCount !== undefined) fields.itemCount = source.itemCount;
  if (source.inputHash !== undefined) fields.inputHash = source.inputHash;
  if (source.inputLength !== undefined) fields.inputLength = source.inputLength;
  if (source.rulesOnly !== undefined) fields.rulesOnly = source.rulesOnly;

  return {
    version: MODULE_CONTRACT_VERSION,
    eventId: input.eventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    module: input.module,
    fields,
  };
}

