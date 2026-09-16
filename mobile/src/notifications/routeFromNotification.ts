/**
 * Where a tapped notification takes you (UC-3.0b #184, UC-3.11 #196).
 *
 * ── One function, two sources ────────────────────────────────────
 *
 * Taps arrive from the expo-notifications response listener, from
 * `getLastNotificationResponseAsync()` on a cold start, and — if a push
 * displayed by React Native Firebase does not reach that listener — from
 * `onNotificationOpenedApp`/`getInitialNotification`. Three entry points, and
 * a routing rule written at each one is three rules that drift. They all call
 * this.
 *
 * ── Nothing in `data` is trusted ─────────────────────────────────
 *
 * A notification payload is a string map that has been through Google's
 * servers, the OS notification store, and possibly a relaunch. `planDate` is
 * accepted only as a `YYYY-MM-DD` naming a day that exists, and `commitmentId`
 * only in the shape the backend mints, because the destination of a tap is not
 * a place to start being relaxed about input. An unroutable payload opens
 * Today, which is where the app opens anyway.
 */

export type NotificationRoute =
  | { readonly kind: 'plan'; readonly planDate: string }
  | { readonly kind: 'commitment'; readonly commitmentId: string }
  | { readonly kind: 'today' };

/** Wide enough for a uuid and for the domain's own `plan_fixture_0` shapes. */
const COMMITMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Whether `value` is a plain local date naming a day that exists.
 *
 * One check, not two. It started as an anchored `^\d{4}-\d{2}-\d{2}$`
 * *plus* a `Date.parse`, and neither half was right on its own: the regex let
 * `2026-02-30` through and `Date.parse` accepts it, rolling it over to 2 March;
 * `Date.parse` alone accepts `2026-9-16` and a trailing space.
 *
 * Rendering the parsed instant back and demanding the same ten characters does
 * the whole job, because an ISO date slice is always `YYYY-MM-DD` — so the
 * equality *is* the shape check, `2026-02-30` fails it by coming back as
 * `2026-03-02`, and «٢٠٢٦-٠٩-١٦» fails it by not parsing. Keeping the regex
 * beside it was the risk, not the safety: it looked like the guard while
 * enforcing nothing, so a later edit could have relaxed the half that mattered
 * and left the decorative half behind.
 *
 * The `T00:00:00.000Z` is not decoration either. `Date.parse` of a bare
 * date-only string is UTC by spec and local by history, and this app has
 * already been bitten once by Hermes reading a date differently from Node
 * (`src/lib/time/zoneOffset.ts`). Naming the instant means the round trip
 * compares the same two things on both engines. Dropping it passes this
 * file's tests on Node, which is exactly why it is written down here.
 */
function isPlainLocalDate(value: string): boolean {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/**
 * The screen a payload names, or Today.
 *
 * `hard_reminder` and the local soft stages both open the commitment; the
 * difference between them is how loudly they arrived, not where they lead.
 */
export function routeFromNotification(data: unknown): NotificationRoute {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'today' };
  const raw = data as Record<string, unknown>;

  const commitmentId = raw.commitmentId;
  if (typeof commitmentId === 'string' && COMMITMENT_ID.test(commitmentId)) {
    return { kind: 'commitment', commitmentId };
  }

  if (raw.kind === 'plan_ready') {
    const planDate = raw.planDate;
    if (typeof planDate === 'string' && isPlainLocalDate(planDate)) {
      return { kind: 'plan', planDate };
    }
  }

  return { kind: 'today' };
}

/** The commitment a soft reminder is about, for the awareness record. */
export function commitmentIdOf(data: unknown): string | null {
  const route = routeFromNotification(data);
  return route.kind === 'commitment' ? route.commitmentId : null;
}
