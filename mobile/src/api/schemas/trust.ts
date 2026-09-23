import { z } from 'zod';
import { isoDateTime } from './common';

/** Mirrors `trust.state.json` and `trust.updated.json` — the same shape. */
export const trustResponseSchema = z.object({
  success: z.boolean(),
  participantId: z.string(),
  trust: z.object({
    version: z.string(),
    participantId: z.string(),
    recommendationConsent: z.boolean(),
    analyticsConsent: z.boolean(),
    calendarConsent: z.boolean(),
    firstValueAt: isoDateTime.nullable(),
    quietMode: z.boolean(),
    revokedAt: isoDateTime.nullable(),
    deletedAt: isoDateTime.nullable(),
    updatedAt: isoDateTime,
  }),
  exposure: z.object({ allowed: z.boolean(), reason: z.string() }),
  whatKnows: z.object({
    version: z.string(),
    participantId: z.string(),
    confirmedCommitmentCount: z.number(),
    recommendationConsent: z.boolean(),
    analyticsConsent: z.boolean(),
    calendarConnected: z.boolean(),
    privateMessageIngestion: z.boolean(),
    sensitiveInference: z.boolean(),
    medicalProfile: z.boolean(),
  }),
});

export type TrustResponse = z.infer<typeof trustResponseSchema>;

export const pilotIncidentResponseSchema = z.object({
  success: z.literal(true),
  incidentId: z.string(),
  status: z.literal('open'),
});

export type PilotIncidentInput = {
  surface: 'capture' | 'recommendation' | 'calendar' | 'analytics' | 'account';
  category: 'reliability' | 'privacy' | 'safety' | 'consent' | 'other';
};

/** Every action `POST /api/mobile/pilot/trust` accepts. */
export type TrustAction =
  | { type: 'grant_recommendation_consent' }
  | { type: 'set_recommendation_consent'; granted: boolean }
  | { type: 'set_analytics_consent'; granted: boolean }
  | { type: 'set_calendar_consent'; granted: boolean }
  | { type: 'set_quiet_mode'; enabled: boolean }
  | { type: 'revoke' }
  | { type: 'delete' };
