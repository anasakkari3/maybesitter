import { z } from 'zod';
import { isoDateTime } from './common';

/** Mirrors presentWatcher in lib/watchers/watcherApi.ts, not provider data. */
export const watcherSchema = z.object({
  watcherId: z.string().regex(/^wtc_[0-9a-fA-F-]{36}$/),
  // `definition.label ?? null` on the server: a watcher nobody named is null.
  label: z.string().nullable().optional(),
  enabled: z.boolean(),
  status: z.enum(['active', 'paused', 'blocked']),
  blockedReason: z.enum(['provider_disconnected', 'provider_needs_reauth', 'signal_unavailable']).nullable(),
  source: z.object({ provider: z.string(), connectionId: z.string().nullable(), signalKind: z.string(), subjectRef: z.string() }),
  condition: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('digest_changed') }),
    z.object({ kind: z.literal('threshold'), metric: z.string(), operator: z.enum(['lt','lte','gt','gte']), value: z.number() }),
  ]),
  effect: z.enum(['notify', 'replan_if_impacted', 'propose_commitment', 'update_context']),
  createdBy: z.enum(['user','pack_template']),
  createdAt: isoDateTime, updatedAt: isoDateTime,
  lastObservedAt: isoDateTime.nullable(), lastFiredAt: isoDateTime.nullable(), fireCount: z.number().int().nonnegative(),
});
export const watcherListSchema = z.object({ success: z.literal(true), items: z.array(watcherSchema) });
export const watcherChangedSchema = z.object({ success: z.literal(true), watcher: watcherSchema });
export const watcherDeletedSchema = z.object({ success: z.literal(true), watcherId: z.string(), deleted: z.literal(true) });
export const monitoringSettingsSchema = z.object({ paused: z.boolean(), updatedAt: isoDateTime.nullable() });
export const monitoringSettingsResponseSchema = z.object({
  success: z.literal(true),
  monitoringSettings: monitoringSettingsSchema,
  paused: z.boolean(),
});
export type Watcher = z.infer<typeof watcherSchema>;
export type WatcherEffect = Watcher['effect'];
