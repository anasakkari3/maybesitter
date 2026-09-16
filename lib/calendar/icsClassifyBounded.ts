/**
 * `classifyIcs`, with a hard bound on how long and how much memory one
 * calendar may cost (UC-3.4, #188; review of #445, B1).
 *
 * ── Why a worker, and not a step counter ─────────────────────────
 *
 * Recurrence expansion counts steps, but *between* calls to ical.js's
 * `RecurIterator.next()` — and in ical.js 2.2.1 a single `next()` never
 * returns for some rules. `FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30` is impossible
 * and `classifyIcs` refuses it before iterating; but
 * `FREQ=DAILY;INTERVAL=7;BYDAY=MO;BYMONTHDAY=1` starting on a Thursday is
 * made of parts that are each satisfiable, and still spins for ever. A budget
 * checked after a call that does not return is not a budget, and synchronous
 * JavaScript cannot be interrupted from its own thread.
 *
 * So expansion — the only part that can fail to terminate — runs in a
 * `worker_threads` Worker with a heap limit and a wall clock. Past either, the
 * worker is terminated and the caller gets `IcsTooComplexError`. The rest
 * (parsing, which is linear, and the rules) runs here on the result. A calendar
 * with no recurring events never starts a worker at all.
 *
 * ── Why the worker is a plain .mjs file found from the working directory ──
 *
 * A Next.js standalone build compiles `new Worker(new URL('./x', import.meta.url))`
 * into a URL under `/_next/` that does not exist on disk, and a worker cannot
 * run the app's TypeScript. `icsExpand.worker.mjs` is plain JavaScript, copied
 * into the standalone output by `outputFileTracingIncludes` in next.config.js,
 * and resolved from `process.cwd()`, which is the repository root under
 * `next dev` and the tests and `/app` in the container.
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  classifyIcs,
  expansionRequest,
  type ClassifyIcsOptions,
  type IcsClassification,
  type RecurrenceExpansion,
} from './icsImport';

export const CLASSIFY_TIMEOUT_MS = 2_000;
export const CLASSIFY_HEAP_MB = 128;

export const EXPAND_WORKER_PATH = ['lib', 'calendar', 'icsExpand.worker.mjs'];

/** The calendar could not be read within the time or memory a calendar is allowed. */
export class IcsTooComplexError extends Error {
  constructor() {
    super('the calendar is too expensive to read');
    this.name = 'IcsTooComplexError';
  }
}

function expandInWorker(
  text: string,
  request: { masters: number[]; horizonMs: number },
  timeoutMs: number,
): Promise<RecurrenceExpansion> {
  return new Promise<RecurrenceExpansion>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(path.join(process.cwd(), ...EXPAND_WORKER_PATH), {
      workerData: { text, request },
      resourceLimits: { maxOldGenerationSizeMb: CLASSIFY_HEAP_MB, maxYoungGenerationSizeMb: 32 },
    });
    const finish = (outcome: RecurrenceExpansion | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const timer = setTimeout(() => finish(new IcsTooComplexError()), timeoutMs);
    worker.once('message', (message: { ok: true; expansion: RecurrenceExpansion } | { ok: false }) => {
      finish(message.ok ? message.expansion : new IcsTooComplexError());
    });
    // Out of memory, or anything else that ends the worker, is the calendar
    // costing more than it may. The error is not passed on: it is about the
    // input, and the input is somebody's feed.
    worker.once('error', () => finish(new IcsTooComplexError()));
    worker.once('exit', () => finish(new IcsTooComplexError()));
  });
}

export async function classifyIcsBounded(
  text: string,
  options: ClassifyIcsOptions,
  limits: { timeoutMs?: number } = {},
): Promise<IcsClassification> {
  // Throws IcsParseError for what is not a calendar, on this thread, cheaply.
  const request = expansionRequest(text, options);
  if (request.masters.length === 0) return classifyIcs(text, { now: options.now, timeZone: options.timeZone, expansion: {} });
  const expansion = await expandInWorker(text, request, limits.timeoutMs ?? CLASSIFY_TIMEOUT_MS);
  return classifyIcs(text, { now: options.now, timeZone: options.timeZone, expansion });
}
