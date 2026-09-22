/**
 * Vertical pack contracts (#528, slice 1): the pack manifest.
 *
 * A vertical pack — football, athlete, travel — is a **configuration over the
 * shared Watcher/Trigger pipeline**, not a new runtime. Everything a pack does
 * at runtime is done by machinery that already exists: the watcher engine
 * (#525) evaluates and fires, the Action Policy gates every effect,
 * `IntegrationConnection` carries the provider grant, the UserState projection
 * composes context, and the RevenueCat projection decides entitlement. This
 * manifest is the pack's whole existence as data; there is no pack execution
 * model to contract because a pack never executes anything itself.
 *
 * ── What the sketch became, and why ────────────────────────────────
 *
 * The issue's sketch is reconciled against the real types rather than copied:
 *
 *  - `watcherTemplates` is a real `WatcherTemplate` — a `WatcherDefinition`
 *    minus everything only a user can supply (scope, connection, subject,
 *    timestamps). A template names the normalized signal kind, the condition
 *    and the effect; instantiating it is filling in the user-owned blanks.
 *  - `allowedEffects` is typed over the real `WatcherEffect` union — the same
 *    four values the engine and the Action Policy already share.
 *  - `userStateReducers` became `userStateSections`. The real UserState
 *    projection has no pluggable reducers — it is one composer with fixed
 *    sections, and "a pack may not create its own UserState" means none may
 *    be added. What a pack legitimately declares is which *existing* sections
 *    its signals inform (readiness, availability, …), so the manifest names
 *    those from the projection's own closed vocabulary.
 *  - `privacyClass` is the existing `SensitivityClass` from
 *    `safetyContracts`, not a second privacy vocabulary: health-adjacent packs
 *    declare `sensitive`, and the gateway's rule — the class is declared,
 *    never inferred from content — applies to a pack exactly as to a span of
 *    text.
 *  - `entitlementKey` names a RevenueCat `NormalizedEntitlement.entitlementId`;
 *    null is a free pack. The entitlement *decision* runs through
 *    `decideFeatureEntitlement` (`lib/integrations/revenuecat/entitlements.ts`);
 *    a pack does not get its own billing check.
 *
 * ── The architectural rule, stated where a test can enforce it ─────
 *
 * A pack may configure signal kinds, watcher templates, normalization, impact
 * policy and presentation. It may not call the canonical planner, write
 * Commitments, invent an OAuth store, a job scheduler, a notification engine
 * or a UserState, or bypass the Action Policy. `VERTICAL_PACK_POLICY` states
 * that as data; `tests/packs/packBoundaries.test.ts` enforces the
 * import-graph half mechanically over `lib/packs/**`.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import type { IntegrationCapability } from './integrationConnectionContracts';
import type { SensitivityClass } from './safetyContracts';
import {
  isWatcherEffect,
  isWatcherIdentifier,
  isWatchCondition,
  type WatcherEffect,
  type WatchCondition,
} from './watcherContracts';
import type { UserStateProjectionSource } from './userStateProjectionContracts';

export const VERTICAL_PACK_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const VERTICAL_PACK_SCHEMA_VERSION = 'vertical-pack-v1' as const;
export const WATCHER_TEMPLATE_SCHEMA_VERSION = 'watcher-template-v1' as const;

/* ── The watcher template ────────────────────────────────────────── */

/**
 * A `WatcherDefinition` minus the user-owned parts.
 *
 * What is absent is the point: no `scopeId` (the account instantiating it),
 * no `connectionId` (the grant the user actually made), no `subjectRef` (the
 * thing the user pointed at), no timestamps, no identity. A pack cannot mint
 * a watcher on its own — instantiation is the user enabling the template,
 * recorded with `createdBy: 'pack_template'`, which `NewWatcherInput` already
 * carries.
 */
export interface WatcherTemplate {
  readonly schemaVersion: typeof WATCHER_TEMPLATE_SCHEMA_VERSION;
  /** Normalized identifier, unique within the pack. */
  readonly templateId: string;
  /** Normalized signal vocabulary — never a provider API name. */
  readonly signalKind: string;
  readonly condition: WatchCondition;
  readonly effect: WatcherEffect;
  /**
   * Whether an instance reads through a user-granted connection. True maps to
   * a `WatcherSourceRef` naming a connection; false is the readiness/fixture
   * case, which never blocks on a grant.
   */
  readonly requiresConnection: boolean;
}

