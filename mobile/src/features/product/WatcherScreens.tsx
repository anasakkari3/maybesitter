import React, { useState } from 'react';
import { useApp } from '../../state/AppContext';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import { useTimeZone } from '../../i18n/timezone';
import { formatDate, formatTime } from '../../i18n/format';
import { isolate } from '../../i18n/bidi';
import { Btn, Card, Pill, Txt } from '../../ui/primitives';
import { Dialog } from '../../ui/dialog';
import { ProductPage, ProductSection, ProductActions, ProductRow, AvailabilityBadge } from '../../ui/product';
import { ServerToggle } from '../settings/ServerToggle';
import { useBackgroundActivity, useBackgroundAttribution, useCreateReadinessWatcher, useSetBackgroundActivityPaused, useWatcherAction } from './useWatchers';
const effectKeys = { notify: 'xNotify', replan_if_impacted: 'xReplan', propose_commitment: 'xPropose', update_context: 'xContext' } as const;
export function BackgroundActivityScreen() {
  const { t, p, lang, actions } = useApp();
  const zone = useTimeZone();
  const query = useBackgroundActivity();
  const attribution = useBackgroundAttribution();
  const action = useWatcherAction();
  const setMonitoring = useSetBackgroundActivityPaused();
  const [deleting, setDeleting] = useState<string | null>(null);
  const items = query.data?.monitors ?? [];
  const monitorTitle = (label: string) => label === 'maybesitter:readiness' ? t.xReadiness : isolate(label.replace(':', ' · '));
  const statusOf = (status: (typeof items)[number]['status']) => status === 'needs_reauth' ? 'NEEDS_REAUTH' as const
    : status === 'blocked_permission' || status === 'error' ? 'BLOCKED' as const
    : status === 'active' ? 'LIVE' as const : null;
  const instant = (value: string | null) => value
    ? `${formatDate(new Date(value), 'short', { locale: lang, timeZone: zone })} · ${formatTime(new Date(value), { locale: lang, timeZone: zone })}`
    : t.xNotObserved;
  return <ProductPage id="background" title={t.xBackground} subtitle={t.xBackgroundBody} overlay={deleting ? <Dialog title={t.xRemoveWatch} body={t.xRemoveWatchBody} confirmLabel={t.memoryDelete} cancelLabel={t.cancel}
      onCancel={() => setDeleting(null)} onConfirm={() => { action.mutate({ id: deleting, action: 'delete' }); setDeleting(null); }} /> : null}>
    <ProductSection title={t.xBackground} body={t.xBackgroundBody} icon="shield">
      <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
        <ServerToggle title={t.xPause} body={t.xWatchLimits} testID="monitoring-pause" value={query.data?.paused ?? false} disabled={query.data === undefined} onChange={async paused => {
          await setMonitoring.mutateAsync(paused);
          return true;
        }} />
      </QueryBoundary>
    </ProductSection>
    {action.error ? <Txt color={p.wm}>{userFacingMessage(action.error, t)}</Txt> : null}
    <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
      {items.length === 0 ? <ProductSection title={t.xNoWatches} icon="watch" /> : null}
      {items.map(monitor => <ProductSection key={monitor.monitorId} title={monitorTitle(monitor.label)} icon="watch">
        {statusOf(monitor.status) ? <AvailabilityBadge status={statusOf(monitor.status)!} /> : <Txt role="label" color={p.wm}>{t.xPaused}</Txt>}
        <Txt role="supporting" color={p.mu}>{monitor.effects.map(effect => t[effectKeys[effect as keyof typeof effectKeys]] ?? isolate(effect)).join(' · ')}</Txt>
        <ProductRow title={t.xLastChecked} body={instant(monitor.lastCheckedAt)} icon="watch" />
        <ProductRow title={t.xNextCheck} body={instant(monitor.nextCheckAt)} icon="calendar" />
        <ProductRow title={t.xLastChanged} body={instant(monitor.lastChangedAt)} icon="spark" />
        <ProductActions>
          {monitor.watcherId && (monitor.canPause || monitor.status === 'paused') ? <Pill testID={`watch-toggle-${monitor.watcherId}`} label={monitor.canPause ? t.xPause : t.xResume} kind="outline" disabled={action.isPending} onPress={() => action.mutate({ id: monitor.watcherId!, action: monitor.canPause ? 'pause' : 'resume' })} /> : null}
          {monitor.watcherId && monitor.canDelete ? <Pill testID={`watch-delete-${monitor.watcherId}`} label={t.memoryDelete} kind="outline" disabled={action.isPending} onPress={() => setDeleting(monitor.watcherId)} /> : null}
        </ProductActions>
        {monitor.status === 'needs_reauth' || monitor.status === 'blocked_permission' ? <Pill label={t.xIntegrations} kind="soft" onPress={() => actions.go('integrations')} /> : null}
      </ProductSection>)}
    </QueryBoundary>
    <ProductSection title={t.xRecentBackgroundActions} icon="watch">
      <QueryBoundary isPending={attribution.isPending} error={attribution.error} onRetry={() => void attribution.refetch()}>
        {attribution.data?.actions.length === 0 ? <Txt role="supporting" color={p.mu}>{t.xNoBackgroundActions}</Txt> : null}
        {attribution.data?.actions.map(event => <Card key={event.actionId} style={{ gap: 6 }}>
          <Txt role="card">{monitorTitle(event.label)}</Txt>
          <Txt role="supporting" color={p.mu}>{instant(event.occurredAt)}</Txt>
          <Txt role="supporting">{`${isolate(event.condition)} → ${isolate(event.policyDecision)} → ${t[effectKeys[event.effect as keyof typeof effectKeys]] ?? isolate(event.effect)}`}</Txt>
        </Card>)}
        {attribution.data ? <Txt role="supporting" color={attribution.data.orphanCount === 0 ? p.success : p.wm} testID="background-integrity">
          {attribution.data.orphanCount === 0 ? t.xBackgroundIntegrityOk : t.xBackgroundIntegrityWarning.replace('{count}', String(attribution.data.orphanCount))}
        </Txt> : null}
      </QueryBoundary>
    </ProductSection>
    <Pill testID="background-create" label={t.xWatch} onPress={() => actions.go('watchBuilder')} />
    <ProductSection title={t.xExplore} icon="link">
      {[t.xFlight, t.xPackage, 'WHOOP', 'Notion', t.xLocation].map(title => <ProductRow key={title} title={title} status="COMING_SOON" icon="watch" />)}
    </ProductSection>

  </ProductPage>;
}
export function WatchBuilderScreen() {
  const { t, p, actions } = useApp();
  const [effect, setEffect] = useState<keyof typeof effectKeys>('notify');
  const create = useCreateReadinessWatcher();
  return <ProductPage id="watch" title={t.xWatch} subtitle={t.xWatchBody}>
    <ProductSection title={`1 · ${t.xSource}`} body={t.xChooseSubject} icon="watch">
      <Choice id="watch-source-readiness" title={t.xReadiness} checked onPress={() => undefined} />
      <ProductRow title={t.xFlight} status="COMING_SOON" icon="watch" />
      <ProductRow title={t.xPackage} status="COMING_SOON" icon="watch" />
      <ProductRow title={t.xFootball} status="COMING_SOON" icon="watch" />
    </ProductSection>
    <ProductSection title={`2 · ${t.xCondition}`} icon="watch">
      <Choice title={t.xEnergyChange} checked onPress={() => undefined} />
    </ProductSection>
    <ProductSection title={`3 · ${t.xEffect}`} icon="spark">
      {(Object.keys(effectKeys) as (keyof typeof effectKeys)[]).map(key => <Choice key={key} title={t[effectKeys[key]]} checked={effect === key} onPress={() => setEffect(key)} />)}
    </ProductSection>
    <Card style={{ gap: 10 }} testID="watch-summary">
      <Txt role="card">{t.xReadiness}</Txt><Txt role="supporting" color={p.mu}>{t.xEnergyChange}</Txt>
      <Txt role="supporting">{t[effectKeys[effect]]}</Txt><AvailabilityBadge status="LIVE" />
    </Card>
    {create.error ? <Txt color={p.wm}>{userFacingMessage(create.error, t)}</Txt> : null}
    <Pill testID="watch-create" label={t.xCreateWatch} disabled={create.isPending} onPress={() => create.mutate(effect, { onSuccess: () => actions.go('backgroundActivity') })} />
  </ProductPage>;
}
function Choice({ title, checked, onPress, id }: { title: string; checked: boolean; onPress: () => void; id?: string }) {
  const { p } = useApp();
  return <Btn testID={id} label={title} accessibilityRole="radio" accessibilityState={{ checked }} onPress={onPress}
    style={{ minHeight: 52, borderRadius: 18, borderWidth: checked ? 2 : 1, borderColor: checked ? p.ac : p.lnStrong, backgroundColor: checked ? p.acs : p.sf, padding: 14, alignItems: 'flex-start' }}>
    <Txt role="action" color={checked ? p.ac : p.tx}>{title}</Txt>
  </Btn>;
}
