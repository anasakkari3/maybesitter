/**
 * Runs a test file on a fixed calendar day: `Date.now()` and `new Date()`
 * start at `startIso` and move forward with real time. Imported first, through
 * a day module, before anything that reads the clock at load.
 *
 * The capture chat tests name days relative to today ("tomorrow", "Friday",
 * "Tuesday and Thursday"). On some real days two of those are the same day
 * (on a Thursday, tomorrow is Friday), and cases written to tell them apart
 * stop meaning anything. They first failed on Thursday 2026-10-08 at 00:13
 * Jerusalem time. Pinning the day keeps every case about what it says.
 *
 * Each file pins the day its cases were written for, through a one-line
 * module (`pinnedWednesday.ts`, `pinnedTuesday.ts`), so the pin runs before
 * anything else the file imports.
 */
const RealDate = Date;

export function pinClock(startIso: string): void {
  const start = RealDate.parse(startIso);
  const realStart = RealDate.now();
  const now = () => start + (RealDate.now() - realStart);
  class PinnedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now());
      else super(...(args as [string | number | Date]));
    }
    static override now(): number { return now(); }
  }
  globalThis.Date = PinnedDate as DateConstructor;
}

