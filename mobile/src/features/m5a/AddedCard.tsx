import React, { useCallback, useState } from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Pill, Txt } from '../../ui/primitives';
import { Disclosure } from '../../ui/Disclosure';
import { LiveRegion } from '../../ui/liveRegion';
import { fill, ltr } from '../../i18n/strings';
import { formatRelativeDay, formatTime } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { isolateAuto } from '../../i18n/bidi';
import { useUid } from '../../api/queries';
import { getAddedPage, removeAdded } from '../../api/endpoints/m5a';
import type { AddedItem } from '../../api/schemas/m5a';
import { M5aRefusedError } from '../../api/errors';

/**
 * «انضاف من إيميلك» (M5a R3.5, D9): what the person agreed to in their own
 * email reply, added by itself, each with the words it came from and a
 * one-tap way out. Shown whatever the capability says while there is
 * anything to show (M5A-002) — the server answers 404 when the feature has
 * never been on, and the card steps aside.
 *
 * A row the person edited is theirs now: it says so instead of offering the
 * removal (`removable: false`, or a 409 `edited`). Done, dropped and archived
 * rows say what became of them, and offer nothing (M5A-R6-005).
 */
export const addedKey = (uid: string) => ['user', uid, 'emailAdded'] as const;

export function AddedCard() {
  const { t, p } = useApp();
  const uid = useUid();
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: addedKey(uid),
    queryFn: ({ pageParam }) => getAddedPage(pageParam, { asUid: uid }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: uid !== 'signed-out',
    retry: false,
  });
  const [edited, setEdited] = useState<ReadonlySet<string>>(new Set());
  const [removing, setRemoving] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const remove = useCallback(async (item: AddedItem) => {
    setRemoving(item.autoAddId);
    setSaid(null);
    try {
      await removeAdded(item.autoAddId, { asUid: uid });
      const line = fill(t.m5AddedRemoved, { title: isolateAuto(item.title) });
      setSaid(line);
      if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(line);
      void client.invalidateQueries({ queryKey: ['user', uid, 'commitments'] });
    } catch (error) {
      if (error instanceof M5aRefusedError && error.code === 'edited') {
        setEdited((current) => new Set([...current, item.autoAddId]));
        return;
      }
    } finally {
      setRemoving(null);
      void client.invalidateQueries({ queryKey: addedKey(uid) });
    }
  }, [client, t.m5AddedRemoved, uid]);

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (items.length === 0 && said === null) return null;

  return (
    <Card style={{ gap: 12 }} testID="added-card">
      <Disclosure id="m5-added-why" body={t.m5AddedWhy} label={t.m5AddedTitle}>
        <Txt role="section">{t.m5AddedTitle}</Txt>
      </Disclosure>
      <LiveRegion>{said ? <Txt role="supporting" color={p.mu} testID="added-removed">{said}</Txt> : null}</LiveRegion>
      {items.map((item) => <AddedRow key={item.autoAddId} item={item} edited={edited.has(item.autoAddId)}
        removing={removing === item.autoAddId} disabled={removing !== null} onRemove={() => void remove(item)} />)}
      {query.hasNextPage ? (
        <Pill testID="added-more" label={t.m5AddedMore} kind="outline" size={14} pad={12}
          disabled={query.isFetchingNextPage} onPress={() => void query.fetchNextPage()} />
      ) : null}
    </Card>
  );
}

const STATUS_KEY = {
  done: 'm5AddedStatusDone',
  dropped: 'm5AddedStatusDropped',
  archived: 'm5AddedStatusArchived',
} as const;

function AddedRow({ item, edited, removing, disabled, onRemove }: {
  item: AddedItem; edited: boolean; removing: boolean; disabled: boolean; onRemove: () => void;
}) {
  const { t, p, lang } = useApp();
  const zone = useTimeZone();
  const when = (instant: string) => {
    const date = new Date(instant);
    return `${formatRelativeDay(date, { locale: lang, timeZone: zone })} · ${ltr(formatTime(date, { locale: lang, timeZone: zone }))}`;
  };
  const open = item.status === 'open';
  const removable = open && item.removable && !edited;
  return (
    <View testID={`added-row-${item.autoAddId}`} style={{ gap: 6, borderTopWidth: 1, borderTopColor: p.ln, paddingTop: 12, alignItems: 'flex-start' }}>
      <Txt role="body">{isolateAuto(item.title)}</Txt>
      {item.startsAt ? <Txt role="supporting" color={p.mu} testID={`added-when-${item.autoAddId}`}>{when(item.startsAt)}</Txt> : null}
      <Txt role="supporting" color={p.mu}>{fill(t.m5AddedEvidence, { evidence: isolateAuto(item.evidence) })}</Txt>
      {item.status !== 'open' ? (
        <Txt role="supporting" color={p.mu} testID={`added-status-${item.autoAddId}-${item.status}`}>{t[STATUS_KEY[item.status]]}</Txt>
      ) : null}
      {open && !removable ? (
        <Txt role="supporting" color={p.mu} testID={`added-edited-${item.autoAddId}`}>{t.m5AddedEdited}</Txt>
      ) : null}
      {removable ? (
        <Btn
          testID={`added-remove-${item.autoAddId}`}
          label={fill(t.m5AddedRemoveA11y, { title: item.title })}
          disabled={disabled}
          onPress={onRemove}
          style={{ minHeight: 44, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: p.ln }}
        >
          <Txt size={14} color={p.ac}>{removing ? '…' : t.m5AddedRemove}</Txt>
        </Btn>
      ) : null}
    </View>
  );
}
