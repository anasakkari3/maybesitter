/**
 * The gate as the model paths use it: hold before a call, settle after it.
 *
 * Kept out of the providers so every path that spends on the model —
 * `captureProvider.ts`, `shareProvider.ts`, and the services that call the
 * gated provider directly (memory summary, memory translation, plan
 * narration) — applies the same rule in the same order, and none of them
 * reads the catalog, the ledger or an entitlement itself.
 *
 *   off      nothing is read and nothing is written: the paths behave exactly
 *            as they did before add-ons existed;
 *   shadow   the decision is logged, never obeyed; the real cost is recorded;
 *   enforce  the worst-case cost is held in the ledger in the same
 *            transaction that checks the budget, then settled to the real
 *            cost, or released if the call never answered.
 */
import type { LlmPurpose } from '../../src/extraction/llm/llmProvider';
import type { StorageAdapter } from '../storage';
import { featureForPurpose, type FeatureId } from './catalog';
import { holdFeatureSpend, refuses, type FeatureDecision } from './featureGate';
import { costNanoUsd, pricedModelFor } from './pricing';
import {
  nextMonthStart,
  recordFeatureSpend,
  releaseFeatureSpend,
  settleFeatureSpend,
  type SpendHold,
} from './spendLedger';

export interface ProviderFeatureHooks {
  /** The feature this call is charged to, when the purpose alone does not say (Gmail reads). */
  readonly feature?: FeatureId;
  readonly hold?: typeof holdFeatureSpend;
  readonly settle?: typeof settleFeatureSpend;
  readonly release?: typeof releaseFeatureSpend;
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
    hold: (uid, id, estimate, options = {}) => holdFeatureSpend(uid, id, estimate, { ...options, storage }),
    settle: (uid, hold, nanoUsd, options = {}) => settleFeatureSpend(uid, hold, nanoUsd, { ...options, storage }),
    release: (uid, hold, options = {}) => releaseFeatureSpend(uid, hold, { ...options, storage }),
    recordSpend: (uid, id, nanoUsd, options = {}) => recordFeatureSpend(uid, id, nanoUsd, { ...options, storage }),
  };
}

/** Milliseconds until the next UTC month, when a spent monthly budget refills. */
export function msUntilNextMonth(now: Date): number {
  return Math.max(60_000, nextMonthStart(now).getTime() - now.getTime());
}

/**
 * The most one Gemini call can cost: every output token the call allows, and
 * the prompt at two characters a token (Arabic runs denser than English, and
 * over-holding is the safe direction — the hold is settled to the real cost).
 */
export function worstCaseCallNanoUsd(promptCharacters: number, maxOutputTokens: number): number {
  return costNanoUsd('gemini-2.5-flash', {
    promptTokens: Math.ceil(Math.max(0, promptCharacters) / 2),
    outputTokens: Math.max(0, maxOutputTokens),
  });
}

export interface ProviderFeatureCheck {
  readonly feature: FeatureId;
  readonly decision: FeatureDecision;
  readonly hold: SpendHold | null;
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
  worstCaseNanoUsd: number,
): Promise<ProviderFeatureCheck> {
  const feature = hooks.feature ?? featureForPurpose(purpose);
  const { decision, hold } = await (hooks.hold ?? holdFeatureSpend)(uid, feature, worstCaseNanoUsd, { now });
  return { feature, decision, hold, refusal: refusalFor(decision) };
}

/** Records what an answered call cost: settles the hold, or records under shadow. Nothing in `off`. */
export async function chargeProviderFeature(
  uid: string,
  check: ProviderFeatureCheck,
  response: { model: string; promptTokens: number; outputTokens: number },
  hooks: ProviderFeatureHooks,
  now: Date,
): Promise<void> {
  if (check.decision.mode === 'off') return;
  const nanoUsd = costNanoUsd(pricedModelFor(response.model), response);
  if (check.hold) await (hooks.settle ?? settleFeatureSpend)(uid, check.hold, nanoUsd, { now });
  else await (hooks.recordSpend ?? recordFeatureSpend)(uid, check.feature, nanoUsd, { now });
}

/** Gives back a hold whose call was refused later or never answered. */
export async function releaseProviderFeature(
  uid: string,
  check: ProviderFeatureCheck,
  hooks: ProviderFeatureHooks,
  now: Date,
): Promise<void> {
  if (check.hold) await (hooks.release ?? releaseFeatureSpend)(uid, check.hold, { now });
}
