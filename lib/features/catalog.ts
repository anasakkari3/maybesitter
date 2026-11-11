/**
 * The feature catalog: which parts of MaybeSitter are core and which are
 * add-ons, what each one may spend on the model in a month, and which
 * purchases raise that budget (owner direction, 2026-11-10).
 *
 * ── Why one table ────────────────────────────────────────────────
 *
 * A subscription made of add-ons only works if every place that spends money or
 * shows a surface asks the same question the same way. This file is the only
 * place a feature is described; `featureGate.ts` is the only place a decision is
 * made. A route, a job or a provider never reads an entitlement itself — the
 * rule `lib/packs/packEntitlement.ts` already follows ("a pack may not invent
 * its own").
 *
 * ── Budgets are cents a month, per feature ───────────────────────
 *
 * `freeMonthlyCents` is what a person who pays nothing may spend on the
 * feature; `null` means the feature needs a purchase. A grant's number is that
 * purchase's budget for the feature, and several grants for one feature take
 * the largest (buying Gmail full while Gmail light is still active must not
 * add the two). The free budgets together stay under the account-wide free
 * ceiling (`MAYBESITTER_FREE_MONTHLY_CENTS`, 40¢, owner ceiling 50¢).
 *
 * Every grant's budget is below what the purchase nets after a 30% store fee,
 * so a paying user can never cost more than they pay:
 *   base ₪10 ≈ $3 → $2.10 net ≥ assistant 100¢
 *   gmail_light $3 → $2.10 net ≥ 135¢;   gmail_full $5 → $3.50 net ≥ 270¢
 *   meeting_prep / goal_plans $1 → $0.70 net ≥ 30¢;  memory_plus $1 → $0.70 net ≥ 40¢
 *
 * A feature with no purposes spends nothing on the model; it is still in the
 * catalog so it can be switched on and off like any other.
 */
import type { LlmPurpose } from '../../src/extraction/llm/llmProvider';
import type { CostFeatureKind } from '../../src/contracts/v1/costAttributionContracts';

export type FeatureId =
  | 'assistant'
  | 'gmail_reading'
  | 'meeting_prep'
  | 'goal_plans'
  | 'memory_learning'
  | 'memory_translation'
  | 'search_history'
  | 'football';

export type FeatureTier = 'core' | 'addon';

export type GrantId = 'base' | 'gmail_light' | 'gmail_full' | 'meeting_prep' | 'goal_plans' | 'memory_plus';

export interface FeatureManifest {
  readonly id: FeatureId;
  readonly tier: FeatureTier;
  readonly purposes: readonly LlmPurpose[];
  readonly costFeature: CostFeatureKind;
  /** Monthly model budget without a purchase; `null` = needs a purchase. */
  readonly freeMonthlyCents: number | null;
  /** Monthly model budget each purchase gives this feature. */
  readonly grants: Readonly<Partial<Record<GrantId, number>>>;
  /** Core features cannot be switched off by the person; add-ons can. */
  readonly userCanDisable: boolean;
}

export const GRANT_IDS: readonly GrantId[] = Object.freeze(
  ['base', 'gmail_light', 'gmail_full', 'meeting_prep', 'goal_plans', 'memory_plus'] as const,
);

export const FEATURE_CATALOG: readonly FeatureManifest[] = Object.freeze([
  {
    id: 'assistant',
    tier: 'core',
    purposes: ['capture_extraction', 'capture_chat', 'share_extraction', 'importance_estimate',
      'plan_explanation', 'profile_extraction', 'ai_context_import', 'semantic_observation'],
    costFeature: 'capture',
    freeMonthlyCents: 18,
    grants: { base: 100 },
    userCanDisable: false,
  },
  {
    id: 'gmail_reading',
    tier: 'addon',
    // `semantic_observation` belongs here only when the source is Gmail; the
    // caller says so (see `featureForPurpose`).
    purposes: ['email_triage'],
    costFeature: 'email_sync',
    freeMonthlyCents: 15,
    grants: { gmail_light: 135, gmail_full: 270 },
    userCanDisable: true,
  },
  {
    id: 'meeting_prep',
    tier: 'addon',
    purposes: ['meeting_prep'],
    costFeature: 'meeting_intelligence',
    freeMonthlyCents: 2,
    grants: { meeting_prep: 30 },
    userCanDisable: true,
  },
  {
    id: 'goal_plans',
    tier: 'addon',
    purposes: ['goal_decomposition'],
    costFeature: 'planning',
    freeMonthlyCents: 3,
    grants: { goal_plans: 30 },
    userCanDisable: true,
  },
  {
    id: 'memory_learning',
    tier: 'addon',
    purposes: ['memory_summary'],
    costFeature: 'other',
    freeMonthlyCents: 2,
    grants: { memory_plus: 20 },
    userCanDisable: true,
  },
  {
    id: 'memory_translation',
    tier: 'addon',
    purposes: ['memory_translate'],
    costFeature: 'other',
    freeMonthlyCents: null,
    grants: { memory_plus: 20 },
    userCanDisable: true,
  },
  {
    id: 'search_history',
    tier: 'addon',
    purposes: [],
    costFeature: 'other',
    freeMonthlyCents: 0,
    grants: {},
    userCanDisable: true,
  },
  {
    id: 'football',
    tier: 'addon',
    purposes: [],
    costFeature: 'other',
    freeMonthlyCents: 0,
    grants: {},
    userCanDisable: true,
  },
] satisfies FeatureManifest[]);

const BY_ID = new Map<FeatureId, FeatureManifest>(FEATURE_CATALOG.map(manifest => [manifest.id, manifest]));

export function featureManifest(id: FeatureId): FeatureManifest {
  const manifest = BY_ID.get(id);
  if (!manifest) throw new Error(`unknown feature: ${String(id)}`);
  return manifest;
}

export function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === 'string' && BY_ID.has(value as FeatureId);
}

/**
 * The feature a model call is charged to. `semantic_observation` reads both
 * the person's own notes (core) and their mailbox (the Gmail add-on), so the
 * caller names the source.
 */
export function featureForPurpose(purpose: LlmPurpose, context: { source?: 'gmail' } = {}): FeatureId {
  if (purpose === 'semantic_observation' && context.source === 'gmail') return 'gmail_reading';
  for (const manifest of FEATURE_CATALOG) if (manifest.purposes.includes(purpose)) return manifest.id;
  throw new Error(`model purpose without a feature: ${purpose}`);
}

/** This feature's monthly budget, in cents, for someone holding `grants`; `null` = not available. */
export function monthlyBudgetCents(id: FeatureId, grants: ReadonlySet<GrantId>): number | null {
  const manifest = featureManifest(id);
  let best: number | null = manifest.freeMonthlyCents;
  for (const [grant, cents] of Object.entries(manifest.grants) as Array<[GrantId, number]>) {
    if (grants.has(grant) && (best === null || cents > best)) best = cents;
  }
  return best;
}
