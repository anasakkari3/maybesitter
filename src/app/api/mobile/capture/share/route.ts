/**
 * `POST /api/mobile/capture/share` — the only way bytes enter this product
 * (UC-3.0, #183).
 *
 * ── The order of the checks is the design ────────────────────────
 *
 *  1. the flag, so a build that does not offer share has no endpoint at all;
 *  2. the declared body size, so a 30 MB upload is refused by a header rather
 *     than after it has been received;
 *  3. authentication, before a single byte is parsed;
 *  4. `formData()`, which is the first thing that costs memory;
 *  5. the service, which sniffs, classifies, meters and reads.
 *
 * Putting auth after the size check is deliberate and is the one place this
 * differs from every other mobile route: an unauthenticated 30 MB body should
 * cost a header read, not a full receive followed by a 401.
 *
 * ── What the trace records ───────────────────────────────────────
 *
 * Counts. `src/app/api/mobile/capture/route.ts:30` writes the first 2000
 * characters of the raw input into `input_received`, which is defensible for
 * text somebody typed into this app and is not defensible for a chat export
 * they shared from another one. So this route's `input_received` payload has no
 * text field at all — not an empty one, not a truncated one — and its
 * `extraction_completed` payload carries no title.
 *
 * The one piece of shared content that leaves this route is
 * `share.evidence[].excerpt`, in the **response body** and nowhere else: it
 * goes back to the phone that sent it so the review screen can show which line
 * a commitment was read off. It is not traced, not logged, and not persisted —
 * confirm goes through the ordinary capture path, which has no field for it.
 */
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { recordTraceStage, stage } from '../../../../../../lib/alphaTrace/traceRecorder';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { shareDisabledResponse } from '../../../../../../lib/services/share/shareFlags';
import {
  MAX_TOTAL_BYTES,
  ShareQuotaError,
  proposeFromShare,
  shareTraceSessionId,
  type ShareIntakeRawFile,
} from '../../../../../../lib/services/share/shareIntakeService';
import { CaptureInputTooLargeError } from '../../../../../../lib/services/captureBoundary/captureBoundaryService';
import { ShareInputError } from '../../../../../../lib/services/share/shareTypes';

// `nodejs`, not edge: the service reads `Uint8Array`s with Node's `Buffer` on
// the way to Vertex, and the cost guard runs a Firestore transaction.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The multipart field files arrive under. Repeated, one part per file. */
const FILE_FIELD = 'files';

function tooLarge(): Response {
  return Response.json(
    { success: false, error: 'the share is larger than this route accepts', reason: 'file_too_large', maxBytes: MAX_TOTAL_BYTES },
    { status: 413 },
  );
}

/**
 * Refuses an over-sized body from its declared length.
 *
 * A lying `Content-Length` is not a hole: the service adds up the bytes it
 * actually received and refuses on the same rule. This is the cheap half, and
 * it is the half that stops a deliberate 30 MB upload from being buffered
 * before anyone says no.
 */
function declaredTooLarge(request: Request): boolean {
  const raw = request.headers.get('content-length');
  if (!raw) return false;
  const length = Number.parseInt(raw, 10);
  return Number.isFinite(length) && length > MAX_TOTAL_BYTES;
}

async function filesFrom(form: FormData): Promise<ShareIntakeRawFile[]> {
  const files: ShareIntakeRawFile[] = [];
  for (const entry of form.getAll(FILE_FIELD)) {
    if (typeof entry === 'string') continue;
    files.push({
      bytes: new Uint8Array(await entry.arrayBuffer()),
      declaredType: entry.type === '' ? null : entry.type,
      // Read once by the service to compute a three-word source hint, then
      // dropped. It never reaches a channel, a log or the response.
      fileName: typeof entry.name === 'string' && entry.name !== '' ? entry.name : null,
    });
  }
  return files;
}

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * A channel's metrics, with anything that is not a finite number removed.
 *
 * `SharePreprocessResult.metrics` is typed `Record<string, number>` and that is
 * the contract, but a channel is the only code in this pipeline that has held
 * the user's content, and this is the one place its output is written somewhere
 * durable. A type is a promise; this is the check. Keys are dropped rather than
 * coerced, because a channel sending a string here has a bug worth noticing as
 * a missing metric rather than hiding as `NaN`.
 */
