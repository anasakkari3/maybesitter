import {
  readRuntimeControls,
  resolveModuleRuntime,
  type ModuleRuntimeDecision,
  type RulesOnlyFallbackContract,
  type RuntimeControlEnv,
} from '../../src/contracts/v1/runtimeControls';
import { MODULE_CONTRACT_VERSION } from '../../src/contracts/v1/moduleContracts';

/**
 * Stage B is release-locked. This extra environment guard keeps production
 * rules-only even when both operator variables are accidentally permissive.
 */
export type ContextEnrichmentRuntimeDecision =
  | ModuleRuntimeDecision
  | Omit<RulesOnlyFallbackContract, 'reason'> & { readonly reason: 'release_locked' };

export function resolveContextEnrichmentRuntime(
  env: RuntimeControlEnv = process.env,
): ContextEnrichmentRuntimeDecision {
  if (env.MAYBESITTER_ENV?.trim().toLowerCase() === 'production') {
    return {
      version: MODULE_CONTRACT_VERSION,
      module: 'contextEnrichment',
      mode: 'rules_only',
      reason: 'release_locked',
      allowsModelExecution: false,
      allowsDirectStateWrites: false,
      captureRemainsAvailable: true,
    };
  }

  return resolveModuleRuntime('contextEnrichment', readRuntimeControls(env));
}
