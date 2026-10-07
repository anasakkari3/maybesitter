import { FeatureUnavailableError } from '../../api/errors';
import { useUpcomingPlans } from '../../api/queries';

/**
 * Whether the plan path is on (M3a is `RELEASE_LOCKED`: on in local and
 * staging only). The app learns it from the one read every plan entry
 * shares — Today's later-week card — and hides every entry on the same
 * `FeatureUnavailableError` the other gated features use. Any other failure
 * leaves the entries showing: pressing one then says what went wrong.
 */
export function usePlanPathAvailable(): boolean {
  const upcoming = useUpcomingPlans();
  if (upcoming.isPending) return false;
  return !(upcoming.error instanceof FeatureUnavailableError);
}
