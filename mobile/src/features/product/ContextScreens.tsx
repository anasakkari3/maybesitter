import React, { useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useConsents, useSetPersonalizationConsent, useCreateMemory, useMemory, useMemorySuggestion, useToday, useUpcoming } from '../../api/queries';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import { apiLocale } from '../../i18n/locale';
import { formatDate, formatTime } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { isolate } from '../../i18n/bidi';
import { fill } from '../../i18n/strings';
import { useLayoutMode } from '../../theme/textScale';
import { memorySentence } from '../memory/memoryDisplay';
import { durationText } from '../memory/memoryProvenance';
import { toViewModel } from '../commitments/model';
import { ServerToggle } from '../settings/ServerToggle';
import { Btn, Card, Pill, Txt, textAlignment } from '../../ui/primitives';
import { ProductPage, ProductSection, ProductRow, ProductActions, PreviewAction } from '../../ui/product';
import { capabilities as cap } from './capabilities';
import type { Commitment } from '../../api/schemas/common';

export function uniqueCommitments(items: readonly Commitment[]) {
  return [...new Map(items.map(item => [item.id, item])).values()];
}

export function PersonalizationScreen() {
  const { t, p, rtl, lang, actions } = useApp();
  const zone = useTimeZone();
  const consents = useConsents();
  const setConsent = useSetPersonalizationConsent();
  const memory = useMemory();
  const decide = useMemorySuggestion();
  const create = useCreateMemory();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const version = consents.data?.currentVersions.personalization;
  const suggestions = memory.data?.suggestions ?? [];
  const recent = [...(memory.data?.items ?? [])].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,3);
  return <ProductPage id="personalization" title={t.xPersonalization} subtitle={t.xMyBody}>
    <QueryBoundary isPending={consents.isPending} error={consents.error} onRetry={() => void consents.refetch()}>
    <Card pad={0}>
      <ServerToggle title={t.trustPersonalizationTitle} body={t.trustPersonalizationBody}
        testID="personalization-toggle" value={consents.data?.personalization?.state === 'granted'} disabled={!version}
        onChange={async next => {
          if (!version) return false;
          await setConsent.mutateAsync({ state: next ? 'granted' : 'declined', version, locale: apiLocale(lang), platform: Platform.OS === 'ios' ? 'ios' : 'android' });
          return true;
        }} />
    </Card>
    </QueryBoundary>
    <QueryBoundary isPending={memory.isPending} error={memory.error} onRetry={() => void memory.refetch()}>
      <ProductSection title={t.xLearned} body={t.memorySuggestionsLede} icon="person">
        {suggestions.length === 0 ? <Txt role="supporting" color={p.mu}>{t.xNoLearning}</Txt> : null}
        {decide.error ? <Txt role="supporting" color={p.wm}>{userFacingMessage(decide.error, t)}</Txt> : null}
        {suggestions.map(suggestion => <Card key={suggestion.fingerprint} style={{ gap: 12 }}>
          <Txt role="card">{isolate(suggestion.ruleId === 'R2_defer_default'
            ? fill(t.memorySuggestionDeferDefault, { duration: durationText(suggestion.deferMinutes, t as unknown as Record<string, string>) })
            : suggestion.ruleId === 'R3_plan_time'
              ? fill(t.memorySuggestionPlanTime, { time: suggestion.planTime })
              : fill(t.memorySuggestionFocusWindow, suggestion.window))}</Txt>
          <Txt role="supporting" color={p.mu}>{isolate(fill(t.memorySuggestionEvidence, { days: suggestion.evidence.lookbackDays, total: suggestion.evidence.totalCount, matching: suggestion.evidence.matchingCount }))}</Txt>
          {editing === suggestion.fingerprint ? <View style={{ gap: 12 }}>
            <Txt role="supporting" color={p.mu}>{t.xEditLearningBody}</Txt>
            <TextInput testID="personalization-edit-input" accessibilityLabel={t.memoryEdit} value={draft} onChangeText={setDraft} maxLength={200} multiline
              style={{ color: p.tx, backgroundColor: p.bg, padding: 14, minHeight: 60, borderRadius: 14, fontSize: 17, textAlign: textAlignment('start', rtl, Platform.OS) }} />
            {create.error ? <Txt color={p.wm}>{userFacingMessage(create.error, t)}</Txt> : null}
            <ProductActions><Pill label={t.memorySave} testID="personalization-edit-save" disabled={create.isPending || !draft.trim()} onPress={() => {
              create.mutate({ kind: 'preference', content: draft.trim(), language: lang }, { onSuccess: () => { setEditing(null); setDraft(''); actions.toast(t.xPreferenceSaved); } });
            }} /><Pill label={t.cancel} kind="outline" disabled={create.isPending} onPress={() => setEditing(null)} /></ProductActions>
          </View> : <ProductActions>
            <Pill label={t.memoryEdit} kind="outline" disabled={decide.isPending} onPress={() => {
              create.reset();
              setDraft(suggestion.ruleId === 'R2_defer_default'
                ? fill(t.memorySuggestionDeferDefault, { duration: durationText(suggestion.deferMinutes, t as unknown as Record<string, string>) })
                : suggestion.ruleId === 'R3_plan_time'
                  ? fill(t.memorySuggestionPlanTime, { time: suggestion.planTime })
                  : fill(t.memorySuggestionFocusWindow, suggestion.window));
              setEditing(suggestion.fingerprint);
            }} />
            <Pill label={t.memorySuggestionKeep} testID={`personalization-keep-${suggestion.fingerprint}`} disabled={decide.isPending} onPress={() => decide.mutate({ suggestion, decision: 'keep', language: lang })} />
            <Pill label={t.memorySuggestionDismiss} kind="outline" disabled={decide.isPending} onPress={() => decide.mutate({ suggestion, decision: 'dismiss', language: lang })} />
          </ProductActions>}
        </Card>)}
      </ProductSection>
      <ProductSection title={t.xUpdates} icon="watch">
        {recent.length === 0 ? <Txt role="supporting" color={p.mu}>{t.memoryScreenEmpty}</Txt> : null}
        {recent.map(item => <ProductRow key={item.id} title={isolate(memorySentence({ content: item.content, strings: t as unknown as Record<string,string> }))}
          body={formatDate(new Date(item.createdAt), 'short', { locale: lang, timeZone: zone })} icon="check" onPress={() => actions.go('memory')} />)}
        <Pill label={t.memoryEdit} kind="outline" onPress={() => actions.go('memory')} />
      </ProductSection>
    </QueryBoundary>
    <ProductRow title={t.xExport} body={t.xExportBody} icon="file" status={cap.export} />
    <ProductRow title={t.memoryDeleteAll} body={t.memoryDeleteAllAlso} icon="shield" onPress={() => actions.go('memory')} />
    <ProductRow title={t.sTrust} icon="shield" onPress={() => actions.go('trust')} />
  </ProductPage>;
}

