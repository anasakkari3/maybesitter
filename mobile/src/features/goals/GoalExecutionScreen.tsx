import React from 'react';
import { TextInput, View } from 'react-native';
import {
  useCommitment,
  useConfirmGoalSelections,
  useCreateMemory,
  useGenerateGoalExecution,
  useGoalExecution,
  useHabits,
  useMemory,
  useRegenerateGoalExecution,
  useUnlinkGoalNode,
} from '../../api/queries';
import type { GoalConfirmationSelection } from '../../api/endpoints/goals';
import type { GoalGraph } from '../../api/schemas/goals';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import { isolate } from '../../i18n/bidi';
import { formatNumber } from '../../i18n/format';
import { fill } from '../../i18n/strings';
import { useTimeZone } from '../../i18n/timezone';
import { useApp } from '../../state/AppContext';
import { Card, Pill, Txt } from '../../ui/primitives';
import { ProductActions, ProductPage, ProductRow, ProductSection } from '../../ui/product';
import { currentGoalProgressPeriod } from './progressPeriod';

type ProposalNode = Extract<GoalGraph['nodes'][number], { kind: 'milestone_proposal' | 'decomposition_step_proposal' }>;
type LinkedNode = Extract<GoalGraph['nodes'][number], { kind: 'linked_commitment' | 'linked_habit' }>;
type DraftSelection = { as: 'commitment' } | { as: 'habit'; count: number; durationMinutes: number };
type Notice = 'saved' | 'partial' | 'stale' | 'refused' | 'unlinked' | null;

export function GoalExecutionScreen() {
  const { t, p, rtl, lang, actions } = useApp();
  const memory = useMemory();
  const create = useCreateMemory();
  const [draft, setDraft] = React.useState('');
  const [openGoal, setOpenGoal] = React.useState<{ id: string; title: string } | null>(null);
  const goals = memory.data?.items.filter(item => item.kind === 'goal') ?? [];

  return <ProductPage id="goals" title={t.xGoals} {...(openGoal ? {} : { subtitle: t.xGoalBody })}>
    {openGoal ? <GoalDetail goalId={openGoal.id} title={openGoal.title} onBack={() => setOpenGoal(null)} /> : <>
      <ProductSection title={t.xAddGoal} body={t.xAddGoalBody} icon="goal">
        <TextInput
          testID="goal-add-input"
          accessibilityLabel={t.xAddGoal}
          value={draft}
          onChangeText={setDraft}
          placeholder={t.xGoalPlaceholder}
          placeholderTextColor={p.mu}
          maxLength={200}
          multiline
          style={{ color: p.tx, backgroundColor: p.bg, padding: 14, minHeight: 60, borderRadius: 14, fontSize: 17, textAlign: rtl ? 'right' : 'left' }}
        />
        {create.error ? <Txt role="supporting" color={p.wm}>{userFacingMessage(create.error, t)}</Txt> : null}
        <Pill testID="goal-add-save" label={t.memorySave} disabled={create.isPending || !draft.trim()} onPress={() => {
          create.mutate({ kind: 'goal', content: draft.trim(), language: lang }, { onSuccess: () => setDraft('') });
        }} />
      </ProductSection>
      <QueryBoundary isPending={memory.isPending} error={memory.error} onRetry={() => void memory.refetch()}>
        <ProductSection title={t.xGoalSaved} body={goals.length === 0 ? t.xNoGoals : undefined} icon="goal">
          {goals.map(goal => <ProductRow
            key={goal.id}
            id={`goal-open-${goal.id}`}
            title={isolate(goal.content)}
            body={t.xGoalOpen}
            icon="goal"
            onPress={() => setOpenGoal({ id: goal.id, title: goal.content })}
          />)}
          <Pill label={t.memoryScreenTitle} kind="outline" onPress={() => actions.go('knows')} />
        </ProductSection>
      </QueryBoundary>
      <Pill label={t.xLinkedHabits} kind="outline" onPress={() => actions.go('habitDetail')} />
    </>}
  </ProductPage>;
}

