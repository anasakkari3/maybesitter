import { useClarityStage } from '../../clarity/ClarityProvider';
import React from 'react';
import { TextInput, View } from 'react-native';
import {
  useCommitment,
  useCreateMemory,
  useGoalExecution,
  useGoalPlan,
  useHabits,
  useIntelligenceDecided,
  useMemory,
  useUnlinkGoalNode,
} from '../../api/queries';
import { FeatureUnavailableError } from '../../api/errors';
import type { GoalGraph } from '../../api/schemas/goals';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { forbiddenReason, userFacingMessage } from '../../api/ui/userFacingMessage';
import { isolateAuto } from '../../i18n/bidi';
import { formatNumber } from '../../i18n/format';
import { fill } from '../../i18n/strings';
import { useTimeZone } from '../../i18n/timezone';
import { useApp } from '../../state/AppContext';
import { Card, Pill, Txt } from '../../ui/primitives';
import { ProductActions, ProductPage, ProductRow, ProductSection } from '../../ui/product';
import { PlanFlowView } from '../goalPlan/PlanFlow';
import { usePlanPathAvailable } from '../goalPlan/planAvailability';
import type { PlanRecovery } from '../goalPlan/planFailures';
import { useGoalPlanFlow } from '../goalPlan/useGoalPlanFlow';
import { currentGoalProgressPeriod } from './progressPeriod';
import { IntelligencePanel } from './IntelligencePanel';

type LinkedNode = Extract<GoalGraph['nodes'][number], { kind: 'linked_commitment' | 'linked_habit' }>;

/** What the goal screen can do for a plan failure: leave for capture or thoughts, show what was saved, go back, open the new goal. */
const GOAL_RECOVERIES: readonly PlanRecovery[] = ['capture', 'thoughts', 'see_saved', 'back_to_goals', 'open_new_goal'];

export function GoalExecutionScreen() {
  const { t, p, rtl, lang, actions, s } = useApp();
  const memory = useMemory();
  const decided = useIntelligenceDecided();
  const create = useCreateMemory();
  const [draft, setDraft] = React.useState('');
  const goals = memory.data?.items.filter(item => item.kind === 'goal') ?? [];
  // The open goal is a step in the navigation history, not local state, so the
  // header back, the in-page back and Android's back all close it first (L6).
  const openGoal = s.goalId ? { id: s.goalId, title: goals.find(goal => goal.id === s.goalId)?.content ?? '' } : null;
  useClarityStage(openGoal ? null : 'goal_list');

  // No subtitle: the owner struck «أهدافك، من الاقتراح لخطوات بتأكدها بنفسك.»
  // (audit 2026-10-06, image 8); each card explains itself behind its arrow.
  return <ProductPage id="goals" title={t.xGoals}>
    {openGoal ? <GoalDetail goalId={openGoal.id} title={openGoal.title} onBack={actions.back} /> : forbiddenReason(memory.error) === 'feature_disabled' ? (
      // Goals are kept in memory. With memory switched off on the server there
      // is nowhere to save one, so the screen says so once instead of offering
      // an input whose save can only fail.
      <ProductSection title={t.xAddGoal} body={t.errorsFeatureDisabled} icon="goal" />
    ) : <>
      <IntelligencePanel onChanged={decided} />
      <ProductSection title={t.xAddGoal} why={{ id: 'goal-add', body: t.xAddGoalBody }} icon="goal">
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
            title={isolateAuto(goal.content)}
            body={t.xGoalOpen}
            icon="goal"
            onPress={() => actions.openGoal(goal.id)}
          />)}
          <Pill label={t.memoryScreenTitle} kind="outline" onPress={() => actions.go('knows')} />
        </ProductSection>
      </QueryBoundary>
      <Pill label={t.xLinkedHabits} kind="outline" onPress={() => actions.go('habitDetail')} />
    </>}
  </ProductPage>;
}