export function CommitmentsScreen() {
  const { t, p, rtl, lang, actions } = useApp();
  const zone = useTimeZone();
  const today = useToday();
  const upcoming = useUpcoming();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all'|'active'|'done'>('active');
  const [reverse, setReverse] = useState(false);
  const stacked = useLayoutMode() !== 'normal';
  const items = uniqueCommitments([...(today.data?.items ?? []), ...(upcoming.data?.items ?? [])]);
  const views = items.map(item => toViewModel(item, new Date().toISOString())).filter(item => item.status !== 'dropped'
    && (filter === 'all' || item.status === filter) && item.title.toLocaleLowerCase(lang).includes(search.trim().toLocaleLowerCase(lang)))
    .sort((a,b) => (a.shownAt ?? '9999').localeCompare(b.shownAt ?? '9999') * (reverse ? -1 : 1));
  return <ProductPage id="commitments" title={t.xCommitments} subtitle={t.xCurrentHorizon}>
    <ProductActions><Pill label={t.tabCalendar} kind="outline" onPress={() => actions.go('calendar')} /><Pill label={t.xAdd} kind="soft" onPress={() => actions.go('addToMaybeSitter')} /></ProductActions>
    <TextInput testID="commitments-search" accessibilityLabel={t.xSearch} placeholder={t.xSearch} placeholderTextColor={p.mu}
      value={search} onChangeText={setSearch} style={{ backgroundColor: p.sf, borderColor: p.lnStrong, borderWidth: 1, borderRadius: 18, padding: 16, minHeight: 52, fontSize: 17, color: p.tx, textAlign: textAlignment('start', rtl, Platform.OS) }} />
    <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 8 }}>
      {(['all','active','done'] as const).map(key => <Btn key={key} label={key === 'all' ? t.xAll : key === 'active' ? t.xOpen : t.xDone} accessibilityRole="radio" accessibilityState={{ checked: filter === key }}
        onPress={() => setFilter(key)} style={{ backgroundColor: filter === key ? p.acs : p.sf, borderRadius: 16, padding: 14, minHeight: 48, flex: stacked ? undefined : 1, alignItems: 'center' }}>
        <Txt role="label" color={filter === key ? p.ac : p.tx}>{key === 'all' ? t.xAll : key === 'active' ? t.xOpen : t.xDone}</Txt>
      </Btn>)}
    </View>
    <Pill label={reverse ? t.xSortLatest : t.xSortEarliest} kind="outline" testID="commitments-sort" onPress={() => setReverse(value => !value)} />
    <QueryBoundary isPending={today.isPending || upcoming.isPending} error={today.error ?? upcoming.error} onRetry={() => { void today.refetch(); void upcoming.refetch(); }}>
      {views.length === 0 ? <ProductSection title={t.xNoResults} icon="check" /> : null}
      {views.map(item => <ProductRow key={item.id} id={`commitments-item-${item.id}`} title={isolate(item.title)} icon={item.status === 'done' ? 'check' : 'calendar'}
        body={[item.status === 'done' ? t.xDone : t.xOpen, item.shownAt ? `${formatDate(new Date(item.shownAt), 'short', { locale: lang, timeZone: zone })} · ${formatTime(new Date(item.shownAt), { locale: lang, timeZone: zone })}` : t.xUntimed].join(' · ')}
        onPress={() => actions.openDetail(item.id)} />)}
    </QueryBoundary>
  </ProductPage>;
}

