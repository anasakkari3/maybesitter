import { apiUpload, type UploadFile } from '../client';
import { shareProposalSchema, type ShareProposal } from '../schemas/share';

/**
 * Analyze what the user shared (UC-3.0, #183).
 *
 * ── One call, and it proposes ────────────────────────────────────
 *
 * There is no "share confirm". A share produces the ordinary capture proposal,
 * and the user confirms it with `POST /api/mobile/capture/confirm` through the
 * flow they already know. That is the whole point of the pipeline: the only new
 * request in the product is this one.
 *
 * ── Never retried ────────────────────────────────────────────────
 *
 * `apiUpload` refreshes once on a 401 and otherwise does not retry, and nothing
 * wraps this in one. A share that may or may not have arrived costs the user a
 * slice of their daily allowance and a second upload on their data plan if it
 * is replayed, and they are standing there watching.
 *
 * ── What it sends ────────────────────────────────────────────────
 *
 * Text fields and file descriptors. The client does **not** send `kind`: the
 * server classifies from the bytes, and a `kind` from here would be a claim it
 * would have to ignore anyway. `sourceHint` is sent because the app sometimes
 * knows something the bytes do not — that the share arrived from WhatsApp —
 * and the server treats it as a hint ranked below what it sniffs.
 */
export function proposeFromShare(input: {
  text?: string | undefined;
  files?: readonly UploadFile[];
  timezone: string;
  referenceTime?: string;
  sourceHint?: 'whatsapp' | 'email' | 'unknown';
  signal?: AbortSignal;
}): Promise<ShareProposal> {
  return apiUpload('/api/mobile/capture/share', {
    fields: {
      ...(input.text === undefined ? {} : { text: input.text }),
      timezone: input.timezone,
      referenceTime: input.referenceTime ?? new Date().toISOString(),
      sourceHint: input.sourceHint ?? 'unknown',
    },
    files: input.files ?? [],
    fileField: 'files',
    schema: shareProposalSchema,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