function GoalDetail({ goalId, title, onBack }: { goalId: string; title: string; onBack: () => void }) {
  const { t, p, lang, actions } = useApp();
  const zone = useTimeZone();
  const period = React.useMemo(() => currentGoalProgressPeriod(new Date(), zone, lang), [lang, zone]);
  const [notice, setNotice] = React.useState<'unlinked' | null>(null);
  const [unlinking, setUnlinking] = React.useState<string | null>(null);
  const query = useGoalExecution(goalId, 1, period);
  const unlink = useUnlinkGoalNode(goalId);
  const planView = useGoalPlan(goalId);
  const pathOn = usePlanPathAvailable();
  const flow = useGoalPlanFlow();
  useClarityStage(flow.state.stage.kind === 'result' ? 'goal_saved'
    : flow.state.busy ? 'goal_generating'
      : flow.state.goalId ? 'goal_review' : 'goal_detail');
  const canonicalGraph = query.data?.graph;
  const linked = canonicalGraph?.nodes.filter((node): node is LinkedNode => node.kind === 'linked_commitment' || node.kind === 'linked_habit') ?? [];
  const habits = useHabits(linked.some(node => node.kind === 'linked_habit'));
  const progress = query.data?.progress;
  // The plan path (M3a) replaced the card-by-card review: one entry, which
  // opens the whole plan. A confirmed plan is not regenerated (S1): its work is
  // ordinary commitments and habits now, and the goal shows its progress.
  const planOff = planView.error instanceof FeatureUnavailableError;
  const draft = planView.data?.draft ?? null;
  const confirmedPlan = planView.data?.confirmed ?? null;
  const showEntry = !planOff && (pathOn || planView.isSuccess) && !confirmedPlan && !flow.state.goalId;

  const onRecover = (recovery: PlanRecovery | 'open_today', detail: { currentGoalId?: string | undefined }) => {
    switch (recovery) {
      case 'capture': return actions.go('capture');
      case 'thoughts': return actions.go('seeds');
      case 'open_today': return actions.go('today');
      case 'open_new_goal': return detail.currentGoalId ? actions.openGoal(detail.currentGoalId) : onBack();
      case 'back_to_goals': flow.reset(); return onBack();
      default:
        flow.reset();
        void planView.refetch();
        return undefined;
    }
  };

  return <View style={{ gap: 16 }}>
    <Pill testID="goal-back-list" label={t.xGoalBackToGoals} kind="ghost" onPress={onBack} />
    <Card style={{ gap: 8 }}><Txt role="section">{isolateAuto(title)}</Txt></Card>
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

        {confirmedPlan ? <View testID="goal-plan-progress">
          <ProductSection title={t.xPlanProgressTitle} body={t.xPlanProgressBody} icon="spark" />
        </View> : null}

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

        {showEntry ? <ProductSection title={t.xPlanEntryTitle} why={{ id: 'goal-plan', body: t.xPlanEntryWhy }} icon="spark">
          <Pill testID="goal-plan-open" label={draft ? t.xPlanOpenDraft : t.xPlanOpen} onPress={() => flow.openGoal(goalId, draft)} />
        </ProductSection> : null}
        {flow.state.goalId ? <PlanFlowView
          flow={flow}
          onRecover={onRecover}
          hostRecoveries={GOAL_RECOVERIES}
          linkedWork={linked.length > 0 ? <LinkedWorkNote nodes={linked} /> : null}
        /> : null}
        {unlink.error ? <Txt role="supporting" color={p.wm}>{userFacingMessage(unlink.error, t)}</Txt> : null}
      </> : null}
    </QueryBoundary>
  </View>;
}

/** «محفوظ من قبل»: what this goal already has, above a new plan, so a repeat can be removed before approving (S1). */
function LinkedWorkNote({ nodes }: { nodes: readonly LinkedNode[] }) {
  const { t } = useApp();
  return <View testID="plan-linked-work">
    <ProductSection title={t.xPlanLinkedWork} why={{ id: 'plan-linked-work', body: t.xPlanLinkedWorkWhy }} icon="link">
      {nodes.map(node => <LinkedTitle key={node.nodeId} node={node} />)}
    </ProductSection>
  </View>;
}

function LinkedTitle({ node }: { node: LinkedNode }) {
  const { p } = useApp();
  const commitment = useCommitment(node.kind === 'linked_commitment' ? node.commitmentId : null);
  const habits = useHabits(node.kind === 'linked_habit');
  const title = node.kind === 'linked_commitment' ? commitment.data?.title : habits.data?.find(item => item.habitId === node.habitId)?.title;
  return title ? <Txt role="supporting" color={p.mu}>{isolateAuto(title)}</Txt> : null;
}

function NoticeCard({ notice }: { notice: 'unlinked' }) {
  const { t, p } = useApp();
  return <Card testID={`goal-notice-${notice}`} style={{ gap: 6 }}><Txt role="supporting" color={p.success}>{t.xGoalUnlinkDone}</Txt></Card>;
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
    {title ? <ProductRow title={isolateAuto(title)} body={progressCopy} icon={isCommitment ? 'check' : 'habit'} />
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
