export const GOAL_PLAN_SCHEMA_VERSION = 'goal-plan-v1' as const;

export type GoalPlanLanguage = 'ar' | 'he' | 'en' | 'mixed';
export type GoalPlanStatus = 'draft' | 'approved' | 'confirmed';
export type StoredGoalPlanStatus = GoalPlanStatus | 'superseded';
export type GoalPlanSource = 'model' | 'template' | 'sentence_and_model';
export type GoalPlanKind = 'commitment' | 'habit';

export interface GoalPlanPhase {
  unit: 'day' | 'week';
  index: number;
}

export interface GoalPlanRhythm {
  timesPerWeek: number;
  timeOfDay?: 'morning' | 'afternoon' | 'evening';
}

export interface GoalPlanSourceSpan {
  start: number;
  end: number;
  text: string;
}

export interface GoalPlanStep {
  stepId: string;
  order: number;
  phase: GoalPlanPhase;
  title: string;
  kind: GoalPlanKind;
  durationMinutes: number;
  rhythm?: GoalPlanRhythm;
  buildsOn: string | null;
  expectedOutcome: string | null;
  origin: 'model' | 'template' | 'person';
}

export interface GoalPlan {
  planId: string;
  goalId: string;
  revision: number;
  status: GoalPlanStatus;
  source: GoalPlanSource;
  horizon: 'days' | 'weeks';
  language: GoalPlanLanguage;
  summary: { goalText: string };
  steps: GoalPlanStep[];
  removedSteps: Array<{ stepId: string; title: string }>;
}

export interface GoalPlanSlot {
  startsAt: string;
  endsAt: string;
}

export interface GoalPlanWeeklyTiming {
  weekdays: number[];
  start: string;
  end: string;
}

export type GoalPlanTimesStep =
  | { stepId: string; kind: 'commitment'; slot: GoalPlanSlot | null; alternatives: GoalPlanSlot[]; reason?: string; choice: 'proposed' | 'none' }
  | { stepId: string; kind: 'habit'; weekly: GoalPlanWeeklyTiming | null; alternatives: GoalPlanWeeklyTiming[]; reason?: string; choice: 'proposed' | 'none' }
  | { stepId: string; kind: GoalPlanKind; later: { weekIndex: number } };

export interface GoalPlanTimes {
  timesId: string;
  timesRevision: number;
  planId: string;
  planRevision: number;
  anchor: { localDate: string; timezone: string };
  steps: GoalPlanTimesStep[];
}

export type GoalPlanSavedWhen =
  | { kind: 'slot'; startsAt: string; endsAt: string }
  | { kind: 'weekly'; weekdays: number[]; start: string; end: string }
  | { kind: 'none' };

export type GoalPlanStayedWhy =
  | { kind: 'later_week'; weekIndex: number }
  | { kind: 'removed' }
  | { kind: 'no_room'; reason: string };

export interface GoalPlanConfirmOutcome {
  saved: Array<{ stepId: string; entity: GoalPlanKind; id: string; title: string; when: GoalPlanSavedWhen }>;
  stayed: Array<{ stepId: string; title: string; why: GoalPlanStayedWhy }>;
  receipt: { outcomeId: string; replayed: boolean };
}

export type GoalPlanEdit =
  | { op: 'reorder'; stepId: string; toOrder: number }
  | { op: 'remove'; stepId: string }
  | { op: 'restore'; stepId: string }
  | { op: 'add'; afterStepId: string | null; step: { title: string; kind: GoalPlanKind; phase: GoalPlanPhase; durationMinutes: number; rhythm?: GoalPlanRhythm } }
  | { op: 'update'; stepId: string; fields: Partial<Pick<GoalPlanStep, 'title' | 'kind' | 'phase' | 'durationMinutes' | 'rhythm'>> };

export const GOAL_PLAN_CONFIRM_MAX_WRITES = 223;
if (GOAL_PLAN_CONFIRM_MAX_WRITES > 500) throw new Error('goal-plan confirm exceeds Firestore transaction limit');

