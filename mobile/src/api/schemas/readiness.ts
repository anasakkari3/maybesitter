import { z } from 'zod';
import { isoDateTime } from './common';

const readinessBandSchema = z.enum(['unknown', 'low', 'steady', 'high']);
const readinessSourceKindSchema = z.enum(['healthkit', 'health_connect', 'whoop', 'subjective']);

export const readinessSnapshotSchema = z.object({
  // `MODULE_CONTRACT_VERSION` on the server (src/contracts/v1/moduleContracts.ts)
  // — the string 'v1', never a number.
  version: z.literal('v1'),
  schemaVersion: z.literal('readiness-v1'),
  scopeId: z.string(),
  computedAt: isoDateTime,
  windowStart: isoDateTime,
  windowEnd: isoDateTime,
  band: readinessBandSchema,
  score: z.number().min(0).max(1).nullable(),
  normalizedSignals: z.object({}).passthrough(),
  subjective: z.object({
    energy: z.number().int().min(1).max(5).optional(),
    observedAt: isoDateTime,
  }).nullable(),
  derived: z.object({
    readinessBand: readinessBandSchema,
    confidence: z.number().min(0).max(1).nullable(),
  }),
  signals: z.array(z.unknown()),
  sourceKinds: z.array(readinessSourceKindSchema),
  missingSourceKinds: z.array(readinessSourceKindSchema),
});

export const readinessResponseSchema = z.object({
  readiness: readinessSnapshotSchema.nullable(),
  selectedSource: z.enum(['current_subjective', 'recent_readiness', 'historical_inference', 'none']),
  // `missing` is an account with no check-in and no readiness signal yet
  // (lib/integrations/readiness/subjectiveEnergy.ts). A state, not an error.
  freshness: z.enum(['fresh', 'stale', 'missing']),
});

export const readinessSavedSchema = z.object({
  success: z.literal(true),
  result: z.enum(['stored', 'unchanged', 'stale_ignored']),
});

export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type ReadinessSaved = z.infer<typeof readinessSavedSchema>;
