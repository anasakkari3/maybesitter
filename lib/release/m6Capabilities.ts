import { readRuntimeBoolean } from '../../src/contracts/v1/runtimeControls';

function allowed(env: Record<string, string | undefined>): boolean {
  const name = (env.MAYBESITTER_ENV ?? 'local').trim().toLowerCase() || 'local';
  return name === 'local' || name === 'test' || name === 'staging';
}

/** Search history is staging-only until Market Evidence Gate #61. */
export function resolveSearchHistory(env: Record<string, string | undefined> = process.env): boolean {
  return allowed(env)
    && !readRuntimeBoolean(env.MAYBESITTER_KILL_SWITCH_SEARCH_HISTORY, false)
    && readRuntimeBoolean(env.MAYBESITTER_FEATURE_SEARCH_HISTORY, false);
}
