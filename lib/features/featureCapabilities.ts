/**
 * What the app is told about the person's features
 * (`GET /api/mobile/capabilities/features`).
 *
 * Shares only what a screen needs: whether each feature is usable now, why
 * not, whether the person may switch it, and how much of this month's
 * allowance is used, as a percentage. Never cents, never prices, never the
 * entitlement projection: what the store charged is the store's to show.
 *
 * `mode` is passed through so the app can keep the whole «الميزات» section out
 * of sight while the gate is `off` — there is nothing to choose then, and a
 * switch that does nothing is worse than no switch.
 */
import { featureManifest, type FeatureId, type FeatureTier } from './catalog';
import {
  gateMode,
  listFeatureDecisions,
  refuses,
  type FeatureDecisionReason,
  type GateMode,
  type GateOptions,
} from './featureGate';

export interface FeatureCapability {
  readonly id: FeatureId;
  readonly tier: FeatureTier;
  readonly enabled: boolean;
  readonly reason: FeatureDecisionReason;
  readonly userCanDisable: boolean;
  /** This month's model allowance used, 0–100; `null` when the feature spends nothing or has no allowance. */
  readonly usedPercent: number | null;
}

export interface FeatureCapabilitiesBody {
  readonly success: true;
  readonly mode: GateMode;
  readonly features: readonly FeatureCapability[];
}

export async function featureCapabilities(uid: string, options: GateOptions = {}): Promise<FeatureCapabilitiesBody> {
  const decisions = await listFeatureDecisions(uid, options);
  return {
    success: true,
    mode: gateMode(options.env),
    features: decisions.map(decision => {
      const manifest = featureManifest(decision.featureId);
      const budget = decision.monthlyBudgetCents;
      const usedPercent = manifest.purposes.length === 0 || decision.mode === 'off' || !budget
        ? null
        : Math.min(100, Math.round((decision.spentCents / budget) * 100));
      return {
        id: decision.featureId,
        tier: decision.tier,
        enabled: !refuses(decision),
        reason: decision.reason,
        userCanDisable: manifest.userCanDisable,
        usedPercent,
      };
    }),
  };
}
