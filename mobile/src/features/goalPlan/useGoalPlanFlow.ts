import React from 'react';
import * as Crypto from 'expo-crypto';
import {
  acceptStatementGoal,
  approveGoalPlan,
  chooseGoalPlanTime,
  confirmGoalPlan,
  editGoalPlan,
  generateGoalPlan,
  getGoalPlan,
  laterWeekTimes,
  previewStatementGoal,
  regenerateGoalPlan,
  type GoalPlanEditOp,
  type GoalPlanTimesChoice,
} from '../../api/endpoints/goalPlan';
import { GoalPlanRefusedError } from '../../api/errors';
import { useInvalidateAfterPlanConfirm, useUid } from '../../api/queries';
import type { GoalPlan, GoalPlanConfirmResult, GoalPlanTimes, StatementPreview } from '../../api/schemas/goalPlan';

/**
 * The one plan path (M3a): summary → ordered plan → real times → one confirm.
 *
 * One hook drives every entry — the goal's «اعمللي خطة», the watching
 * panel's «اقترحلي خطة», «افهم» on a plan request, and Today's later-week
 * card — so the screens they open are the same screens.
 *
 * Three rules this hook holds, each a contract clause:
 * - **Every write names what it was made against** (M3A-006): an edit sends
 *   the plan's `revision`, a time change the proposal's `timesRevision`. A
 *   refusal that carries the current plan or times is adopted, never
 *   resubmitted.
 * - **A confirm keeps its key across a retry** (M3A-018), and is never
 *   retried without the person pressing again (mobile AGENTS.md).
 * - **An answer for another account is dropped** (#148): a request started
 *   before a sign-out lands after it, and its plan belongs to someone else.
 */

export type PlanStage =
  | { kind: 'idle' }
  | { kind: 'summary'; preview: StatementPreview; text: string }
  | { kind: 'plan'; plan: GoalPlan }
  | { kind: 'times'; plan: GoalPlan | null; times: GoalPlanTimes }
  | { kind: 'confirm'; plan: GoalPlan | null; times: GoalPlanTimes }
  | { kind: 'result'; result: GoalPlanConfirmResult };

export type LiveStep = 'summary' | 'plan' | 'times' | 'editing' | 'saving';
export type LiveState = { phase: 'idle' } | { phase: 'started'; step: LiveStep } | { phase: 'thinking'; step: LiveStep } | { phase: 'done' } | { phase: 'failed' };

export interface PlanFlowState {
  readonly goalId: string | null;
  readonly stage: PlanStage;
  readonly live: LiveState;
  readonly error: unknown;
  readonly busy: boolean;
  /** The statement this flow began from, for «جرّب تحكيه بطريقة تانية». */
  readonly statement: string | null;
}

/** A refusal that carries the recomputed times (`schedule_changed`, `slot_in_past`) is redrawn from them. */
const adoptTimes = (plan: GoalPlan | null) => (refused: GoalPlanRefusedError): Partial<PlanFlowState> =>
  refused.detail.times ? { stage: { kind: 'times', plan, times: refused.detail.times } } : {};

const IDLE: PlanFlowState = { goalId: null, stage: { kind: 'idle' }, live: { phase: 'idle' }, error: null, busy: false, statement: null };

export interface PlanFlow {
  readonly state: PlanFlowState;
  openGoal(goalId: string, draft: GoalPlan | null): void;
  fromStatement(statement: string, locale: string): void;
  setSummaryText(text: string): void;
  acceptSummary(): void;
  generate(source?: 'template'): void;
  regenerate(): void;
  edit(op: GoalPlanEditOp): void;
  approve(): void;
  choose(stepId: string, choice: GoalPlanTimesChoice): void;
  toConfirm(): void;
  backToTimes(): void;
  confirm(): void;
  laterWeek(goalId: string, planId: string, weekIndex: number): void;
  showLatest(): void;
  retry(): void;
  dismissError(): void;
  reset(): void;
}

