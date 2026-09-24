import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * The daily plan, as `/api/mobile/plans/**` and `/api/mobile/settings/plan`
 * answer it (UC-3.10a, #194). The screen that renders it is #195.
 *
 * Every field here is read from `lib/services/dailyPlan/planDto.ts`, which is
 * the one place the wire shape is decided — not from an issue's table. The
 * fixtures `plan.today`, `plan.accepted` and `plan.regenerated` are the same
 * `{ success, plan }` envelope at three points in the plan's life, so one
 * schema covers all three and a drift in any of them fails the mobile suite.
 */

/**
 * One item the planner placed.
 *
 * `title` is nullable because the plan stores item ids and joins the titles
 * from the commitments at read time: a commitment deleted after the plan was
 * built comes back as null rather than as an empty string, so the client can
 * say "this is no longer on your list" instead of rendering a blank row.
 */
export const planItemSchema = z.object({
  itemId: z.string(),
  title: z.string().nullable(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  /**
   * The block this row is (#521, #522), or null on a plan built before blocks
   * existed. It is what the protect action names, so a row without one cannot
   * be protected — which is the honest rendering of an old document.
   */
  blockId: z.string().nullable(),
});

/**
 * One item the planner could not place, and the code saying why.
 *
 * `reasonCode` is a string and not an enum, deliberately, and unlike
 * `executedEngine` in `capture.ts`. `UnplacedItemDto` widens
 * `PlanningReason['code']` to `string` on the way out, and the fixture's
 * `unscheduled` is empty — so a new planning reason would reach a device
 * without ever changing a fixture, and an enum here would turn that into a
 * parse failure the drift detector could not have caught first. The client
 * maps the code it knows and falls back on the one it does not.
 */
export const unplacedItemSchema = z.object({
  itemId: z.string(),
  title: z.string().nullable(),
  reasonCode: z.string(),
  /** Same as `planItemSchema.blockId`: an unplaced item still has a block. */
  blockId: z.string().nullable(),
});

/**
 * `explanation.source` says whether the sentence came from the model or from
 * the deterministic template the server falls back to. The client shows the
 * same text either way; it is here because "a model wrote this" is a thing the
 * user is entitled to know.
 */
export const planExplanationSchema = z.object({
  text: z.string(),
  locale: z.enum(['ar', 'he', 'en']),
  source: z.enum(['model', 'template']),
});

/**
 * One block whose position is the user's (or a policy's) decision (#522).
 *
 * `ownership` is a literal rather than the contract's three-value union: a
 * released protection is *absent* from this list, and a `fixed` block is not a
 * protection at all, so `protected_flexible` is the only value that can
 * appear. A wider union here would be the client declaring it can render two
 * states the server never sends.
 *
 * `origin` is the enum the contract names and not `z.string()`, for the reason
 * `executedEngine` is: a bare string accepts an unknown value silently, which
 * is the same shape of defect as a test that cannot go red. The three are what
 * `ProtectionOrigin` declares, and a fourth arriving should fail here rather
 * than render as a blank label.
 *
 * `maxShiftMinutes` is a bound in minutes or null for "no explicit bound" —
 * never zero standing in for absence, which is a different statement ("do not
 * move this at all").
 */
export const blockProtectionSchema = z.object({
  blockId: z.string(),
  itemId: z.string(),
  ownership: z.literal('protected_flexible'),
  origin: z.enum(['user', 'habit_policy', 'goal_policy']),
  preferredInterval: z.object({
    startsAt: isoDateTime,
    endsAt: isoDateTime,
  }).nullable(),
  maxShiftMinutes: z.number().nullable(),
});

export type BlockProtection = z.infer<typeof blockProtectionSchema>;

const intervalSchema = z.object({ startsAt: isoDateTime, endsAt: isoDateTime });

export const planProposalChangeSchema = z.object({
  kind: z.enum(['added', 'removed', 'moved', 'unchanged', 'reason_changed']),
  itemId: z.string(),
  title: z.string().nullable(),
  from: intervalSchema.nullable(),
  to: intervalSchema.nullable(),
  shiftMinutes: z.number().nullable(),
  fromReasonCode: z.string().nullable(),
  toReasonCode: z.string().nullable(),
});

export const proposedProtectionSchema = z.object({
  blockId: z.string(),
  itemId: z.string(),
  title: z.string().nullable(),
  origin: z.string(),
  preferredInterval: intervalSchema.nullable(),
  maxShiftMinutes: z.number().nullable(),
  proposedInterval: intervalSchema.nullable(),
  overridden: z.boolean(),
});

export const pendingPlanProposalSchema = z.object({
  proposalId: z.string(),
  proposedAt: isoDateTime,
  baseGeneration: z.number().int(),
  reason: z.string(),
  userControlMode: z.string(),
  causeChangeIds: z.array(z.string()),
  scheduled: z.array(planItemSchema),
  unscheduled: z.array(unplacedItemSchema),
  changes: z.array(planProposalChangeSchema),
  protections: z.array(proposedProtectionSchema),
});

export type PendingPlanProposal = z.infer<typeof pendingPlanProposalSchema>;

export const dailyPlanSchema = z.object({
  /** The local day the plan is for, `YYYY-MM-DD` — never an instant. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  timezone: z.string(),
  status: z.enum(['proposed', 'accepted', 'edited', 'dismissed']),
  /** 1 on the morning build; each regenerate increments it. */
  generation: z.number(),
  /** sha256 hex of the planning request: "this is the plan those inputs produce". */
  inputDigest: z.string(),
  generatedAt: isoDateTime,
  acceptedAt: isoDateTime.nullable(),
  explanation: planExplanationSchema,
  scheduled: z.array(planItemSchema),
  unscheduled: z.array(unplacedItemSchema),
  /** True once the user has moved or removed something. */
  edited: z.boolean(),
  /** Blocks whose position is the user's (or a policy's) decision (#522). */
  protections: z.array(blockProtectionSchema),
  /** Pending continuous-replan patch joined from the response envelope. */
  proposal: pendingPlanProposalSchema.nullable().optional(),
});

export type DailyPlan = z.infer<typeof dailyPlanSchema>;
export type PlanItem = z.infer<typeof planItemSchema>;
export type UnplacedItem = z.infer<typeof unplacedItemSchema>;

/**
 * Mirrors `plan.today.json`, `plan.accepted.json` and `plan.regenerated.json`.
 *
 * GET, the accept/dismiss/edit action and regenerate all answer the whole plan
 * rather than an acknowledgement, so the client never has to re-fetch to learn
 * what its own action did.
 */
export const planResponseSchema = z.object({
  success: z.literal(true),
  plan: dailyPlanSchema,
  proposal: pendingPlanProposalSchema.nullable().optional(),
});

export type PlanResponse = z.infer<typeof planResponseSchema>;

/**
 * Mirrors `plan.opened.json` — the acknowledgement for "the plan was put on
 * screen" (#533). The append to the caller's own plan ledger is the point of
 * the call; the answer carries nothing back.
 */
export const planOpenedSchema = z.object({
  success: z.literal(true),
});

export type PlanOpened = z.infer<typeof planOpenedSchema>;

/**
 * Mirrors `plan.editRejected.json` — the 422 a refused edit answers with.
 *
 * It carries `itemId` as well as `reason`, which is the point: the screen
 * shows the refusal next to the item the user dragged, not as a page-level
 * error. `errorBodySchema` would parse this body and throw `itemId` away, so
 * this refusal gets its own schema the way `staleCommitmentSchema` does.
 *
 * `itemId` is nullable because the parse failures raised before an item is
 * identified — an edit that moves nothing, a move with no `itemId` — carry
 * null.
 *
 * The regenerate refusals (`limit_reached` at 429, `raced` at 409) are plain
 * `{ success, error, reason }` and `errorBodySchema` already describes them.
 */
export const planEditRejectedSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  reason: z.enum([
    'unknown_item',
    'invalid_instant',
    'invalid_interval',
    'outside_horizon',
    'outside_working_window',
    'overlaps_fixed_event',
    'overlaps_scheduled_item',
    'empty_edit',
  ]),
  itemId: z.string().nullable(),
});

