import { z } from 'zod';
import { isoDateTime } from './common';

const monitorStatusSchema = z.enum(['active', 'paused', 'blocked_permission', 'needs_reauth', 'error']);
const monitorPurposeSchema = z.enum(['notice_any_change', 'notice_threshold_crossed']);

export const backgroundMonitorSchema = z.object({
  monitorId: z.string(),
  watcherId: z.string().nullable(),
  connectionId: z.string().nullable(),
  label: z.string(),
  title: z.string().nullable(),
  status: monitorStatusSchema,
  purpose: monitorPurposeSchema,
  effects: z.array(z.string()),
  lastCheckedAt: isoDateTime.nullable(),
  lastChangedAt: isoDateTime.nullable(),
  nextCheckAt: isoDateTime.nullable(),
  canPause: z.boolean(),
  canDelete: z.boolean(),
});

export const backgroundActivitySchema = z.object({
  success: z.literal(true),
  schemaVersion: z.literal('background-monitor-v1'),
  paused: z.boolean(),
  monitors: z.array(backgroundMonitorSchema),
});

const backgroundArtifactSchema = z.object({
  kind: z.enum(['notification', 'proposal', 'state_change', 'context_update', 'none']),
  ref: z.string().nullable(),
});

export const backgroundActionSchema = z.object({
  actionId: z.string(),
  monitorId: z.string(),
  watcherId: z.string(),
  label: z.string(),
  observedAt: isoDateTime,
  occurredAt: isoDateTime,
  condition: z.string(),
  capability: z.string(),
  policyDecision: z.string(),
  effect: z.string(),
  artifact: backgroundArtifactSchema,
});

export const backgroundAttributionSchema = z.object({
  success: z.literal(true),
  schemaVersion: z.literal('background-monitor-v1'),
  actions: z.array(backgroundActionSchema),
  orphanCount: z.number().int().nonnegative(),
});

export const backgroundMonitorHistoryKindSchema = z.enum([
  'watcher_condition_changed',
  'notification_sent',
  'plan_reconsidered',
]);

export const backgroundMonitorHistoryItemSchema = z.object({
  itemId: z.string(),
  monitorId: z.string(),
  watcherId: z.string(),
  label: z.string(),
  title: z.string().nullable(),
  occurredAt: isoDateTime,
  kind: backgroundMonitorHistoryKindSchema,
  status: monitorStatusSchema,
  description: z.string(),
  effect: z.string().nullable(),
  artifactRef: z.string().nullable(),
});

export const backgroundActivityHistorySchema = z.object({
  success: z.literal(true),
  schemaVersion: z.literal('background-monitor-v1'),
  paused: z.boolean(),
  items: z.array(backgroundMonitorHistoryItemSchema),
});

export type BackgroundActivity = z.infer<typeof backgroundActivitySchema>;
export type BackgroundAction = z.infer<typeof backgroundActionSchema>;
export type BackgroundMonitorHistoryKind = z.infer<typeof backgroundMonitorHistoryKindSchema>;
export type BackgroundMonitorHistoryItem = z.infer<typeof backgroundMonitorHistoryItemSchema>;
export type BackgroundActivityHistory = z.infer<typeof backgroundActivityHistorySchema>;
