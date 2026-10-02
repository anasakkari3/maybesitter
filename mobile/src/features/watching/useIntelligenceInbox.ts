import { useQuery } from '@tanstack/react-query';
import { useUid } from '../../api/queries';
import { getIntelligenceInbox } from '../../api/endpoints/intelligence';

export const intelligenceInboxKey = (uid: string) => ['user', uid, 'intelligenceInbox'] as const;

/**
 * The proactive loop's inbox, read-only, for «يتابع لك» (Stitch, 2026-10-02).
 *
 * The same `GET /api/mobile/intelligence` the Goals screen's panel reads; it
 * never generates (that is a model call, and stays behind the panel's own
 * button). Deciding a suggestion or answering a question also stays where it
 * already lives — this hub only shows what is waiting and opens that screen.
 */
export function useIntelligenceInbox() {
  const uid = useUid();
  // Read again on every visit: the panel that decides suggestions fetches
  // the inbox itself and does not invalidate this key, so coming back from it
  // must not show what was just answered as still waiting.
  return useQuery({ queryKey: intelligenceInboxKey(uid), queryFn: getIntelligenceInbox, enabled: uid !== 'signed-out', refetchOnMount: 'always' });
}
