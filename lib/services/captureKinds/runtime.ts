import { readRuntimeBoolean } from '../../../src/contracts/v1/runtimeControls';

/** Release-locked runtime switch for capture contract v8 (M3b). */
export function resolveCaptureKinds(env: Record<string, string | undefined> = process.env): boolean {
  const environment = (env.MAYBESITTER_ENV ?? 'local').trim().toLowerCase() || 'local';
  if (!['local', 'test', 'staging'].includes(environment)) return false;
  if (readRuntimeBoolean(env.MAYBESITTER_KILL_SWITCH_CAPTURE_KINDS, false)) return false;
  return readRuntimeBoolean(env.MAYBESITTER_FEATURE_CAPTURE_KINDS, false);
}
