import type { ArbiterFunction } from './arbiter';

export const ESCALATION_ENV_VAR = 'MAYBESITTER_EXTRACTION_ESCALATION';

export const ESCALATION_NOT_READY_MESSAGE =
  'two-model escalation is NOT READY — see docs/superpowers/plans/2026-08-21-two-model-escalation-STATE.md';

/**
 * The only sanctioned way to obtain an arbiter for production extraction.
 *
 * The two-model escalation primitives are merged, but the feature is NOT READY
 * to switch on (STATE.md §K: no render site or consent gate for the privacy
 * note, no owner-approved cost model). Until that verdict changes, this
 * returns no arbiter — so `extractAndMap` never escalates — and refuses loudly
 * when someone tries to turn it on, instead of quietly sending capture text to
 * a second model.
 */
export function resolveArbiter(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ArbiterFunction | undefined {
  const value = (env[ESCALATION_ENV_VAR] ?? '').trim().toLowerCase();
  if (value === 'on') throw new Error(ESCALATION_NOT_READY_MESSAGE);
  return undefined;
}
