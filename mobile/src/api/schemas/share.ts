import { z } from 'zod';
import { captureProposalSchema } from './capture';

/**
 * `POST /api/mobile/capture/share` (UC-3.0, #183).
 *
 * ── It is the capture proposal, plus an envelope ─────────────────
 *
 * Deliberately `captureProposalSchema.extend(...)` rather than a schema of its
 * own. The route returns the same contract the ordinary capture route does,
 * because a share goes through the same `proposeMobileCapture` — so review,
 * clarify, edit, confirm and undo work on it unchanged. If this were a separate
 * schema, the two could drift apart while both still parsing, and the first
 * thing anyone would notice is a share that cannot be confirmed.
 *
 * The extension is **counts and codes only**. Nothing in it is derived from
 * what the user shared, which is the same rule the server's trace follows.
 *
 * `capture.shareProposal.json` is generated from the real handler by
 * `tests/mobile/exportMobileApiFixtures.test.ts`, and the fixture test parses
 * it with this schema. One caveat when reading that file by eye: the fixture
 * normaliser replaces every uuid with a fresh counter value, so
 * `share.suggestedNextAction.itemId` does not *look* like `items[0].itemId`
 * there. In a real response they are the same string.
 */
export const shareProposalSchema = captureProposalSchema.extend({
  share: z.object({
    /**
     * Which channel read the share — `plain-text` today, joined by
     * `whatsapp`, `image`, `pdf` and `email` as #189–#192 land.
     *
     * `z.string()` and not an enum, on purpose and against this repository's
     * usual rule. A build of this app will meet a server that has channels it
     * has never heard of, and an enum would turn that into a `ContractError`
     * on a screen the user is looking at, for a value that is only ever shown
     * to us. The enums that *are* strict here are the ones the client branches
     * on.
     */
    channel: z.string(),
    kind: z.enum(['text', 'images', 'pdf', 'textFile', 'chatArchive', 'calendarFile']),
    fileCount: z.number().int().nonnegative(),
    /** Total size of everything shared, in bytes (#183 step 8). */
    totalBytes: z.number().int().nonnegative(),
    /** How many parts the channel deliberately dropped. A count, never content. */
    ignoredSegments: z.number().int().nonnegative(),
    /**
     * Where each proposed item was read from (#183 step 7f).
     *
     * The one part of this envelope that carries shared content, and the reason
     * the review screen can show a bubble saying "this came from here". It is
     * per item and by item id rather than by position, so a screen that
     * reorders or filters items cannot mismatch them.
     *
     * Empty is normal: a channel that does not attribute its output returns
     * nothing here, and so does the server when the extractor did not return one
     * item per segment — see `evidenceDropped`. A screen renders the bubble when
     * there is one and renders nothing when there is not; it must never fall
     * back to a neighbouring item's evidence.
     */
    evidence: z.array(z.object({
      itemId: z.string(),
      /** Index into the files that were shared, or null for the shared text. */
      sourceIndex: z.number().int().nonnegative().nullable(),
      excerpt: z.string().max(140),
    })),
    /**
     * True when the channel offered evidence the server could not tie to items
     * one-for-one, so it returned none. Diagnostic; nothing on screen.
     */
    evidenceDropped: z.boolean(),
    /**
     * Whatever the channel counted. Numbers only.
     *
     * `z.record` and not a fixed shape, for the same reason `channel` is a
     * string: this build will meet a server whose channels count things it has
     * never heard of, and a strict shape would turn that into a `ContractError`
     * on a screen the user is looking at, over values only we read.
     */
    metrics: z.record(z.string(), z.number()),
    /**
     * The one thing worth doing next, naming an **item** and not a commitment:
     * nothing has been saved yet, so there is no commitment id to name.
     */
    suggestedNextAction: z
      .object({
        kind: z.enum(['review', 'plan_time', 'set_reminder']),
        itemId: z.string(),
      })
      .nullable(),
  }),
});

export type ShareProposal = z.infer<typeof shareProposalSchema>;