export type PlanEditRejected = z.infer<typeof planEditRejectedSchema>;

/**
 * Mirrors `plan.settingsDefault.json` and `plan.settingsSaved.json`.
 *
 * `nextRunAt` is the server's own answer to "when does my next plan arrive".
 * It is null when delivery is off, and the client shows it rather than
 * recomputing a DST boundary on the phone. `deliveryLocalTime` is a local
 * wall-clock `HH:mm` in `timezone`, not an instant.
 *
 * `continuousReplanEnabled` is #523's switch: whether a change to the day may
 * rearrange a plan the user already has. It is independent of `enabled` (the
 * morning delivery) and of every calendar connection. Required, not optional:
 * the route always sends it, and an optional field here is how zod stripped
 * it silently before this screen existed — the server's `true` default would
 * have reached the switch as `undefined` and been drawn as "off".
 */
export const planSettingsSchema = z.object({
  enabled: z.boolean(),
  deliveryLocalTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'expected HH:mm'),
  timezone: z.string(),
  nextRunAt: isoDateTime.nullable(),
  continuousReplanEnabled: z.boolean(),
});

export const planSettingsResponseSchema = z.object({
  success: z.literal(true),
  planSettings: planSettingsSchema,
});

export const planCauseAttributionSchema = z.object({
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
  artifact: z.object({
    kind: z.enum(['notification', 'proposal', 'state_change', 'context_update', 'none']),
    ref: z.string().nullable(),
  }),
});

export const planCauseSchema = z.object({
  date: z.string(),
  generation: z.number().int().positive(),
  causeChangeIds: z.array(z.string()),
  attributions: z.array(planCauseAttributionSchema),
});

export const planCauseResponseSchema = z.object({
  success: z.literal(true),
  cause: planCauseSchema,
});

export type PlanSettings = z.infer<typeof planSettingsSchema>;
export type PlanSettingsResponse = z.infer<typeof planSettingsResponseSchema>;
export type PlanCause = z.infer<typeof planCauseSchema>;
export type PlanCauseResponse = z.infer<typeof planCauseResponseSchema>;