/* ── The manifest ────────────────────────────────────────────────── */

export interface VerticalPackDefinition {
  readonly version: typeof VERTICAL_PACK_CONTRACT_VERSION;
  readonly schemaVersion: typeof VERTICAL_PACK_SCHEMA_VERSION;
  /** Normalized identifier, e.g. `football`. Never a display name. */
  readonly packId: string;
  /** Capabilities an instance's connection must grant for the pack to work. */
  readonly requiredCapabilities: readonly IntegrationCapability[];
  /** Capabilities that enhance the pack but whose absence never blocks it. */
  readonly optionalCapabilities: readonly IntegrationCapability[];
  readonly watcherTemplates: readonly WatcherTemplate[];
  /**
   * The effects this pack's templates may declare. A subset of
   * `WATCHER_EFFECTS` by validation, and every template's `effect` must be
   * listed here — so the pack's ceiling is stated once, at the top, and a
   * template cannot exceed it silently.
   */
  readonly allowedEffects: readonly WatcherEffect[];
  /**
   * The sections of the existing UserState projection this pack's signals
   * inform. Read-only declaration over the projection's own vocabulary; a
   * pack composes into the shared projection and never builds its own.
   */
  readonly userStateSections: readonly UserStateProjectionSource[];
  /** The RevenueCat entitlement gating this pack, or null for a free pack. */
  readonly entitlementKey: string | null;
  /** Declared, never inferred — the safety gateway's rule, applied to packs. */
  readonly privacyClass: SensitivityClass;
}

export const VERTICAL_PACK_POLICY = Object.freeze({
  packsCallPlannerDirectly: false,
  packsWriteCommitmentsDirectly: false,
  packsOwnOAuthStore: false,
  packsOwnJobScheduler: false,
  packsOwnNotificationEngine: false,
  packsBypassActionPolicy: false,
  packsOwnUserState: false,
} as const);

/* ── Validation ──────────────────────────────────────────────────── */

/** The projection's section vocabulary, as the set validation checks against. */
const KNOWN_USER_STATE_SECTIONS: ReadonlySet<string> = new Set([
  'readiness',
  'availability',
  'focus',
  'memory',
  'deadline',
  'plan',
  'integration_connection',
]);

const KNOWN_INTEGRATION_CAPABILITIES: ReadonlySet<string> = new Set([
  'calendar_busy',
  'calendar_free',
  'mail_read',
  'mail_draft',
  'mail_send',
  'task_read',
  'task_write',
  'note_read',
  'note_write',
  'readiness_read',
  'focus_session_read',
  'meeting_read',
  'memory_context_read',
  'mcp_tool_context',
]);

const KNOWN_SENSITIVITY_CLASSES: ReadonlySet<string> = new Set([
  'public',
  'personal',
  'sensitive',
]);

/**
 * Structural validation of a manifest, as a list of problem codes.
 *
 * Returns codes rather than throwing for the same reason the planning
 * taxonomy reports findings: a conformance suite needs the *whole* list of
 * what is wrong with a pack, and a throw hands it the first one. Empty means
 * valid. Deterministic: problems are emitted in field order, so two runs over
 * one manifest read identically.
 */
