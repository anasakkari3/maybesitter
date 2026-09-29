import { useIcsFeeds } from '../../api/queries';
import { IcsFeedRefusedError } from '../../api/errors';
import { icsFeedsEnabled } from '../../config/env';

/**
 * Whether a calendar-links entry may be offered (owner's Redmi, 2026-09-29).
 *
 * The build flag (`EXPO_PUBLIC_FEATURE_ICS_FEEDS`) and the server's
 * (`ICS_FEEDS_ENABLED`) are separate on purpose, so a build with the screen
 * can meet a server without the routes. It did: every call answered 404
 * `feature_disabled`, and the entry led to a screen that only said «روابط
 * التقويم مش متوفرة بهاد الإصدار.». An entry to "not available" is a dead end,
 * so the server's own answer decides it too.
 *
 * The list the screen reads anyway is the probe — no second route. Offered
 * once it answers; hidden while it is in flight (the same rule as football's
 * `providerConfigured`: nothing is offered before it is known to be there)
 * and hidden for `feature_disabled`. Any other failure keeps the entry: the
 * screen says what went wrong and offers to try again, which is not a dead end.
 */
export function useIcsFeedsAvailable(): boolean {
  const feeds = useIcsFeeds();
  if (!icsFeedsEnabled()) return false;
  if (feeds.data !== undefined) return true;
  return feeds.error != null && !isIcsFeedsSwitchedOff(feeds.error);
}

/** The server has calendar links switched off (`ICS_FEEDS_ENABLED` not `true`). */
export function isIcsFeedsSwitchedOff(error: unknown): boolean {
  return error instanceof IcsFeedRefusedError && error.reason === 'feature_disabled';
}
