import { z } from 'zod';
import { isoDateTime } from './common';

export const observationSchema = z.object({
  id: z.string(), kind: z.enum(['goal', 'intention', 'request', 'event', 'commitment', 'preference', 'constraint', 'opportunity', 'outcome']),
  evidence: z.string(), confidence: z.number().min(0).max(1),
  source: z.enum(['manual', 'gmail', 'calendar', 'drive', 'share', 'behavior', 'memory', 'commitment']),
  sourceRef: z.string(), observedAt: isoDateTime, review: z.enum(['pending', 'confirmed', 'dismissed']),
  reviewedAt: isoDateTime.nullable(), linkedMemoryId: z.string().nullable(),
});

export const suggestionSchema = z.object({
  id: z.string(), kind: z.enum(['goal', 'action', 'question', 'warning']),
  title: z.string(), reason: z.string(), observationIds: z.array(z.string()),
  confidence: z.number().min(0).max(1), durationMinutes: z.number().nullable(),
  status: z.enum(['pending', 'accepting', 'accepted', 'dismissed']),
  position: z.number().int().nonnegative().optional(),
  answerDigest: z.string().optional(),
  decidedAt: isoDateTime.nullable(), linkedEntityId: z.string().nullable(), generatedAt: isoDateTime,
});

const suggestionScheduleSchema = z.object({
  suggestionId: z.string(), slot: z.object({ startsAt: isoDateTime, endsAt: isoDateTime }).nullable(), reason: z.string().nullable(),
});
export const intelligenceInboxSchema = z.object({ success: z.literal(true), observations: z.array(observationSchema), suggestions: z.array(suggestionSchema), schedule: z.array(suggestionScheduleSchema) });
// `route: 'plan_flow'`: the statement asked for a plan («ابنيلي خطة», M3A-032), so
// the app opens the plan path with it instead of showing observations.
export const intelligenceAnalyzeSchema = z.object({
  success: z.literal(true),
  observations: z.array(observationSchema).default([]),
  route: z.literal('plan_flow').optional(),
});
// `nextVisitAt`: when a screen visit may next ask (servers from 2026-10-03, on a visit only).
export const intelligenceGenerateSchema = z.object({
  success: z.literal(true), suggestions: z.array(suggestionSchema), schedule: z.array(suggestionScheduleSchema),
  nextVisitAt: isoDateTime.optional(),
});
export const intelligenceSuggestionDecisionSchema = z.object({ success: z.literal(true), suggestion: suggestionSchema });
export const intelligenceObservationReviewSchema = z.object({ success: z.literal(true), observation: observationSchema });
export const intelligenceGmailScanSchema = z.object({
  success: z.literal(true), messagesRead: z.number().int().nonnegative(), observations: z.array(observationSchema),
  scan: z.object({ status: z.enum(['running', 'complete', 'busy']), messagesVisited: z.number().int().nonnegative() }),
});
export const intelligenceGmailMonitorSchema = z.object({
  success: z.literal(true), enabled: z.boolean(), lastSuccessAt: isoDateTime.nullable(),
  error: z.enum(['source_unavailable', 'analysis_unavailable']).nullable(),
});

export type IntelligenceInbox = z.infer<typeof intelligenceInboxSchema>;
export type IntelligenceSuggestion = z.infer<typeof suggestionSchema>;
export type IntelligenceObservation = z.infer<typeof observationSchema>;