export function validateVerticalPackDefinition(definition: VerticalPackDefinition): readonly string[] {
  const problems: string[] = [];

  if (!isWatcherIdentifier(definition.packId)) problems.push('pack_id_not_normalized');

  const capabilities = new Set<IntegrationCapability>();
  for (const capability of [...definition.requiredCapabilities, ...definition.optionalCapabilities]) {
    if (!KNOWN_INTEGRATION_CAPABILITIES.has(capability)) problems.push(`unknown_capability:${String(capability)}`);
    if (capabilities.has(capability)) problems.push(`capability_declared_twice:${capability}`);
    capabilities.add(capability);
  }

  const allowed = new Set<string>(definition.allowedEffects);
  for (const effect of definition.allowedEffects) {
    if (!isWatcherEffect(effect)) problems.push(`unknown_effect:${String(effect)}`);
  }

  const templateIds = new Set<string>();
  for (const template of definition.watcherTemplates) {
    if (!isWatcherIdentifier(template.templateId)) problems.push(`template_id_not_normalized:${template.templateId}`);
    if (templateIds.has(template.templateId)) problems.push(`duplicate_template:${template.templateId}`);
    templateIds.add(template.templateId);
    if (!isWatcherIdentifier(template.signalKind)) problems.push(`signal_kind_not_normalized:${template.templateId}`);
    if (!isWatchCondition(template.condition)) problems.push(`invalid_condition:${template.templateId}`);
    if (!isWatcherEffect(template.effect)) {
      problems.push(`unknown_effect:${template.templateId}`);
    } else if (!allowed.has(template.effect)) {
      // The ceiling a pack states is the one it is held to: an effect that is
      // real but not declared is the drift this manifest exists to catch.
      problems.push(`effect_not_allowed:${template.templateId}`);
    }
  }

  for (const section of definition.userStateSections) {
    if (!KNOWN_USER_STATE_SECTIONS.has(section)) problems.push(`unknown_user_state_section:${String(section)}`);
  }

  if (definition.entitlementKey !== null && definition.entitlementKey.length === 0) {
    problems.push('empty_entitlement_key');
  }

  if (!KNOWN_SENSITIVITY_CLASSES.has(definition.privacyClass)) {
    problems.push(`unknown_privacy_class:${String(definition.privacyClass)}`);
  }

  return Object.freeze(problems);
}

/* ── The installation record (#528, slice 2) ─────────────────────── */

export const PACK_INSTALLATION_SCHEMA_VERSION = 'pack-installation-v1' as const;

/**
 * Why a pack is in the state it is in.
 *
 * `entitlement_lost` is deliberately distinct from `user_disabled`: the two
 * look identical on disk otherwise, and only this field lets the entitlement
 * sweep tell "the subscription lapsed, resume if it comes back" from "the
 * person switched this off, leave it off".
 */
export type PackInstallationReason =
  | 'user_enabled'
  | 'user_disabled'
  | 'entitlement_lost'
  | 'entitlement_restored';

/**
 * One account's relationship with one pack: enabled or not, and the watchers
 * that pack's templates produced.
 *
 * ── Why `watcherIds` is here and not `packId` on the watcher ───────
 *
 * A `WatcherDefinition` records `createdBy: 'pack_template'` and nothing
 * more, so the store can say *that* a watcher came from some pack but not
 * *which* one — and "disabling football must not silence athlete" is a
 * statement about which. The link has to live somewhere; it lives on this
 * record, because the record is the thing the lifecycle already has to read
 * and write on every enable and disable, and because putting a `packId` on
 * the watcher would push a pack concept into a contract three other lanes
 * are editing. The cost is stated plainly: a watcher instantiated outside
 * `enablePack` is not attributable to its pack, so `enablePack` is the only
 * supported way a pack's watcher is born.
 *
 * Nothing here is derived. It is the record of a switch a person flipped, so
 * it goes with account deletion and survives "forget what you inferred".
 */
export interface PackInstallationRecord {
  readonly version: typeof VERTICAL_PACK_CONTRACT_VERSION;
  readonly schemaVersion: typeof PACK_INSTALLATION_SCHEMA_VERSION;
  readonly packId: string;
  readonly scopeId: string;
  readonly state: 'enabled' | 'disabled';
  readonly reason: PackInstallationReason;
  /** The watchers this pack's templates produced, in instantiation order. */
  readonly watcherIds: readonly string[];
  /**
   * Which template produced each entry of `watcherIds`, index for index.
   *
   * It exists so a re-enable can tell a template it has already installed from
   * one the manifest gained since: without it, a pack that grew a template
   * would be permanently missing it for every account that enabled the pack
   * before the change, silently and with nothing to notice it.
   */
  readonly templateIds: readonly string[];
  /** When the pack was first enabled for this account; never reset by a disable. */
  readonly enabledAt: string;
  readonly updatedAt: string;
}
