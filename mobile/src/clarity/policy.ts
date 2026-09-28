import type { Screen } from '../state/types';

/** Only literal UI structure may leave the app. Never pass a route, ID or title. */
export const SCREEN_FLOWS = {
  myMaybeSitter: 'home', integrations: 'integrations', googleIntegration: 'integrations',
  actionModes: 'settings', addToMaybeSitter: 'capture', goalExecution: 'goal_execution',
  personalization: 'settings', patchReview: 'planning', backgroundActivity: 'settings',
  habitDetail: 'habits', watchBuilder: 'settings',
  commitments: 'commitments', contextualAssistant: 'assistant', today: 'home',
  calendar: 'calendar', settings: 'settings', details: 'commitments', capture: 'capture',
  share: 'import', calendarDemo: 'excluded', deleteAccount: 'excluded', trust: 'settings',
  knows: 'memory', memory: 'memory', aiImport: 'ai_import', feedbackHistory: 'settings',
  activity: 'activity', routineSettings: 'settings', readinessSettings: 'excluded',
  financialContext: 'excluded', notificationsSettings: 'permissions',
  calendarSettings: 'integrations', widgetSettings: 'settings', footballSettings: 'settings',
  calendarFeeds: 'integrations', categorySettings: 'settings', langAppearance: 'settings',
  account: 'excluded', sources: 'integrations', about: 'settings', seeds: 'commitments', plan: 'daily_plan',
} as const satisfies Record<Screen, string>;

export const STAGES = [
  'onboarding_welcome', 'onboarding_consent', 'onboarding_routine', 'onboarding_about', 'onboarding_notifications',
  'capture_input', 'capture_review', 'capture_saved',
  'goal_list', 'goal_detail', 'goal_generating', 'goal_review', 'goal_confirming', 'goal_saved',
  'ai_import_pick', 'ai_import_handoff', 'ai_import_paste', 'ai_import_reading', 'ai_import_review', 'ai_import_saving', 'ai_import_done',
] as const;
export type ClarityStage = typeof STAGES[number];

export const REPLAY_EVENTS = ['capture_saved', 'goal_confirmed', 'ai_import_confirmed', 'daily_plan_accepted', 'onboarding_completed'] as const;
export type ReplayEvent = typeof REPLAY_EVENTS[number];

export function screenContext(screen: Screen, stage: ClarityStage | null) {
  // Reject untrusted runtime strings as well as enforcing the TypeScript union.
  if (!Object.hasOwn(SCREEN_FLOWS, screen)) return null;
  const flow = SCREEN_FLOWS[screen];
  if (flow === 'excluded') return null;
  if (stage && !(STAGES as readonly string[]).includes(stage)) return null;
  const effectiveFlow = stage?.startsWith('onboarding_') ? 'onboarding'
    : stage?.startsWith('ai_import_') ? 'ai_import'
      : stage?.startsWith('goal_') ? 'goal_execution' : flow;
  return { screen: stage ?? screen, flow: effectiveFlow } as const;
}