export function ContextualAssistantScreen() {
  const { t, actions, lang } = useApp();
  const zone = useTimeZone();
  const today = useToday();
  const upcoming = useUpcoming();
  const items = uniqueCommitments([...(today.data?.items ?? []), ...(upcoming.data?.items ?? [])]);
  // A deadline is not an appointment. Present its recorded time without an
  // invented meeting classification, briefing, or countdown.
  const item = items.map(record => toViewModel(record, new Date().toISOString())).filter(record => record.status === 'active')
    .sort((a,b) => (a.shownAt ?? '9999').localeCompare(b.shownAt ?? '9999'))[0];
  return <ProductPage id="assistant" title={t.xAssistant} subtitle={t.xAssistantBody}>
    <QueryBoundary isPending={today.isPending || upcoming.isPending} error={today.error ?? upcoming.error} onRetry={() => { void today.refetch(); void upcoming.refetch(); }}>
      <ProductSection title={item ? isolate(item.title) : t.xNoContext} body={item?.shownAt ? `${formatDate(new Date(item.shownAt), 'short', { locale: lang, timeZone: zone })} · ${formatTime(new Date(item.shownAt), { locale: lang, timeZone: zone })}` : undefined} icon="calendar">
        {item ? <Pill label={t.xOpenCommitment} testID="assistant-detail" onPress={() => actions.openDetail(item.id)} /> : <Pill label={t.xQuick} onPress={() => actions.go('capture')} />}
      </ProductSection>
    </QueryBoundary>
    <ProductActions><Pill label={t.xAgenda} kind="outline" onPress={() => actions.go('calendar')} /><Pill label={t.xAdd} kind="outline" onPress={() => actions.go('addToMaybeSitter')} /></ProductActions>
    <ProductSection title={t.xPrepare} body={t.xPrepareBody} icon="spark" status={cap.assistantPreparation}><PreviewAction label={t.xPrepare} /></ProductSection>
    <ProductRow id="assistant-modes" title={t.xModes} body={t.xModesBody} onPress={() => actions.go('actionModes')} />
    <ProductRow title={t.xGoals} icon="goal" status={cap.goals} onPress={() => actions.go('goalExecution')} />
    <ProductRow title={t.xWatch} icon="watch" status={cap.watcherBuilder} onPress={() => actions.go('watchBuilder')} />
  </ProductPage>;
}
