import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * The financial context, as the routes actually return it.
 *
 * Mirrors `src/contracts/v1/financialContracts.ts` — and is checked against
 * it, not trusted: `tests/mobile/exportMobileApiFixtures.test.ts` records the
 * real responses and the mobile suite parses them with these schemas, so a
 * backend shape change fails CI rather than a screen.
 *
 * Note what is not here: there is no transaction, no merchant and no account.
 * That is not a client-side omission — the contract has no such field, so the
 * app could not render one if a screen asked.
 */

const sourceKind = z.enum(['provider', 'manual']);

export const financialProvenanceSchema = z.object({
  origin: z.enum(['provider', 'manual', 'computed']),
  contributingSources: z.array(sourceKind),
  observedAt: isoDateTime,
  confidence: z.number().min(0).max(1),
  connectionId: z.string().nullable(),
});

export const derivedAmountSchema = z.object({
  minorUnits: z.number().int(),
  currency: z.string().length(3),
  provenance: financialProvenanceSchema,
});

export const financialObligationSchema = z.object({
  obligationId: z.string(),
  label: z.string().nullable(),
  category: z.enum(['rent', 'card', 'loan', 'subscription', 'utility', 'tuition', 'other']),
  dueAt: isoDateTime,
  amount: derivedAmountSchema,
  recurring: z.boolean(),
});

export const financialFieldIdSchema = z.enum([
  'currency',
  'cash_available',
  'next_income_at',
  'next_income_amount',
  'fixed_monthly_obligations',
  'recurring_count',
  'savings_goal',
]);

export const financialConflictSchema = z.object({
  field: financialFieldIdSchema,
  providerValue: z.union([z.number(), z.string()]).nullable(),
  manualValue: z.union([z.number(), z.string()]).nullable(),
  resolvedTo: sourceKind,
  reason: z.enum([
    'provider_authoritative_for_observed_fact',
    'user_correction_overrides_observation',
    'manual_authoritative_for_user_intent',
  ]),
});

export const financialStateSchema = z.object({
  version: z.string(),
  schemaVersion: z.literal('financial-state-v1'),
  scopeId: z.string(),
  asOf: isoDateTime,
  currency: z.string().length(3).nullable(),
  cashAvailable: derivedAmountSchema.nullable(),
  nextIncomeAt: z.object({ at: isoDateTime, provenance: financialProvenanceSchema }).nullable(),
  nextIncomeAmount: derivedAmountSchema.nullable(),
  obligationsBeforeNextIncome: derivedAmountSchema.nullable(),
  fixedMonthlyObligations: derivedAmountSchema.nullable(),
  recurringCount: z.object({ value: z.number().int(), provenance: financialProvenanceSchema }).nullable(),
  freeBuffer: derivedAmountSchema.nullable(),
  bufferBand: z.enum(['comfortable', 'tight', 'negative', 'unknown']),
  upcomingObligations: z.array(financialObligationSchema),
  savingsGoal: derivedAmountSchema.nullable(),
  sourceKinds: z.array(sourceKind),
  missingSourceKinds: z.array(sourceKind),
  conflicts: z.array(financialConflictSchema),
});

export const financialContextResponseSchema = z.object({
  success: z.literal(true),
  state: financialStateSchema,
});

export const manualFieldRowSchema = z.object({
  field: financialFieldIdSchema,
  kind: z.enum(['statement', 'correction']),
  value: z.union([z.number(), z.string()]),
  observedAt: isoDateTime,
});

export const manualObligationRowSchema = z.object({
  obligationId: z.string(),
  label: z.string(),
  category: financialObligationSchema.shape.category,
  dueAt: isoDateTime,
  amountMinorUnits: z.number().int(),
  currency: z.string().length(3),
  recurring: z.boolean(),
  observedAt: isoDateTime,
});

export const financialManualResponseSchema = z.object({
  success: z.literal(true),
  manual: z.object({
    fields: z.array(manualFieldRowSchema),
    obligations: z.array(manualObligationRowSchema),
  }),
});

export const financialManualSavedSchema = z.object({
  success: z.literal(true),
  field: manualFieldRowSchema.optional(),
  obligation: manualObligationRowSchema.optional(),
});

export const financialConnectionSchema = z.object({
  success: z.literal(true),
  connected: z.boolean(),
  /** Named for what it is; `sandbox` is the only source that exists today. */
  source: z.literal('sandbox').nullable(),
  connectedAt: isoDateTime.nullable(),
  capabilities: z.array(z.string()).optional(),
});

export type FinancialState = z.infer<typeof financialStateSchema>;
export type FinancialObligation = z.infer<typeof financialObligationSchema>;
export type FinancialConflict = z.infer<typeof financialConflictSchema>;
export type FinancialProvenance = z.infer<typeof financialProvenanceSchema>;
export type FinancialContextResponse = z.infer<typeof financialContextResponseSchema>;
export type FinancialManualResponse = z.infer<typeof financialManualResponseSchema>;
export type FinancialManualSaved = z.infer<typeof financialManualSavedSchema>;
export type FinancialConnection = z.infer<typeof financialConnectionSchema>;
export type FinancialFieldId = z.infer<typeof financialFieldIdSchema>;
