/**
 * The search's server half, in words (CA5.2).
 *
 * The list under a search holds what the screen had loaded plus what the
 * server found. While the server has not answered, or when it failed, «ما
 * لقينا إشي بهالاسم» would claim something the app does not know: a done or
 * dropped item exists only on the server. So the empty state says it is still
 * looking, or that only this phone's items are shown, with a retry; and a
 * failure under results says the same. A polite live region carries it, and
 * VoiceOver hears it through `useAnnounceOnIos`.
 */
import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Pill, Txt } from '../../ui/primitives';
import { LiveRegion } from '../../ui/liveRegion';
import { useAnnounceOnIos } from '../../ui/announce';
import type { CommitmentMatches } from './useSearch';

export function SearchServerLine({ search, empty, noResultsTestID, noResultsText }: {
  search: Pick<CommitmentMatches, 'server' | 'retry'>;
  /** True when the list has no row: the empty state is this line. */
  empty: boolean;
  noResultsTestID: string;
  noResultsText: string;
}) {
  const { t, p } = useApp();
  const failed = search.server === 'failed';
  const pending = search.server === 'pending' && empty;
  useAnnounceOnIos(failed ? t.m6SearchFailed : null);
  return (
    <LiveRegion>
      {failed ? (
        <View style={{ gap: 8, alignItems: 'flex-start', paddingVertical: empty ? 12 : 4 }}>
          <Txt role="supporting" color={p.mu} testID="m6-search-failed">{t.m6SearchFailed}</Txt>
          <Pill testID="m6-search-retry" label={t.errorsRetry} kind="outline" size={14} pad={12} onPress={search.retry} />
        </View>
      ) : pending ? (
        <Txt role="supporting" color={p.mu} testID="m6-search-pending">{t.m6SearchPending}</Txt>
      ) : empty ? (
        <Txt role="supporting" color={p.mu} testID={noResultsTestID}>{noResultsText}</Txt>
      ) : null}
    </LiveRegion>
  );
}
