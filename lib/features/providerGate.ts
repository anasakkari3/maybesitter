/**
 * The gate as the model providers use it: one check before a call is reserved,
 * one charge after it answers.
 *
 * Kept out of `captureProvider.ts` and `shareProvider.ts` so both apply the
 * same rule in the same order, and so neither reads the catalog, the ledger or
 * an entitlement itself.
 *
 * In `off` mode the check reads nothing and the charge writes nothing: the
 * providers behave exactly as they did before add-ons existed.
 */
import type { LlmPurpose } from '../../src/extraction/llm/llmProvider';
import { featureForPurpose, type FeatureId } from './catalog';
import { decideFeature, refuses, type FeatureDecision } from './featureGate';
import { costNanoUsd, pricedModelFor } from './pricing';
import { nextMonthStart, recordFeatureSpend } from './spendLedger';
import type { StorageAdapter } from '../storage';

export interface ProviderFeatureHooks {
  /** The feature this call is charged to, when the purpose alone does not say (Gmail reads). */
  readonly feature?: FeatureId;
  readonly gate?: typeof decideFeature;
  readonly recordSpend?: typeof recordFeatureSpend;
}

/**
 * Hooks bound to one storage adapter, for callers that run on an injected one
 * (the Gmail jobs, the M5a scan): the gate and the ledger must read the same
 * store the permits do.
 */
export function featureHooksFor(feature: FeatureId, storage?: StorageAdapter): ProviderFeatureHooks {
  if (!storage) return { feature };
  return {
    feature,
    gate: (uid, id, options = {}) => decideFeature(uid, id, { ...options, storage }),
    recordSpend: (uid, id, nanoUsd, options = {}) => recordFeatureSpend(uid, id, nanoUsd, { ...options, storage }),
  };
}

/** Milliseconds until the next UTC month, when a spent monthly budget refills. */
export function msUntilNextMonth(now: Date): number {
  return Math.max(60_000, nextMonthStart(now).getTime() - now.getTime());
}

export interface ProviderFeatureCheck {
  readonly feature: FeatureId;
  readonly decision: FeatureDecision;
  /** The `LLMUnavailableError` reason to throw, or `null` to go ahead. */
  readonly refusal: string | null;
}

/**
 * `cost_cap:user_monthly` for a spent budget, so every caller that already
 * reads `cost_cap:<scope>` shows the quota answer; `feature_locked` when the
 * person does not have the feature (the routes refuse that earlier, so this is
 * the backstop); `usage_guard_unavailable` when the gate could not read state.
 */
function refusalFor(decision: FeatureDecision): string | null {
  if (!refuses(decision)) return null;
  switch (decision.reason) {
    case 'budget_spent':
    case 'free_cap_spent':
      return 'cost_cap:user_monthly';
    case 'gate_unavailable':
      return 'usage_guard_unavailable';
    default:
      return 'feature_locked';
  }
}

export async function checkProviderFeature(
  uid: string,
  purpose: LlmPurpose,
  hooks: ProviderFeatureHooks,
  now: Date,
): Promise<ProviderFeatureCheck> {
  const feature = hooks.feature ?? featureForPurpose(purpose);
  const decision = await (hooks.gate ?? decideFeature)(uid, feature, { now });
  return { feature, decision, refusal: refusalFor(decision) };
}

/** Records what an answered call cost. Nothing in `off` mode. */
export async function chargeProviderFeature(
  uid: string,
  check: ProviderFeatureCheck,
  response: { model: string; promptTokens: number; outputTokens: number },
  hooks: ProviderFeatureHooks,
  now: Date,
): Promise<void> {
  if (check.decision.mode === 'off') return;
  const nanoUsd = costNanoUsd(pricedModelFor(response.model), response);
  await (hooks.recordSpend ?? recordFeatureSpend)(uid, check.feature, nanoUsd, { now });
}
