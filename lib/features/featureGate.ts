/**
 * The one decision: may this person use this feature now, and how much of its
 * monthly budget is left (owner direction, 2026-11-10).
 *
 * Four places ask it — the model providers, the Gmail jobs, the add-on routes
 * and `/api/mobile/capabilities/features` — and none of them reads an
 * entitlement, a preference or the ledger itself.
 *
 * ── Rollout mode ─────────────────────────────────────────────────
 *
 * `MAYBESITTER_ADDON_GATE_MODE`, read on every call like the kill switches:
 *   - `off` (default, and production until the owner releases it): nothing is
 *     read and everything is allowed — the product behaves exactly as before.
 *   - `shadow`: the decision is computed and a denial is logged, never obeyed.
 *   - `enforce`: callers obey it.
 * A decision carries `enforced`; callers check that, never the mode string.
 *
 * ── Storage that cannot be read ──────────────────────────────────
 *
 * The same rule as `usageGuard.ts`: if the gate does not know what was bought
 * or spent, it does not permit spending. `gate_unavailable` refuses under
 * `enforce` only; under `shadow` it is logged and allowed.
 */
import type { LlmPurpose } from '../../src/extraction/llm/llmProvider';
import type { StorageAdapter } from '../storage';
import { readAccountFeatureState, type AccountFeatureState } from './accountFeatures';
import {
  FEATURE_CATALOG,
  featureForPurpose,
  featureManifest,
  monthlyBudgetCents,
  type FeatureId,
  type FeatureTier,
} from './catalog';
import { centsToNanoUsd, nanoUsdToCents } from './pricing';
import { readMonthSpend, type MonthSpend } from './spendLedger';

/** Any string map: `process.env` or a test's own object. */
export type EnvLike = Readonly<Record<string, string | undefined>>;

export type GateMode = 'off' | 'shadow' | 'enforce';

export type FeatureDecisionReason =
  | 'gate_off'
  | 'free_allowance'
  | 'entitled'
  | 'not_entitled'
  | 'user_off'
  | 'budget_spent'
  | 'free_cap_spent'
  | 'gate_unavailable';

export interface FeatureDecision {
  readonly featureId: FeatureId;
  readonly tier: FeatureTier;
  readonly mode: GateMode;
  readonly allowed: boolean;
  /** True only when callers must obey `allowed` (`enforce` mode). */
  readonly enforced: boolean;
  readonly reason: FeatureDecisionReason;
  /** `null` when the feature needs a purchase this person does not have. */
  readonly monthlyBudgetCents: number | null;
  readonly spentCents: number;
  readonly remainingNanoUsd: number;
}

export interface GateOptions {
  readonly now?: Date;
  readonly storage?: StorageAdapter;
  readonly env?: EnvLike;
}

/** The free ceiling for everything a person who bought nothing may spend in a month. */
export const DEFAULT_FREE_MONTHLY_CENTS = 40;

export function gateMode(env: EnvLike = process.env): GateMode {
  const raw = (env.MAYBESITTER_ADDON_GATE_MODE ?? '').trim().toLowerCase();
  return raw === 'shadow' || raw === 'enforce' ? raw : 'off';
}

export function freeMonthlyCents(env: EnvLike = process.env): number {
  const parsed = Number.parseFloat(env.MAYBESITTER_FREE_MONTHLY_CENTS ?? '');
  // The owner's ceiling is 50¢: a misconfiguration may lower it, never raise it.
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 50) : DEFAULT_FREE_MONTHLY_CENTS;
}

