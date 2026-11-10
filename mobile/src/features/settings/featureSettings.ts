import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getFeatures, setFeatureEnabled } from '../../api/endpoints/features';
import { NotFoundError } from '../../api/errors';
import type { FeatureCapabilities, FeatureCapability } from '../../api/schemas/features';
import type { TagKind } from '../../ui/chrome';
import { useUid } from '../../api/queries';
import type { Strings } from '../../i18n/strings';

/**
 * The person's features (core and add-ons) and their own switch for each
 * add-on (`/api/mobile/capabilities/features`).
 *
 * While the server's gate is `off` there is nothing to choose, so Settings
 * shows no entry at all and the app looks exactly as it did before. A server
 * that predates the route answers 404, read as `off` the same way.
 */
const FIVE_MINUTES = 5 * 60_000;
const OFF: FeatureCapabilities = { success: true, mode: 'off', features: [] };

async function probe(uid: string): Promise<FeatureCapabilities> {
  try {
    return await getFeatures({ asUid: uid });
  } catch (error) {
    // FeatureUnavailableError is a NotFoundError too.
    if (error instanceof NotFoundError) return OFF;
    throw error;
  }
}

export const featuresKey = (uid: string) => ['user', uid, 'features'] as const;

export function useFeatures() {
  const uid = useUid();
  return useQuery({
    queryKey: featuresKey(uid),
    queryFn: () => probe(uid),
    enabled: uid !== 'signed-out',
    staleTime: FIVE_MINUTES,
    refetchOnWindowFocus: true,
  });
}

/**
 * Whether Settings offers the Features entry: only on a successful answer
 * whose mode is not `off`. Unknown (loading, failed) offers nothing, so a
 * flaky probe never makes an entry appear and vanish.
 */
export function useFeaturesEntryShown(): boolean {
  const query = useFeatures();
  return query.status === 'success' && query.data.mode !== 'off';
}

/**
 * One add-on switched on or off. The server's answer is the whole list again
 * and goes straight into the cache. Switches share one mutation scope, so two
 * quick taps on two rows are sent one after the other, never racing. Never
 * retried (mutations never are). A failure refetches, so the screen shows
 * what is really saved.
 */
export function useSetFeatureEnabled() {
  const client = useQueryClient();
  const uid = useUid();
  return useMutation({
    scope: { id: `features:${uid}` },
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => setFeatureEnabled(id, enabled, { asUid: uid }),
    onSuccess: (data) => {
      client.setQueryData(featuresKey(uid), data);
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: featuresKey(uid) });
    },
  });
}

/* ── What a row says ─────────────────────────────────────────────── */

/** A key whose copy is one string (a few keys hold lists). */
type CopyKey = { [K in keyof Strings]: Strings[K] extends string ? K : never }[keyof Strings];

/** The ids this build has words for. Any other id is skipped, not shown blank. */
export const FEATURE_COPY: Readonly<Record<string, { name: CopyKey; body: CopyKey }>> = {
  assistant: { name: 'featureAssistantName', body: 'featureAssistantBody' },
  gmail_reading: { name: 'featureGmailReadingName', body: 'featureGmailReadingBody' },
  meeting_prep: { name: 'featureMeetingPrepName', body: 'featureMeetingPrepBody' },
  goal_plans: { name: 'featureGoalPlansName', body: 'featureGoalPlansBody' },
  memory_learning: { name: 'featureMemoryLearningName', body: 'featureMemoryLearningBody' },
  memory_translation: { name: 'featureMemoryTranslationName', body: 'featureMemoryTranslationBody' },
  search_history: { name: 'featureSearchHistoryName', body: 'featureSearchHistoryBody' },
  football: { name: 'featureFootballName', body: 'featureFootballBody' },
};

export function knownFeature(feature: FeatureCapability): boolean {
  return Object.hasOwn(FEATURE_COPY, feature.id);
}

/**
 * The status in a word, and its chip. The person's own "off" wins (it is what
 * they chose); otherwise a usable feature is on whatever the reason, and a
 * refused one says why. A reason this build does not know reads as "not
 * available right now" rather than inventing a cause.
 */
export function featureStatus(feature: FeatureCapability): { key: CopyKey; kind: TagKind } {
  if (feature.tier === 'core' && feature.enabled) return { key: 'featuresStatusAlwaysOn', kind: 'saved' };
  if (feature.reason === 'user_off') return { key: 'featuresStatusOff', kind: 'muted' };
  if (feature.enabled) return { key: 'featuresStatusOn', kind: 'saved' };
  switch (feature.reason) {
    case 'not_entitled': return { key: 'featuresStatusNeedsSubscription', kind: 'muted' };
    case 'budget_spent':
    case 'free_cap_spent': return { key: 'featuresStatusAllowanceUsed', kind: 'important' };
    default: return { key: 'featuresStatusUnavailable', kind: 'important' };
  }
}

/** The switch shows the person's own choice: on unless they turned it off. */
export function switchedOn(feature: FeatureCapability): boolean {
  return feature.reason !== 'user_off';
}