function GoalDetail({ goalId, title, onBack }: { goalId: string; title: string; onBack: () => void }) {
  const { t, p, lang } = useApp();
  const zone = useTimeZone();
  const period = React.useMemo(() => currentGoalProgressPeriod(new Date(), zone, lang), [lang, zone]);
  const [generation, setGeneration] = React.useState(1);
  const [proposalGraph, setProposalGraph] = React.useState<GoalGraph | null>(null);
  const [selections, setSelections] = React.useState<Record<string, DraftSelection>>({});
  const [notice, setNotice] = React.useState<Notice>(null);
  const [unlinking, setUnlinking] = React.useState<string | null>(null);
  const query = useGoalExecution(goalId, generation, period);
  const generate = useGenerateGoalExecution(goalId);
  const regenerate = useRegenerateGoalExecution(goalId);
  const confirm = useConfirmGoalSelections(goalId);
  const unlink = useUnlinkGoalNode(goalId);
  const canonicalGraph = query.data?.graph;
  const linked = canonicalGraph?.nodes.filter((node): node is LinkedNode => node.kind === 'linked_commitment' || node.kind === 'linked_habit') ?? [];
  const habits = useHabits(linked.some(node => node.kind === 'linked_habit'));
  const progress = query.data?.progress;
  const reviewGraph = proposalGraph;
  const proposals = reviewGraph?.nodes.filter((node): node is ProposalNode => node.kind === 'milestone_proposal' || node.kind === 'decomposition_step_proposal') ?? [];
  const checkpoints = reviewGraph?.nodes.filter(node => node.kind === 'checkpoint') ?? [];

  const beginReview = (graph: GoalGraph) => {
    setGeneration(graph.generation);
    setProposalGraph(graph);
    setSelections({});
    setNotice(null);
  };
  const toggle = (nodeId: string) => setSelections(current => {
    if (current[nodeId]) {
      const next = { ...current };
      delete next[nodeId];
      return next;
    }
    return { ...current, [nodeId]: { as: 'commitment' } };
  });
  const chooseKind = (nodeId: string, as: 'commitment' | 'habit') => setSelections(current => ({
    ...current,
    [nodeId]: as === 'commitment' ? { as } : { as, count: 3, durationMinutes: 30 },
  }));
  const updateHabit = (nodeId: string, update: Partial<Extract<DraftSelection, { as: 'habit' }>>) => setSelections(current => {
    const value = current[nodeId];
    if (!value || value.as !== 'habit') return current;
    return { ...current, [nodeId]: { ...value, ...update } };
  });
  const confirmationSelections: GoalConfirmationSelection[] = Object.entries(selections).map(([nodeId, value]) => value.as === 'commitment'
    ? { nodeId, as: 'commitment' }
    : {
      nodeId,
      as: 'habit',
      habit: {
        cadence: { kind: 'weekly_count', count: value.count },
        durationMinutes: value.durationMinutes,
        preferredWindows: [],
        minimumOccurrences: value.count,
        maximumOccurrences: value.count,
        flexibility: 'flexible',
        recoveryPolicy: 'skip',
      },
    });

  return <View style={{ gap: 16 }}>
    <Pill testID="goal-back-list" label={t.xGoalBackToGoals} kind="ghost" onPress={onBack} />
    <Card style={{ gap: 8 }}><Txt role="section">{isolate(title)}</Txt></Card>
    <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
      {query.data ? <>
        {notice ? <NoticeCard notice={notice} /> : null}
        <ProductSection title={t.xGoalProgress} body={progress?.period
          ? fill(t.xGoalProgressCount, {
            completed: formatNumber(progress.completedCount, { locale: lang }),
            confirmed: formatNumber(progress.confirmedCount, { locale: lang }),
          })
          : t.xGoalProgressUnscoped} icon="check">
          <ProductActions>
            <Pill testID="goal-refresh" label={query.isFetching ? t.xGoalRefreshing : t.xGoalRefresh} kind="outline" disabled={query.isFetching} onPress={() => void query.refetch()} />
          </ProductActions>
        </ProductSection>

        {linked.length > 0 ? <ProductSection title={t.xGoalCanonicalWork} body={t.xGoalCanonicalWorkBody} icon="link">
          {linked.map(node => <LinkedWorkRow
            key={node.nodeId}
            node={node}
            progress={progress?.nodes.find(entry => entry.entityId === (node.kind === 'linked_commitment' ? node.commitmentId : node.habitId))}
            habit={node.kind === 'linked_habit' ? habits.data?.find(item => item.habitId === node.habitId) : undefined}
            habitPending={node.kind === 'linked_habit' && habits.isPending}
            unlinking={unlinking === node.nodeId}
            busy={unlink.isPending}
            onAskUnlink={() => setUnlinking(node.nodeId)}
            onCancelUnlink={() => setUnlinking(null)}
            onUnlink={() => unlink.mutate(node.nodeId, { onSuccess: () => {
              setUnlinking(null);
              setNotice('unlinked');
              void query.refetch();
            } })}
          />)}
        </ProductSection> : null}

        {!reviewGraph ? <ProductSection title={linked.length === 0 ? t.xGoalPlanEmpty : t.xGoalRegenerate} body={linked.length === 0 ? t.xGoalPlanEmptyBody : t.xGoalRegenerateBody} icon="spark">
          <Pill
            testID={linked.length === 0 ? 'goal-generate' : 'goal-regenerate'}
            label={linked.length === 0 ? t.xGoalGenerate : t.xGoalRegenerate}
            disabled={generate.isPending || regenerate.isPending}
            onPress={() => linked.length === 0
              ? generate.mutate(undefined, { onSuccess: beginReview })
              : regenerate.mutate(canonicalGraph?.generation ?? generation, { onSuccess: beginReview })}
          />
          {generate.error || regenerate.error ? <Txt role="supporting" color={p.wm}>{userFacingMessage(generate.error ?? regenerate.error, t)}</Txt> : null}
        </ProductSection> : <ProposalReview
          graph={reviewGraph}
          proposals={proposals}
          checkpoints={checkpoints}
          selections={selections}
          busy={confirm.isPending}
          error={confirm.error}
          onToggle={toggle}
          onChooseKind={chooseKind}
          onUpdateHabit={updateHabit}
          onCancel={() => { setProposalGraph(null); setSelections({}); setNotice(null); }}
          onConfirm={() => confirm.mutate({ generation: reviewGraph.generation, selections: confirmationSelections }, { onSuccess: result => {
            const stale = result.refused.some(item => item.code === 'unknown_node');
            setSelections({});
            setGeneration(result.graph.generation);
            void query.refetch();
            if (stale) {
              setProposalGraph(result.graph);
              setNotice('stale');
            } else if (result.refused.length > 0 && result.created.length + result.replayed.length > 0) {
              setProposalGraph(result.graph);
              setNotice('partial');
            } else if (result.refused.length > 0) {
              setProposalGraph(result.graph);
              setNotice('refused');
            } else {
              setProposalGraph(null);
              setNotice('saved');
            }
          } })}
        />}
        {unlink.error ? <Txt role="supporting" color={p.wm}>{userFacingMessage(unlink.error, t)}</Txt> : null}
      </> : null}
    </QueryBoundary>
  </View>;
}