function decide(
  featureId: FeatureId,
  mode: Exclude<GateMode, 'off'>,
  state: AccountFeatureState,
  month: MonthSpend,
  freeCapCents: number,
): FeatureDecision {
  const manifest = featureManifest(featureId);
  const spentNano = month.features[featureId] ?? 0;
  const budget = monthlyBudgetCents(featureId, state.grants);
  const fromFree = budget !== null && budget === manifest.freeMonthlyCents;
  const remainingNanoUsd = budget === null ? 0 : Math.max(0, centsToNanoUsd(budget) - spentNano);
  const base = {
    featureId, tier: manifest.tier, mode, enforced: mode === 'enforce',
    monthlyBudgetCents: budget, spentCents: nanoUsdToCents(spentNano), remainingNanoUsd,
  };
  const spends = manifest.purposes.length > 0;
  let reason: FeatureDecisionReason;
  if (state.disabled.has(featureId)) reason = 'user_off';
  else if (budget === null) reason = 'not_entitled';
  else if (spends && remainingNanoUsd === 0) reason = 'budget_spent';
  else if (spends && state.grants.size === 0 && month.totalNanoUsd >= centsToNanoUsd(freeCapCents)) reason = 'free_cap_spent';
  else reason = fromFree ? 'free_allowance' : 'entitled';
  const decision = { ...base, reason, allowed: reason === 'free_allowance' || reason === 'entitled' };
  if (mode === 'shadow' && !decision.allowed) {
    console.warn(`[features/gate] shadow_deny feature=${featureId} reason=${reason}`);
  }
  return decision;
}

function allowedOff(featureId: FeatureId): FeatureDecision {
  const manifest = featureManifest(featureId);
  return {
    featureId, tier: manifest.tier, mode: 'off', allowed: true, enforced: false, reason: 'gate_off',
    monthlyBudgetCents: manifest.freeMonthlyCents, spentCents: 0, remainingNanoUsd: Number.MAX_SAFE_INTEGER,
  };
}

function unavailable(featureId: FeatureId, mode: Exclude<GateMode, 'off'>, error: unknown): FeatureDecision {
  console.error(`[features/gate] state unavailable: ${(error as Error)?.name ?? 'Error'}`);
  const manifest = featureManifest(featureId);
  return {
    featureId, tier: manifest.tier, mode, allowed: mode === 'shadow', enforced: mode === 'enforce',
    reason: 'gate_unavailable', monthlyBudgetCents: null, spentCents: 0, remainingNanoUsd: 0,
  };
}

/** Every feature at once, from one read of the person's state. */
export async function listFeatureDecisions(uid: string, options: GateOptions = {}): Promise<FeatureDecision[]> {
  const mode = gateMode(options.env);
  if (mode === 'off') return FEATURE_CATALOG.map(manifest => allowedOff(manifest.id));
  try {
    const [state, month] = await Promise.all([
      readAccountFeatureState(uid, options), readMonthSpend(uid, options),
    ]);
    const cap = freeMonthlyCents(options.env);
    return FEATURE_CATALOG.map(manifest => decide(manifest.id, mode, state, month, cap));
  } catch (error) {
    return FEATURE_CATALOG.map(manifest => unavailable(manifest.id, mode, error));
  }
}

export async function decideFeature(uid: string, featureId: FeatureId, options: GateOptions = {}): Promise<FeatureDecision> {
  const mode = gateMode(options.env);
  if (mode === 'off') return allowedOff(featureId);
  try {
    const [state, month] = await Promise.all([
      readAccountFeatureState(uid, options), readMonthSpend(uid, options),
    ]);
    return decide(featureId, mode, state, month, freeMonthlyCents(options.env));
  } catch (error) {
    return unavailable(featureId, mode, error);
  }
}

/** The decision for the feature a model purpose is charged to. */
export async function decideFeatureForPurpose(
  uid: string,
  purpose: LlmPurpose,
  context: { source?: 'gmail' } = {},
  options: GateOptions = {},
): Promise<FeatureDecision> {
  return decideFeature(uid, featureForPurpose(purpose, context), options);
}

/** Whether a caller must refuse: denied and enforced. */
export function refuses(decision: FeatureDecision): boolean {
  return decision.enforced && !decision.allowed;
}
