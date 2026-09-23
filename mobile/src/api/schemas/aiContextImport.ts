/**
 * What the AI context import endpoints answer with.
 *
 * Its own file rather than more of `profile.ts`: that file is the memory and
 * profile contract several screens already read, and the locale files have
 * already taught this repo what happens when two lanes edit one hot file.
 *
 * The kind and category enums come from `common.ts` rather than being restated.
 * Two copies of the same eight categories is two lists that drift, and the one
 * that drifts rejects a live response. They live in `common` rather than in
 * `profile` because `profile`'s own response now carries this file's receipt,
 * and an import in both directions is a load-time cycle: zod evaluates at module
 * scope, so one of the two halves comes back undefined.
 */
import { z } from 'zod';
import { isoDateTime, suggestionSchema } from './common';

/**
 * A closed list, and closed on purpose: the app renders a *name* for each one,
 * so an assistant it cannot name is an assistant it cannot label. It will grow
 * — a deep import adds `chatgpt_export` — and this is one of the three places
 * that has to learn the new value.
 */
export const importAssistantSchema = z.enum(['chatgpt', 'gemini', 'claude', 'other']);

/**
 * How a candidate stands to what the account already remembers.
 *
 * `conflict` is not "the new one wins". It is the server saying two sentences
 * cannot both be true and declining to choose, which is why the review screen
 * has to offer a choice rather than a checkbox.
 */
export const importRelationSchema = z.enum(['new', 'update', 'conflict']);

/**
 * One line the assistant wrote, and the record it may relate to.
 *
 * `relatesToId` is a real memory id and that is fine: it is the reader's own
 * record, whose id this app already holds from `GET /api/mobile/memory`, and
 * the review screen needs it to show which sentence is being replaced. The
 * model never saw an id — it was shown numbers.
 */
export const importCandidateSchema = suggestionSchema.extend({
  relation: importRelationSchema,
  relatesToId: z.string().nullable(),
});

export const aiContextImportProposalSchema = z.object({
  success: z.literal(true),
  proposalId: z.string(),
  assistant: importAssistantSchema,
  candidates: z.array(importCandidateSchema),
  summary: z.object({
    new: z.number(),
    updates: z.number(),
    conflicts: z.number(),
  }),
  /**
   * How many records were actually compared against, and how many the account
   * has. When these differ the screen says so: a comparison the user believes
   * was complete, and was not, is how a duplicate reads as a new discovery.
   */
  existingConsidered: z.number(),
  existingTotal: z.number(),
  existingTruncated: z.boolean(),
  createdAt: isoDateTime,
  promptVersion: z.string(),
  model: z.string().nullable(),
});

/** What actually happened, as opposed to what was offered. */
export const aiContextImportConfirmedSchema = z.object({
  success: z.literal(true),
  created: z.number(),
  superseded: z.number(),
  unchanged: z.number(),
  conflicts: z.number(),
  /** Updates whose target had moved on by the time the write happened. */
  demoted: z.number(),
  kinds: z.record(z.string(), z.number()),
});

/** When the account last brought context in, for the Settings row. */
export const aiContextImportReceiptSchema = z.object({
  lastImportedAt: isoDateTime,
  assistant: importAssistantSchema,
  counts: z.object({
    created: z.number(),
    superseded: z.number(),
    unchanged: z.number(),
    conflicts: z.number(),
  }),
  promptVersion: z.string(),
});

export type ImportAssistant = z.infer<typeof importAssistantSchema>;
export type ImportRelation = z.infer<typeof importRelationSchema>;
export type ImportCandidate = z.infer<typeof importCandidateSchema>;
export type AiContextImportProposal = z.infer<typeof aiContextImportProposalSchema>;
export type AiContextImportConfirmed = z.infer<typeof aiContextImportConfirmedSchema>;
export type AiContextImportReceipt = z.infer<typeof aiContextImportReceiptSchema>;
