/** Release-locked runtime switch for capture contract v8 (M3b). */
export function resolveCaptureKinds(env: Record<string, string | undefined> = process.env): boolean {
  const environment = (env.MAYBESITTER_ENV ?? 'local').trim().toLowerCase() || 'local';
  if (environment === 'production') return false;
  if (env.MAYBESITTER_KILL_SWITCH_CAPTURE_KINDS === 'true') return false;
  return env.MAYBESITTER_FEATURE_CAPTURE_KINDS === 'true';
}