function NoticeCard({ notice }: { notice: Exclude<Notice, null> }) {
  const { t, p } = useApp();
  const copy = notice === 'saved' ? t.xGoalConfirmSuccess
    : notice === 'partial' ? t.xGoalConfirmPartial
      : notice === 'stale' ? t.xGoalStale
        : notice === 'unlinked' ? t.xGoalUnlinkDone
          : t.xGoalConfirmRefused;
  return <Card testID={`goal-notice-${notice}`} style={{ gap: 6 }}><Txt role="supporting" color={notice === 'saved' || notice === 'unlinked' ? p.success : p.wm}>{copy}</Txt></Card>;
}

function ProposalReview({ graph, proposals, checkpoints, selections, busy, error, onToggle, onChooseKind, onUpdateHabit, onCancel, onConfirm }: {
  graph: GoalGraph;
  proposals: readonly ProposalNode[];
  checkpoints: readonly Extract<GoalGraph['nodes'][number], { kind: 'checkpoint' }>[];
  selections: Record<string, DraftSelection>;
  busy: boolean;
  error: unknown;
  onToggle: (nodeId: string) => void;
  onChooseKind: (nodeId: string, as: 'commitment' | 'habit') => void;
  onUpdateHabit: (nodeId: string, update: Partial<Extract<DraftSelection, { as: 'habit' }>>) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t, p, lang } = useApp();
  return <ProductSection title={t.xGoalProposalTitle} body={t.xGoalProposalNotSaved} icon="spark">
    {proposals.length === 0 ? <Txt role="supporting" color={p.mu}>{t.xGoalProposalEmpty}</Txt> : proposals.map(node => {
      const selected = selections[node.nodeId];
      return <Card key={node.nodeId} style={{ gap: 10 }}>
        <ProductRow
          id={`goal-proposal-${node.nodeId}`}
          title={isolate(node.title)}
          body={[
            selected ? t.xGoalSelected : t.xGoalSelectStep,
            node.statedTiming ? `${t.xGoalStatedTiming}: ${isolate(node.statedTiming)}` : null,
          ].filter(Boolean).join(' · ')}
          icon={node.kind === 'milestone_proposal' ? 'goal' : 'check'}
          onPress={() => onToggle(node.nodeId)}
        />
        {selected ? <>
          <ProductActions>
            <Pill testID={`goal-kind-commitment-${node.nodeId}`} label={t.xGoalAsCommitment} kind={selected.as === 'commitment' ? 'accent' : 'outline'} onPress={() => onChooseKind(node.nodeId, 'commitment')} />
            <Pill testID={`goal-kind-habit-${node.nodeId}`} label={t.xGoalAsHabit} kind={selected.as === 'habit' ? 'accent' : 'outline'} onPress={() => onChooseKind(node.nodeId, 'habit')} />
          </ProductActions>
          {selected.as === 'habit' ? <>
            <Txt role="supporting" color={p.mu}>{t.xHabitConfirmationBody}</Txt>
            <ProductActions>{[1, 3, 5].map(value => <Pill key={value} label={fill(t.xTimesPerWeek, { count: formatNumber(value, { locale: lang }) })} kind={selected.count === value ? 'accent' : 'outline'} onPress={() => onUpdateHabit(node.nodeId, { count: value })} />)}</ProductActions>
            <ProductActions>{[15, 30, 45, 60].map(value => <Pill key={value} label={fill(t.xMinutes, { count: formatNumber(value, { locale: lang }) })} kind={selected.durationMinutes === value ? 'accent' : 'outline'} onPress={() => onUpdateHabit(node.nodeId, { durationMinutes: value })} />)}</ProductActions>
          </> : null}
        </> : null}
      </Card>;
    })}
    {checkpoints.length > 0 ? <Card style={{ gap: 8 }}><Txt role="label">{t.xCheckpoints}</Txt>{checkpoints.map(node => <ProductRow key={node.nodeId} title={isolate(node.title)} icon="goal" />)}</Card> : null}
    {error ? <Txt role="supporting" color={p.wm}>{userFacingMessage(error, t)}</Txt> : null}
    <ProductActions>
      <Pill testID="goal-confirm-selected" label={t.xGoalConfirmSelected} disabled={busy || Object.keys(selections).length === 0} onPress={onConfirm} />
      <Pill label={t.cancel} kind="outline" disabled={busy} onPress={onCancel} />
    </ProductActions>
    <Txt role="metadata" color={p.mu}>{fill(t.xGoalGeneration, { count: formatNumber(graph.generation, { locale: lang }) })}</Txt>
  </ProductSection>;
}

