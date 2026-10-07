/**
 * Runs a test file on a fixed calendar day: `Date.now()` and `new Date()`
 * start at `startIso` and move forward with real time. Import it first, before
 * anything that reads the clock at load.
 *
 * The capture chat tests name days relative to today ("tomorrow", "Friday",
 * "Tuesday and Thursday"). On some real days two of those are the same day
 * (on a Thursday, tomorrow is Friday), and cases written to tell them apart
 * stop meaning anything. They first failed on Thursday 2026-10-08 at 00:13
 * Jerusalem time. Pinning the day keeps every case about what it says.
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

// A Wednesday, mid-morning in Jerusalem: tomorrow, Friday, Saturday, Tuesday
// and Thursday are all different days, and nothing is near midnight.
pinClock('2026-10-07T07:00:00.000Z');
