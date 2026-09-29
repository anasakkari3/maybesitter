import { useFootballSettings } from '../../api/queries';
import { useIcsFeedsAvailable } from '../calendarFeeds/availability';

/**
 * Which of the Sources screen's two entries exist in this build and on this
 * server (closure CL7).
 *
 * Calendar links show only when the build has them and the server answers
 * for them (`useIcsFeedsAvailable`); football only when the server holds the
 * match data key (`providerConfigured`). With neither, the
 * Sources row itself is hidden everywhere: a row that leads to an empty page
 * or to a follow that never fills is worse than no row.
 */
export interface SourcesAvailability {
  readonly ics: boolean;
  readonly football: boolean;
  readonly any: boolean;
}

export function useSourcesAvailability(): SourcesAvailability {
  const football = useFootballSettings().data?.providerConfigured === true;
  const ics = useIcsFeedsAvailable();
  return { ics, football, any: ics || football };
}

/** The Settings row's subtitle names only what is really there. */
export function sourcesSubKey(availability: SourcesAvailability): 'settingsSourcesSub' | 'settingsSourcesSubIcsOnly' | 'settingsSourcesSubNoIcs' {
  if (availability.ics && availability.football) return 'settingsSourcesSub';
  return availability.ics ? 'settingsSourcesSubIcsOnly' : 'settingsSourcesSubNoIcs';
}