function LinkedWorkRow({ node, progress, habit, habitPending, unlinking, busy, onAskUnlink, onCancelUnlink, onUnlink }: {
  node: LinkedNode;
  progress: { entityKind: 'commitment'; status: string; completed: boolean } | { entityKind: 'habit'; completedOccurrences: number; targetOccurrences: number; completed: boolean } | undefined;
  habit: { title: string; status: 'active' | 'paused' | 'archived' } | undefined;
  habitPending: boolean;
  unlinking: boolean;
  busy: boolean;
  onAskUnlink: () => void;
  onCancelUnlink: () => void;
  onUnlink: () => void;
}) {
  const { t, p, lang } = useApp();
  const commitment = useCommitment(node.kind === 'linked_commitment' ? node.commitmentId : null);
  const isCommitment = node.kind === 'linked_commitment';
  const title = isCommitment ? commitment.data?.title : habit?.title;
  const missing = isCommitment ? (!commitment.isPending && !commitment.data) : (!habitPending && !habit);
  const status = isCommitment
    ? commitmentStatus(commitment.data?.status, t)
    : habit?.status === 'paused' ? t.xPaused : habit?.status === 'archived' ? t.dropped : t.active;
  const progressCopy = progress?.entityKind === 'habit'
    ? fill(t.xGoalHabitProgress, {
      completed: formatNumber(progress.completedOccurrences, { locale: lang }),
      target: formatNumber(progress.targetOccurrences, { locale: lang }),
    })
    : progress?.entityKind === 'commitment' ? (progress.completed ? t.doneS : status) : t.xGoalProgressUnscoped;
  return <Card testID={`goal-linked-${node.nodeId}`} style={{ gap: 10 }}>
    {title ? <ProductRow title={isolate(title)} body={progressCopy} icon={isCommitment ? 'check' : 'habit'} />
      : <Txt role="supporting" color={missing ? p.wm : p.mu}>{missing ? t.xGoalEntityMissing : t.todayLoading}</Txt>}
    {!unlinking ? <Pill label={t.xGoalUnlink} kind="outline" disabled={busy} onPress={onAskUnlink} /> : <Card style={{ gap: 10 }}>
      <Txt role="supporting">{t.xGoalUnlinkConfirm}</Txt>
      <Txt role="metadata" color={p.mu}>{t.xGoalUnlinkKeep}</Txt>
      <ProductActions><Pill testID={`goal-unlink-confirm-${node.nodeId}`} label={t.xGoalUnlink} kind="warmSolid" disabled={busy} onPress={onUnlink} /><Pill label={t.cancel} kind="outline" disabled={busy} onPress={onCancelUnlink} /></ProductActions>
    </Card>}
  </Card>;
}

function commitmentStatus(status: string | undefined, t: { doneS: string; dropped: string; statusPostponed: string; active: string }): string {
  if (status === 'completed') return t.doneS;
  if (status === 'dropped') return t.dropped;
  if (status === 'postponed') return t.statusPostponed;
  return t.active;
}
