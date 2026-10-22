import { readRuntimeBoolean, readRuntimeControls, resolveModuleRuntime } from '../../src/contracts/v1/runtimeControls';

function allowed(env: Record<string, string | undefined>): boolean {
  const name = (env.MAYBESITTER_ENV ?? 'local').trim().toLowerCase() || 'local';
  return name === 'local' || name === 'test' || name === 'staging';
}

/** The single M5b-1 release switch. Production is deliberately never eligible. */
export function resolveMemoryLearning(env: Record<string, string | undefined> = process.env): boolean {
  return allowed(env)
    && !readRuntimeBoolean(env.MAYBESITTER_KILL_SWITCH_MEMORY_LEARNING, false)
    && readRuntimeBoolean(env.MAYBESITTER_FEATURE_MEMORY_LEARNING, false);
}

export type M5bBasisMode = 'on_basis' | 'on_nobasis' | 'off';

/** One answer for whether plan memory may shape and/or explain a plan. */
export function m5bBasisMode(env: Record<string, string | undefined> = process.env): M5bBasisMode {
  if (!resolveMemoryLearning(env)) return 'off';
  return resolveModuleRuntime('memory', readRuntimeControls(env)).mode === 'enabled' ? 'on_basis' : 'on_nobasis';
}
