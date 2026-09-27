import React, { useRef, useState } from 'react';
import { TextInput } from 'react-native';
import { useApp } from '../../state/AppContext';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import { useTimeZone } from '../../i18n/timezone';
import { formatDate, formatTime } from '../../i18n/format';
import { isolate } from '../../i18n/bidi';
import { fill } from '../../i18n/strings';
import { useFootballSettings } from '../../api/queries';
import type { FootballClub } from '../../api/schemas/football';
import { Btn, Card, Pill, Txt } from '../../ui/primitives';
import { Dialog } from '../../ui/dialog';
import { ProductPage, ProductSection, ProductActions, ProductRow, AvailabilityBadge } from '../../ui/product';
import { ServerToggle } from '../settings/ServerToggle';
import { useBackgroundActivity, useBackgroundAttribution, useCreateFootballWatcher, useCreateReadinessWatcher, useSetBackgroundActivityPaused, useWatcherAction } from './useWatchers';
const effectKeys = { notify: 'xNotify', replan_if_impacted: 'xReplan', propose_commitment: 'xPropose', update_context: 'xContext' } as const;
type Effect = keyof typeof effectKeys;
/** A followed club reconsiders the plan or tells you; nothing else has a reader (closure CL7). */
const footballEffects: readonly Effect[] = ['replan_if_impacted', 'notify'];
/** `provider:signalKind` of a followed-club watcher, as the monitor projection labels it. */
const FOOTBALL_LABEL = 'football_data:football_team';
export function BackgroundActivityScreen() {
  const { t, p, lang, actions } = useApp();
  const zone = useTimeZone();
  const query = useBackgroundActivity();
  const attribution = useBackgroundAttribution();
  const action = useWatcherAction();
  const setMonitoring = useSetBackgroundActivityPaused();
  const [deleting, setDeleting] = useState<{ id: string; team: string | null } | null>(null);
  const items = query.data?.monitors ?? [];
  const monitorTitle = (label: string, title: string | null = null) => label === 'maybesitter:readiness' ? t.xReadiness
    : label === FOOTBALL_LABEL ? (title ? `${t.xFootball} · ${isolate(title)}` : t.xFootball)
    : isolate(label.replace(':', ' · '));
  const statusOf = (status: (typeof items)[number]['status']) => status === 'needs_reauth' ? 'NEEDS_REAUTH' as const
    : status === 'blocked_permission' || status === 'error' ? 'BLOCKED' as const
    : status === 'active' ? 'LIVE' as const : null;
  const instant = (value: string | null) => value
    ? `${formatDate(new Date(value), 'short', { locale: lang, timeZone: zone })} · ${formatTime(new Date(value), { locale: lang, timeZone: zone })}`
    : t.xNotObserved;
  // Deleting a followed club's watcher is "Stop following": it says so, and
  // says the matches ahead come off the calendar (closure CL7).
  const dialog = deleting === null ? null : deleting.team === null
    ? { title: t.xRemoveWatch, body: t.xRemoveWatchBody, confirm: t.memoryDelete }
    : { title: fill(t.xStopFollowingTitle, { team: isolate(deleting.team) }), body: t.xStopFollowingBody, confirm: t.xStopFollowing };
  return <ProductPage id="background" title={t.xBackground} subtitle={t.xBackgroundBody} overlay={deleting && dialog ? <Dialog title={dialog.title} body={dialog.body} confirmLabel={dialog.confirm} cancelLabel={t.cancel}
      onCancel={() => setDeleting(null)} onConfirm={() => { action.mutate({ id: deleting.id, action: 'delete' }); setDeleting(null); }} /> : null}>
    <ProductSection title={t.xBackground} icon="shield">
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
      {items.map(monitor => <ProductSection key={monitor.monitorId} title={monitorTitle(monitor.label, monitor.title)} icon="watch">
        {monitor.status === 'retrying'
          // Never silence: a provider that is down or out of quota is said in
          // words, and the next try is already scheduled.
          ? <Txt role="label" color={p.wm} testID={`watch-retrying-${monitor.watcherId ?? monitor.monitorId}`}>{t.xFootballRetrying}</Txt>
          : statusOf(monitor.status) ? <AvailabilityBadge status={statusOf(monitor.status)!} /> : <Txt role="label" color={p.wm}>{t.xPaused}</Txt>}
        <Txt role="supporting" color={p.mu}>{monitor.effects.map(effect => t[effectKeys[effect as keyof typeof effectKeys]] ?? isolate(effect)).join(' · ')}</Txt>
        <ProductRow title={t.xLastChecked} body={instant(monitor.lastCheckedAt)} icon="watch" />
        <ProductRow title={t.xNextCheck} body={instant(monitor.nextCheckAt)} icon="calendar" />
        <ProductRow title={t.xLastChanged} body={instant(monitor.lastChangedAt)} icon="spark" />
        <ProductActions>
          {monitor.watcherId && (monitor.canPause || monitor.status === 'paused') ? <Pill testID={`watch-toggle-${monitor.watcherId}`} label={monitor.canPause ? t.xPause : t.xResume} kind="outline" disabled={action.isPending} onPress={() => action.mutate({ id: monitor.watcherId!, action: monitor.canPause ? 'pause' : 'resume' })} /> : null}
          {monitor.watcherId && monitor.canDelete ? <Pill testID={`watch-delete-${monitor.watcherId}`} label={monitor.label === FOOTBALL_LABEL ? t.xStopFollowing : t.memoryDelete} kind="outline" disabled={action.isPending}
            onPress={() => setDeleting({ id: monitor.watcherId!, team: monitor.label === FOOTBALL_LABEL ? monitor.title ?? t.xFootball : null })} /> : null}
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
    {/* Flights and parcels are not offered anywhere until the owner approves a
        provider and its price (council ruling, closure CL7). */}
    <ProductSection title={t.xExplore} icon="link">
      {['WHOOP', 'Notion', t.xLocation].map(title => <ProductRow key={title} title={title} status="COMING_SOON" icon="watch" />)}
    </ProductSection>

  </ProductPage>;
}
export function WatchBuilderScreen() {
  const { t, p, rtl, lang, actions } = useApp();
  const [source, setSource] = useState<'readiness' | 'football'>('readiness');
  const [effect, setEffect] = useState<Effect>('notify');
  const [search, setSearch] = useState('');
  const [clubId, setClubId] = useState<string | null>(null);
  const create = useCreateReadinessWatcher();
  const follow = useCreateFootballWatcher();
  // Football is offered only when the server holds the match data key: a
  // follow that could never fill would be a promise the app cannot keep, and
  // "coming soon" is not an answer (closure CL7).
  const football = useFootballSettings();
  const footballAvailable = football.data?.providerConfigured === true;
  const clubs = football.data?.clubs ?? [];
  const club: FootballClub | null = clubs.find(candidate => candidate.clubId === clubId) ?? null;
  const needle = search.trim().toLocaleLowerCase(lang);
  const matching = needle.length === 0 ? clubs : clubs.filter(candidate =>
    [candidate.names.ar, candidate.names.he, candidate.names.en, candidate.clubId].some(name => name.toLocaleLowerCase(lang).includes(needle)));
  const isFootball = source === 'football' && footballAvailable;
  const effects = isFootball ? footballEffects : (Object.keys(effectKeys) as Effect[]);
  const pending = isFootball ? follow.isPending : create.isPending;
  const error = isFootball ? follow.error : create.error;
  // One create in flight, however fast the taps come. `disabled` only takes
  // effect on the next render, and two taps inside that frame each made a
  // watcher; this is checked synchronously, before the request goes out.
  const creating = useRef(false);
  const pick = (next: 'readiness' | 'football') => {
    setSource(next);
    setEffect(next === 'football' ? 'replan_if_impacted' : 'notify');
  };
  const submit = () => {
    if (creating.current) return;
    if (isFootball && !club) return;
    creating.current = true;
    // The finished builder hands its place to Background activity (L6).
    const settled = { onSuccess: () => actions.replace('backgroundActivity'), onSettled: () => { creating.current = false; } };
    if (isFootball && club) follow.mutate({ clubId: club.clubId, effect, label: club.names[lang] }, settled);
    else create.mutate(effect, settled);
  };
  let step = 0;
  const numbered = (title: string) => `${++step} · ${title}`;
  return <ProductPage id="watch" title={t.xWatch} subtitle={t.xWatchBody}>
    <ProductSection title={numbered(t.xSource)} icon="watch">
      <Choice id="watch-source-readiness" title={t.xReadiness} checked={!isFootball} onPress={() => pick('readiness')} />
      {footballAvailable ? <Choice id="watch-source-football" title={t.xFootball} checked={isFootball} onPress={() => pick('football')} /> : null}
    </ProductSection>
    {isFootball ? <ProductSection title={numbered(t.xTeam)} icon="goal">
      <TextInput testID="watch-team-search" accessibilityLabel={t.xTeamSearch} placeholder={t.xTeamSearch} placeholderTextColor={p.mu}
        value={search} onChangeText={setSearch} autoCorrect={false}
        style={{ backgroundColor: p.sf, borderColor: p.lnStrong, borderWidth: 1, borderRadius: 18, padding: 16, minHeight: 52, fontSize: 17, color: p.tx, textAlign: rtl ? 'right' : 'left', writingDirection: rtl ? 'rtl' : 'ltr' }} />
      {matching.length === 0 ? <Txt role="supporting" color={p.mu} testID="watch-team-none">{t.xTeamNoResults}</Txt> : null}
      {matching.map(candidate => <Choice key={candidate.clubId} id={`watch-team-${candidate.clubId}`} title={candidate.names[lang]}
        checked={candidate.clubId === clubId} onPress={() => setClubId(candidate.clubId)} />)}
    </ProductSection> : null}
    <ProductSection title={numbered(t.xCondition)} icon="watch">
      <Choice title={isFootball ? t.xKickoff : t.xEnergyChange} checked onPress={() => undefined} />
    </ProductSection>
    <ProductSection title={numbered(t.xEffect)} icon="spark">
      {effects.map(key => <Choice key={key} id={`watch-effect-${key}`} title={t[effectKeys[key]]} checked={effect === key} onPress={() => setEffect(key)} />)}
    </ProductSection>
    <Card style={{ gap: 10 }} testID="watch-summary">
      {isFootball
        ? <>
          <Txt role="card">{club ? isolate(club.names[lang]) : t.xTeam}</Txt>
          {club ? <Txt role="supporting" color={p.mu}>{fill(t.xFollowTeamSummary, { team: isolate(club.names[lang]) })}</Txt> : null}
          <Txt role="supporting">{t[effectKeys[effect]]}</Txt>
          <Txt role="supporting" color={p.mu}>{t.suggestionNote}</Txt>
        </>
        : <>
          <Txt role="card">{t.xReadiness}</Txt><Txt role="supporting" color={p.mu}>{t.xEnergyChange}</Txt>
          <Txt role="supporting">{t[effectKeys[effect]]}</Txt><AvailabilityBadge status="LIVE" />
        </>}
    </Card>
    {error ? <Txt color={p.wm}>{userFacingMessage(error, t)}</Txt> : null}
    <Pill testID="watch-create" label={isFootball ? t.xFollowTeam : t.xCreateWatch} disabled={pending || (isFootball && !club)} onPress={submit} />
  </ProductPage>;
}
function Choice({ title, checked, onPress, id }: { title: string; checked: boolean; onPress: () => void; id?: string }) {
  const { p } = useApp();
  return <Btn testID={id} label={title} accessibilityRole="radio" accessibilityState={{ checked }} onPress={onPress}
    style={{ minHeight: 52, borderRadius: 18, borderWidth: checked ? 2 : 1, borderColor: checked ? p.ac : p.lnStrong, backgroundColor: checked ? p.acs : p.sf, padding: 14, alignItems: 'flex-start' }}>
    <Txt role="action" color={checked ? p.ac : p.tx}>{title}</Txt>
  </Btn>;
}
