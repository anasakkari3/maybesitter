/**
 * Vertical pack runtime helpers (#528, slice 1). A pack itself is data — the
 * `VerticalPackDefinition` manifest; these are the two shared doors a pack's
 * configuration passes through: entitlement gating and watcher instantiation.
 */
export * from './packEntitlement';
export * from './instantiate';
