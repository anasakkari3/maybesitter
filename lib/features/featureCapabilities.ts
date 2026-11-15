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
 *
 * ── Only what this deployment can run ────────────────────────────
 *
 * A feature is listed only while the switch its routes answer to is on and not
 * killed (`featureAvailable`). Production keeps memory learning, memory
 * translation and search history off, and an "On" row whose route answers 404
 * is a promise the app cannot keep. Leaving the row out, rather than marking
 * it, also covers builds that already shipped: they draw what they are given.
 */
import { resolveMemoryLearning } from '../release/m5bCapabilities';
import { resolveMemoryTranslation, resolveSearchHistory } from '../release/m6Capabilities';
import { footballProviderConfigured } from '../football/footballWatchers';
import { readRuntimeControls, resolveModuleRuntime } from '../../src/contracts/v1/runtimeControls';
import { featureManifest, type FeatureId, type FeatureTier } from './catalog';
import {
  gateMode,
  listFeatureDecisions,
  refuses,
  type FeatureDecisionReason,
  type EnvLike,
  type GateMode,
  type GateOptions,
} from './featureGate';

/**
 * Whether this deployment can run the feature at all, whoever asks: the same
 * switches its routes check before the add-on gate (read per call, so a kill
 * switch empties the row on the next request).
 *
 *   memory_learning     GET /memory/summary: resolveMemoryLearning + the memory module
 *   memory_translation  POST /memory/[id]/translation: resolveMemoryTranslation + the memory module
 *   search_history      POST /commitments/search: resolveSearchHistory
 *   football            nothing is ever fetched without the match-data key
 *   assistant, gmail_reading, meeting_prep, goal_plans: no deployment switch on
 *     the routes the app calls (Gmail scan, /meetings/prepare, /goals/[id]/execution/*).
 */
export function featureAvailable(id: FeatureId, env: EnvLike = process.env): boolean {
  const record = env as Record<string, string | undefined>;
  const memoryOn = () => resolveModuleRuntime('memory', readRuntimeControls(record)).mode === 'enabled';
  switch (id) {
    case 'memory_learning': return resolveMemoryLearning(record) && memoryOn();
    case 'memory_translation': return resolveMemoryTranslation(record) && memoryOn();
    case 'search_history': return resolveSearchHistory(record);
    case 'football': return footballProviderConfigured(record);
    case 'assistant':
    case 'gmail_reading':
    case 'meeting_prep':
    case 'goal_plans':
      return true;
  }
}

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
    features: decisions.filter(decision => featureAvailable(decision.featureId, options.env)).map(decision => {
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
