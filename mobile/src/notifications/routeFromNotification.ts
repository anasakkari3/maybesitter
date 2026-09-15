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
 * accepted only as `YYYY-MM-DD` and `commitmentId` only in the shape the
 * backend mints, because the destination of a tap is not a place to start
 * being relaxed about input. An unroutable payload opens Today, which is where
 * the app opens anyway.
 */

export type NotificationRoute =
  | { readonly kind: 'plan'; readonly planDate: string }
  | { readonly kind: 'commitment'; readonly commitmentId: string }
  | { readonly kind: 'today' };

const PLAN_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Wide enough for a uuid and for the domain's own `plan_fixture_0` shapes. */
const COMMITMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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
    // A date that is well formed but impossible — 2026-13-45 — is not a
    // route; `Date.parse` is asked rather than trusted to the regex alone.
    if (typeof planDate === 'string' && PLAN_DATE.test(planDate) && !Number.isNaN(Date.parse(planDate))) {
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
