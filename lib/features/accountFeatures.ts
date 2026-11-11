/**
 * What a person bought, and which add-ons they switched off themselves.
 *
 * Two documents under `users/{uid}/features`:
 *   - `entitlements`: the store projection (`projectRevenueCatEntitlements`),
 *     written only by the server. Raw receipts never land here — the policy in
 *     `lib/integrations/revenuecat/entitlements.ts` is projection-only.
 *   - `preferences`: the add-ons the person turned off. Core features are not
 *     accepted here; the gate would ignore them anyway.
 *
 * Firestore rules deny every client write, so neither document can be edited
 * from a device: a purchase cannot be self-granted and a preference only
 * changes through `/api/mobile/capabilities/features`.
 */
import { FEATURES, getStorage, userCol, type StorageAdapter } from '../storage';
import type { EntitlementProjection } from '../integrations/revenuecat/entitlements';
import { requireLiveAccount } from '../account/accountLiveness';
import { featureManifest, GRANT_IDS, isFeatureId, type FeatureId, type GrantId } from './catalog';

export interface StoredEntitlements {
  readonly v: 1;
  readonly projection: EntitlementProjection;
  readonly updatedAt: string;
}

export interface StoredFeaturePreferences {
  readonly v: 1;
  readonly disabled: readonly FeatureId[];
  readonly updatedAt: string;
}

export interface AccountFeatureState {
  readonly grants: ReadonlySet<GrantId>;
  readonly disabled: ReadonlySet<FeatureId>;
}

interface Options {
  readonly now?: Date;
  readonly storage?: StorageAdapter;
}

export function entitlementsPath(uid: string): string {
  return `${userCol(uid, FEATURES)}/entitlements`;
}

export function preferencesPath(uid: string): string {
  return `${userCol(uid, FEATURES)}/preferences`;
}

/**
 * The grants a projection holds at `now`. Active or in billing grace, and not
 * past its own expiry: a stored projection is not re-fetched on every read, so
 * an `active` row whose `expiresAt` has gone by is treated as lapsed rather
 * than trusted until the next webhook.
 */
export function activeGrants(projection: EntitlementProjection | null | undefined, now: Date): Set<GrantId> {
  const grants = new Set<GrantId>();
  if (!projection) return grants;
  for (const entitlement of projection.entitlements) {
    if (!(GRANT_IDS as readonly string[]).includes(entitlement.entitlementId)) continue;
    if (entitlement.status !== 'active' && entitlement.status !== 'grace_period') continue;
    const expires = entitlement.expiresAt ? Date.parse(entitlement.expiresAt) : null;
    if (expires !== null && (!Number.isFinite(expires) || expires <= now.getTime())) continue;
    grants.add(entitlement.entitlementId as GrantId);
  }
  return grants;
}

/** Throws when storage cannot be read: the gate turns that into `gate_unavailable`. */
export async function readAccountFeatureState(uid: string, options: Options = {}): Promise<AccountFeatureState> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const [entitlements, preferences] = await Promise.all([
    storage.get<StoredEntitlements>(entitlementsPath(uid)),
    storage.get<StoredFeaturePreferences>(preferencesPath(uid)),
  ]);
  return {
    grants: activeGrants(entitlements?.projection, now),
    // An id the catalog no longer has is ignored, never fatal: one renamed
    // feature must not close every other one (review P2-10).
    disabled: new Set((preferences?.disabled ?? []).filter(id => isFeatureId(id) && featureManifest(id).userCanDisable)),
  };
}

export async function saveEntitlementProjection(
  uid: string,
  projection: EntitlementProjection,
  options: Options = {},
): Promise<void> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  await storage.set<StoredEntitlements>(entitlementsPath(uid), { v: 1, projection, updatedAt: now.toISOString() });
}

/** Refuses a core feature: the person cannot switch the core off. */
export async function setFeaturePreference(
  uid: string,
  feature: FeatureId,
  enabled: boolean,
  options: Options = {},
): Promise<readonly FeatureId[]> {
  if (!featureManifest(feature).userCanDisable) throw new Error(`core feature cannot be switched off: ${feature}`);
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const path = preferencesPath(uid);
  return storage.runTransaction(async tx => {
    // The deletion fence every user-content writer keeps (#772): a switch in
    // flight while the account is deleted must not recreate the document.
    await requireLiveAccount(tx, uid);
    const current = await tx.get<StoredFeaturePreferences>(path);
    const disabled = new Set(current?.disabled ?? []);
    if (enabled) disabled.delete(feature); else disabled.add(feature);
    const next = Array.from(disabled).sort();
    tx.set<StoredFeaturePreferences>(path, { v: 1, disabled: next, updatedAt: now.toISOString() });
    return next;
  });
}
