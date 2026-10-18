import { readRuntimeBoolean } from '../../src/contracts/v1/runtimeControls';

function allowed(env: Record<string, string | undefined>): boolean {
  const name = (env.MAYBESITTER_ENV ?? 'local').trim().toLowerCase() || 'local';
  return name === 'local' || name === 'test' || name === 'staging';
}

function capability(feature: string | undefined, killed: string | undefined, env: Record<string, string | undefined>): boolean {
  return allowed(env) && !readRuntimeBoolean(killed, false) && readRuntimeBoolean(feature, false);
}

export function resolveExternalClashHold(env: Record<string, string | undefined> = process.env): boolean {
  return capability(env.MAYBESITTER_FEATURE_EXTERNAL_CLASH_HOLD, env.MAYBESITTER_KILL_SWITCH_EXTERNAL_CLASH_HOLD, env);
}

export function resolveEveningImpact(env: Record<string, string | undefined> = process.env): boolean {
  return capability(env.MAYBESITTER_FEATURE_EVENING_IMPACT, env.MAYBESITTER_KILL_SWITCH_EVENING_IMPACT, env);
}

export function resolveSmartPostpone(env: Record<string, string | undefined> = process.env): boolean {
  const key = env.MAYBESITTER_POSTPONE_SLOT_HMAC_KEY;
  return capability(env.MAYBESITTER_FEATURE_SMART_POSTPONE, env.MAYBESITTER_KILL_SWITCH_SMART_POSTPONE, env)
    && typeof key === 'string' && Buffer.byteLength(key, 'utf8') >= 32;
}
