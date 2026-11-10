import { z } from 'zod';

/**
 * `GET /api/mobile/capabilities/features`, and the answer to
 * `PUT /api/mobile/capabilities/features/{id}` (the same body).
 *
 * Strict at every level, like every new object. `id` and `reason` are plain
 * strings on purpose, not enums: a server that adds a feature or a reason must
 * not turn an installed app's whole Features screen into a parse failure. The
 * screen shows only the ids it has copy for, and reads an unknown reason from
 * `enabled` alone.
 */
export const featureCapabilitySchema = z.object({
  id: z.string().min(1),
  tier: z.enum(['core', 'addon']),
  enabled: z.boolean(),
  reason: z.string().min(1),
  userCanDisable: z.boolean(),
  /** This month's allowance used, 0–100; `null` when the feature spends nothing or has no allowance. */
  usedPercent: z.number().min(0).max(100).nullable(),
}).strict();
export type FeatureCapability = z.infer<typeof featureCapabilitySchema>;

export const featureCapabilitiesSchema = z.object({
  success: z.literal(true),
  /** `off`: nothing to choose, and the app shows no Features entry at all. */
  mode: z.enum(['off', 'shadow', 'enforce']),
  features: z.array(featureCapabilitySchema),
}).strict();
export type FeatureCapabilities = z.infer<typeof featureCapabilitiesSchema>;