function numbersOnly(metrics: Readonly<Record<string, number>>): Record<string, number> {
  const safe: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
  }
  return safe;
}

export async function POST(request: Request) {
  // The flag first. With it off there is no endpoint, which is what the client
  // renders its "not yet" notice from.
  const disabled = shareDisabledResponse();
  if (disabled) return disabled;

  if (declaredTooLarge(request)) return tooLarge();

  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // A body that is not multipart, or one that was cut off mid-upload. Both
    // are a request this route cannot read, and neither is worth two messages.
    return mobileError('the request body was not a readable multipart form');
  }

  const files = await filesFrom(form);
  const sessionId = shareTraceSessionId();

  try {
    const result = await proposeFromShare(
      {
        ...(field(form, 'text') === undefined ? {} : { text: field(form, 'text') }),
        files,
        ...(field(form, 'timezone') === undefined ? {} : { timezone: field(form, 'timezone') }),
        ...(field(form, 'referenceTime') === undefined ? {} : { referenceTime: field(form, 'referenceTime') }),
        ...(field(form, 'sourceHint') === undefined ? {} : { sourceHint: field(form, 'sourceHint') }),
      },
      { uid: user.uid, signal: request.signal },
    );

    try {
      // Counts, a channel id and a disposition. No text, no title, no name.
      await recordTraceStage(sessionId, user.uid, stage('input_received', {
        surface: 'share',
        kind: result.share.kind,
        fileCount: result.share.fileCount,
        // #183 step 8. A byte count is definitionally not content: it is the
        // one number about a share that cannot narrow down what was in it.
        totalBytes: result.share.totalBytes,
        channel: result.share.channel,
      }));
      await recordTraceStage(sessionId, user.uid, stage('extraction_completed', {
        surface: 'share',
        engine: result.provenance?.executedEngine ?? 'unknown',
        fallbackUsed: result.provenance?.fallbackUsed ?? false,
        disposition: result.status ?? 'unknown',
        itemCount: Array.isArray(result.items) ? result.items.length : 0,
        ignoredSegments: result.share.ignoredSegments,
        evidenceDropped: result.share.evidenceDropped,
        // Whatever the channel counted (#190 step 9, #191 step 10). The type
        // permits numbers only, which is what makes it safe to put here; the
        // values are re-checked rather than trusted, because a channel is the
        // one place in this pipeline that has touched the content.
        channelMetrics: numbersOnly(result.share.metrics),
      }));
    } catch {
      // Instrumentation must never break the product path.
    }

    if (result.status === 'rejected') return mobileError('Capture rejected');
    return Response.json(result);
  } catch (error) {
    /*
     * Every over-long refusal on this route, whichever ingress it came through
     * (#513). Share's own checks — on `input.text` before any parsing, and on
     * a file's text before the capture pipeline — throw the capture boundary's
     * own `CaptureInputTooLargeError` (#508), so this one branch mints
     * `text_too_long` and the body is the one the typed capture route sends:
     * 413 with `maxCharacters`, which `mobile/src/api/client.ts` turns into
     * `InputTooLargeError`. `ShareInputError` never carries `text_too_long`.
     */
    if (error instanceof CaptureInputTooLargeError) {
      return Response.json(
        { success: false, error: error.message, reason: 'text_too_long', maxCharacters: error.maxCharacters },
        { status: 413 },
      );
    }
    if (error instanceof ShareInputError) {
      return Response.json(
        { success: false, error: error.message, reason: error.reason },
        { status: error.status },
      );
    }
    if (error instanceof ShareQuotaError) {
      // The same body `quotaFor` in the mobile client already parses, so the
      // share screen shows the quota line the composer shows rather than a
      // generic failure (#181).
      return Response.json(
        {
          success: false,
          error: error.message,
          reason: 'share_quota',
          scope: 'user_daily',
          retryAfterSeconds: error.retryAfterSeconds,
        },
        { status: 429, headers: { 'retry-after': String(error.retryAfterSeconds) } },
      );
    }
    // Deliberately not `error.message` for anything else: a failure deeper in
    // the pipeline can quote the text it was reading, and here that text came
    // out of somebody's chat history.
    return mobileError('the share could not be read');
  }
}