export function useGoalPlanFlow(): PlanFlow {
  const uid = useUid();
  const invalidate = useInvalidateAfterPlanConfirm();
  const [state, setState] = React.useState<PlanFlowState>(IDLE);
  // What the press handlers read: the committed state. Handlers that start a
  // step and read it again in the same tick set it themselves.
  const stateRef = React.useRef(state);
  React.useLayoutEffect(() => { stateRef.current = state; }, [state]);
  const uidRef = React.useRef(uid);
  const lastAction = React.useRef<(() => void) | null>(null);
  // One key per reviewed proposal, kept until that proposal is confirmed: a
  // retried confirm of the same times is the same confirm.
  const confirmKeys = React.useRef(new Map<string, string>());
  const generateKey = React.useRef<string | null>(null);
  const acceptKey = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (uidRef.current === uid) return;
    uidRef.current = uid;
    confirmKeys.current.clear();
    generateKey.current = null;
    acceptKey.current = null;
    lastAction.current = null;
    setState(IDLE);
  }, [uid]);

  const update = React.useCallback((next: Partial<PlanFlowState>) => setState(current => ({ ...current, ...next })), []);

  /** Runs one request with the live line, drops it if the account changed, and keeps it for «جرّب كمان مرة». */
  const run = React.useCallback(<T,>(step: LiveStep, request: () => Promise<T>, onDone: (value: T) => Partial<PlanFlowState>, onRefused?: (error: GoalPlanRefusedError) => Partial<PlanFlowState>) => {
    const owner = uidRef.current;
    const attempt = () => {
      setState(current => ({ ...current, busy: true, error: null, live: { phase: 'started', step } }));
      // The line moves from «بلّشت» to the step it is on once the request is out.
      queueMicrotask(() => setState(current => current.busy ? { ...current, live: { phase: 'thinking', step } } : current));
      request().then(value => {
        if (uidRef.current !== owner) return;
        setState(current => ({ ...current, ...onDone(value), busy: false, error: null, live: { phase: 'done' } }));
      }, (error: unknown) => {
        if (uidRef.current !== owner) return;
        const adopted = error instanceof GoalPlanRefusedError && onRefused ? onRefused(error) : {};
        setState(current => ({ ...current, ...adopted, busy: false, error, live: { phase: 'failed' } }));
      });
    };
    lastAction.current = attempt;
    attempt();
  }, []);

  const generate = React.useCallback((source?: 'template') => {
    const goalId = stateRef.current.goalId;
    if (!goalId) return;
    generateKey.current = generateKey.current ?? Crypto.randomUUID();
    const key = generateKey.current;
    run('plan', () => generateGoalPlan(goalId, key, source), plan => {
      generateKey.current = null;
      return { stage: { kind: 'plan', plan } };
    }, refused => refused.reason === 'stale' && refused.detail.plan ? { stage: { kind: 'plan', plan: refused.detail.plan } } : {});
  }, [run]);

  const openGoal = React.useCallback((goalId: string, draft: GoalPlan | null) => {
    setState({ ...IDLE, goalId, stage: draft ? { kind: 'plan', plan: draft } : { kind: 'idle' } });
    stateRef.current = { ...IDLE, goalId };
    if (!draft) generate();
  }, [generate]);

  const fromStatement = React.useCallback((statement: string, locale: string) => {
    setState({ ...IDLE, statement });
    acceptKey.current = null;
    run('summary', () => previewStatementGoal(statement, locale), preview => ({
      stage: { kind: 'summary', preview, text: preview.understood.goalText },
    }));
  }, [run]);

  const setSummaryText = React.useCallback((text: string) => setState(current => current.stage.kind === 'summary'
    ? { ...current, stage: { ...current.stage, text } } : current), []);

  const acceptSummary = React.useCallback(() => {
    const stage = stateRef.current.stage;
    if (stage.kind !== 'summary' || !stage.text.trim()) return;
    acceptKey.current = acceptKey.current ?? Crypto.randomUUID();
    const key = acceptKey.current;
    const understood = { ...stage.preview.understood, goalText: stage.text.trim() };
    run('plan', () => acceptStatementGoal(stage.preview, understood, key), goalId => {
      // The goal now exists; the plan is generated for it as on the goal screen.
      queueMicrotask(() => generate());
      stateRef.current = { ...stateRef.current, goalId };
      return { goalId };
    });
  }, [generate, run]);

  const regenerate = React.useCallback(() => {
    const { goalId, stage } = stateRef.current;
    const plan = stage.kind === 'plan' ? stage.plan : stage.kind === 'times' || stage.kind === 'confirm' ? stage.plan : null;
    if (!goalId || !plan) return generate();
    const key = Crypto.randomUUID();
    run('plan', () => regenerateGoalPlan(goalId, plan, key), next => ({ stage: { kind: 'plan', plan: next } }));
  }, [generate, run]);

  const edit = React.useCallback((op: GoalPlanEditOp) => {
    const { goalId, stage } = stateRef.current;
    if (!goalId || stage.kind !== 'plan') return;
    run('editing', () => editGoalPlan(goalId, stage.plan.planId, stage.plan.revision, op), plan => ({ stage: { kind: 'plan', plan } }),
      refused => refused.detail.plan ? { stage: { kind: 'plan', plan: refused.detail.plan } } : {});
  }, [run]);

  const approve = React.useCallback(() => {
    const { goalId, stage } = stateRef.current;
    if (!goalId || stage.kind !== 'plan') return;
    run('times', () => approveGoalPlan(goalId, stage.plan.planId, stage.plan.revision), times => ({ stage: { kind: 'times', plan: stage.plan, times } }),
      refused => refused.detail.plan ? { stage: { kind: 'plan', plan: refused.detail.plan } } : {});
  }, [run]);

  const choose = React.useCallback((stepId: string, choice: GoalPlanTimesChoice) => {
    const { goalId, stage } = stateRef.current;
    if (!goalId || stage.kind !== 'times') return;
    run('times', () => chooseGoalPlanTime(goalId, stage.times.planId, stepId, stage.times.timesRevision, choice),
      times => ({ stage: { kind: 'times', plan: stage.plan, times } }), adoptTimes(stage.plan));
  }, [run]);

  const toConfirm = React.useCallback(() => setState(current => current.stage.kind === 'times'
    ? { ...current, error: null, stage: { kind: 'confirm', plan: current.stage.plan, times: current.stage.times } } : current), []);
  const backToTimes = React.useCallback(() => setState(current => current.stage.kind === 'confirm'
    ? { ...current, error: null, stage: { kind: 'times', plan: current.stage.plan, times: current.stage.times } } : current), []);

  const confirm = React.useCallback(() => {
    const { goalId, stage } = stateRef.current;
    if (!goalId || stage.kind !== 'confirm') return;
    const reviewed = `${stage.times.timesId}:${stage.times.timesRevision}`;
    const key = confirmKeys.current.get(reviewed) ?? Crypto.randomUUID();
    confirmKeys.current.set(reviewed, key);
    run('saving', () => confirmGoalPlan(goalId, stage.times, key), result => {
      invalidate();
      return { stage: { kind: 'result', result } };
    }, adoptTimes(stage.plan));
  }, [invalidate, run]);

  const laterWeek = React.useCallback((goalId: string, planId: string, weekIndex: number) => {
    setState({ ...IDLE, goalId });
    stateRef.current = { ...IDLE, goalId };
    const key = Crypto.randomUUID();
    run('times', () => laterWeekTimes(goalId, planId, weekIndex, key), times => ({ stage: { kind: 'times', plan: null, times } }));
  }, [run]);

  const showLatest = React.useCallback(() => {
    const { goalId } = stateRef.current;
    if (!goalId) return;
    run('plan', () => getGoalPlan(goalId), view => view.draft ? { stage: { kind: 'plan', plan: view.draft } } : { stage: { kind: 'idle' } });
  }, [run]);

  const retry = React.useCallback(() => lastAction.current?.(), []);
  const dismissError = React.useCallback(() => update({ error: null }), [update]);
  const reset = React.useCallback(() => {
    lastAction.current = null;
    generateKey.current = null;
    setState(IDLE);
  }, []);

  return {
    state, openGoal, fromStatement, setSummaryText, acceptSummary, generate, regenerate, edit, approve, choose,
    toConfirm, backToTimes, confirm, laterWeek, showLatest, retry, dismissError, reset,
  };
}
