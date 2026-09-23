import React, { useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import { useTimeZone } from '../../i18n/timezone';
import { formatDate, formatTime } from '../../i18n/format';
import { isolate } from '../../i18n/bidi';
import { Btn, Card, Pill, Txt } from '../../ui/primitives';
import { Dialog } from '../../ui/dialog';
import { ProductPage, ProductSection, ProductActions, ProductRow, PreviewNotice, PreviewAction, AvailabilityBadge } from '../../ui/product';
import { useWatchers, useWatcherAction } from './useWatchers';
import { capabilities as cap, watchSources, type WatchSource } from './capabilities';
const effectKeys = { notify: 'xNotify', replan_if_impacted: 'xReplan', propose_commitment: 'xPropose', update_context: 'xContext' } as const;
export function BackgroundActivityScreen() {
  const { t, p, lang, actions } = useApp();
  const zone = useTimeZone();
  const query = useWatchers();
  const action = useWatcherAction();
  const [deleting, setDeleting] = useState<string | null>(null);
  const items = query.data?.items ?? [];
  return <ProductPage id="background" title={t.xBackground} subtitle={t.xBackgroundBody} overlay={deleting ? <Dialog title={t.xRemoveWatch} body={t.xRemoveWatchBody} confirmLabel={t.memoryDelete} cancelLabel={t.cancel}
      onCancel={() => setDeleting(null)} onConfirm={() => { action.mutate({ id: deleting, action: 'delete' }); setDeleting(null); }} /> : null}>
    <ProductSection title={t.xBeta} body={t.xWatchLimits} icon="shield" />
    {action.error ? <Txt color={p.wm}>{userFacingMessage(action.error, t)}</Txt> : null}
    <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
      {items.length === 0 ? <ProductSection title={t.xNoWatches} icon="watch" /> : null}
      {items.map(watch => <ProductSection key={watch.watcherId} title={isolate(watch.source.provider)} icon="watch">
        <Txt role="card">{watch.source.signalKind === 'readiness' ? t.xReadiness : watch.source.signalKind === 'fixture' ? t.xFootball : isolate(watch.source.signalKind)}</Txt>
        {watch.status === 'blocked' ? <AvailabilityBadge status={watch.blockedReason === 'provider_needs_reauth' ? 'NEEDS_REAUTH' : 'BLOCKED'} /> : <Txt role="label" color={p.ac}>{watch.enabled ? t.xActive : t.xPaused}</Txt>}
        <Txt role="supporting" color={p.mu}>{t[effectKeys[watch.effect]]} · {t.xBeta}</Txt>
        <Txt role="supporting">{t.xLastObserved}</Txt>
        <Txt role="supporting" color={p.mu}>{watch.lastObservedAt ? `${formatDate(new Date(watch.lastObservedAt), 'short', { locale: lang, timeZone: zone })} · ${formatTime(new Date(watch.lastObservedAt), { locale: lang, timeZone: zone })}` : t.xNotObserved}</Txt>
        <ProductActions>
          <Pill testID={`watch-toggle-${watch.watcherId}`} label={watch.enabled ? t.xPause : t.xResume} kind="outline" disabled={action.isPending} onPress={() => action.mutate({ id: watch.watcherId, action: watch.enabled ? 'pause' : 'resume' })} />
          <Pill testID={`watch-delete-${watch.watcherId}`} label={t.memoryDelete} kind="outline" disabled={action.isPending} onPress={() => setDeleting(watch.watcherId)} />
        </ProductActions>
        {watch.blockedReason === 'provider_needs_reauth' || watch.blockedReason === 'provider_disconnected' ? <Pill label={t.xIntegrations} kind="soft" onPress={() => actions.go('integrations')} /> : null}
      </ProductSection>)}
    </QueryBoundary>
    <Pill testID="background-create" label={t.xWatch} onPress={() => actions.go('watchBuilder')} />
    <ProductSection title={t.xExplore} icon="link">
      {[t.xFlight, t.xPackage, 'WHOOP', 'Notion', t.xLocation].map(title => <ProductRow key={title} title={title} status={cap.watcherBuilder} icon="watch" />)}
    </ProductSection>

  </ProductPage>;
}
export function WatchBuilderScreen() {
  const { t, p } = useApp();
  const [source, setSource] = useState<WatchSource>('flight');
  const [conditionIndex, setCondition] = useState(0);
  const [effect, setEffect] = useState<keyof typeof effectKeys>('notify');
  const options = watchSources[source];
  return <ProductPage id="watch" title={t.xWatch} subtitle={t.xWatchBody}>
    <PreviewNotice />
    <ProductSection title={`1 · ${t.xSource}`} body={t.xChooseSubject} icon="watch">
      <View style={{ gap: 8 }}>{(Object.keys(watchSources) as WatchSource[]).map(key => <Choice key={key} id={`watch-source-${key}`} title={t[watchSources[key].title]} checked={source === key} onPress={() => { setSource(key); setCondition(0); }} />)}</View>
    </ProductSection>
    <ProductSection title={`2 · ${t.xCondition}`} icon="watch">
      {options.conditions.map((key,index) => <Choice key={key} title={t[key]} checked={conditionIndex === index} onPress={() => setCondition(index)} />)}
    </ProductSection>
    <ProductSection title={`3 · ${t.xEffect}`} icon="spark">
      {(Object.keys(effectKeys) as (keyof typeof effectKeys)[]).map(key => <Choice key={key} title={t[effectKeys[key]]} checked={effect === key} onPress={() => setEffect(key)} />)}
    </ProductSection>
    <Card style={{ gap: 10 }} testID="watch-summary">
      <Txt role="card">{t[options.title]}</Txt><Txt role="supporting" color={p.mu}>{t[options.conditions[conditionIndex] ?? options.conditions[0]]}</Txt>
      <Txt role="supporting">{t[effectKeys[effect]]}</Txt><AvailabilityBadge status={cap.watcherBuilder} />
    </Card>
    <PreviewAction label={t.xCreateWatch} />
  </ProductPage>;
}
function Choice({ title, checked, onPress, id }: { title: string; checked: boolean; onPress: () => void; id?: string }) {
  const { p } = useApp();
  return <Btn testID={id} label={title} accessibilityRole="radio" accessibilityState={{ checked }} onPress={onPress}
    style={{ minHeight: 52, borderRadius: 18, borderWidth: checked ? 2 : 1, borderColor: checked ? p.ac : p.lnStrong, backgroundColor: checked ? p.acs : p.sf, padding: 14, alignItems: 'flex-start' }}>
    <Txt role="action" color={checked ? p.ac : p.tx}>{title}</Txt>
  </Btn>;
}
