import { z } from 'zod';
import { isoDateTime } from './common';

const nodeBase = { nodeId: z.string(), status: z.enum(['proposed', 'confirmed', 'dismissed']) };

export const goalNodeSchema = z.discriminatedUnion('kind', [
  z.object({ ...nodeBase, kind: z.literal('milestone_proposal'), title: z.string(), statedTiming: z.string().nullable() }),
  z.object({
    ...nodeBase,
    kind: z.literal('decomposition_step_proposal'),
    stepId: z.string(),
    title: z.string(),
    sourceSpans: z.array(z.unknown()),
    inferred: z.boolean(),
    statedTiming: z.string().nullable(),
    statedOwner: z.string().nullable(),
  }),
  z.object({ ...nodeBase, kind: z.literal('linked_commitment'), commitmentId: z.string() }),
  z.object({ ...nodeBase, kind: z.literal('linked_habit'), habitId: z.string() }),
  z.object({ ...nodeBase, kind: z.literal('checkpoint'), title: z.string(), statedTiming: z.string().nullable() }),
]);

export const goalGraphSchema = z.object({
  version: z.string(),
  schema: z.literal('goal-graph-v1'),
  graphId: z.string(),
  goalMemoryId: z.string(),
  scopeId: z.string(),
  language: z.enum(['ar', 'he', 'en', 'mixed']),
  nodes: z.array(goalNodeSchema),
  edges: z.array(z.unknown()),
  generatedAt: isoDateTime,
  generation: z.number().int(),
  provenance: z.object({
    decompositionProposalId: z.string(),
    decompositionOutcome: z.enum(['decomposed', 'atomic', 'rejected']),
  }).passthrough(),
});

const progressNodeSchema = z.union([
  z.object({ nodeKey: z.string(), entityKind: z.literal('commitment'), entityId: z.string(), status: z.string(), completed: z.boolean() }),
  z.object({ nodeKey: z.string(), entityKind: z.literal('habit'), entityId: z.string(), completedOccurrences: z.number(), targetOccurrences: z.number(), completed: z.boolean() }),
]);

export const goalProgressSchema = z.object({
  scopeId: z.string(),
  goalMemoryId: z.string(),
  confirmedCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  nodes: z.array(progressNodeSchema),
  derivedAt: isoDateTime,
  period: z.object({ fromLocalDate: z.string(), toLocalDate: z.string() }).nullable(),
});

export const goalExecutionResponseSchema = z.object({
  success: z.literal(true),
  graph: goalGraphSchema,
  progress: goalProgressSchema,
});

export const goalGraphResponseSchema = z.object({ success: z.literal(true), graph: goalGraphSchema });
export const goalConfirmResponseSchema = goalGraphResponseSchema.extend({
  created: z.array(z.unknown()),
  replayed: z.array(z.unknown()),
  refused: z.array(z.object({ nodeId: z.string(), nodeKey: z.string(), code: z.string(), detail: z.string() })),
});
export const goalUnlinkResponseSchema = z.object({
  success: z.literal(true),
  unlinked: z.object({ nodeId: z.string(), nodeKey: z.string(), entityKind: z.enum(['commitment', 'habit']), entityId: z.string().nullable() }),
  canonicalWorkKept: z.literal(true),
});

export type GoalGraph = z.infer<typeof goalGraphSchema>;
export type GoalExecution = z.infer<typeof goalExecutionResponseSchema>;
