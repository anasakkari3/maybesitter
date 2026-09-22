/**
 * Vertical pack runtime helpers (#528). A pack itself is data — the
 * `VerticalPackDefinition` manifest in `catalog.ts`; these are the shared
 * doors a pack's configuration passes through: entitlement gating, watcher
 * instantiation, and the rollout that enables and disables a pack for one
 * account without ever deleting what it owns.
 */
export * from './packEntitlement';
export * from './instantiate';
export * from './catalog';
export * from './packLifecycle';
export * from './packWatcherGuard';
