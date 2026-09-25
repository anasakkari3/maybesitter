import { shareIntakeEnabled } from '../../config/env';
import type { Screen } from '../../state/types';

/** Reviewed against this branch's mobile routes AND runtime registrations.
 * Availability is not a connection claim. Never infer connection from login.
 *
 * VIA_SHARE: shipped, and reached from another app's Share Sheet rather than
 * from a connection — WhatsApp exports, PDFs/files and photos
 * (`lib/services/share/channels/*`, `/api/mobile/capture/share`). */
export type Availability = 'LIVE' | 'AVAILABLE' | 'VIA_SHARE' | 'COMING_SOON' | 'BETA' | 'BLOCKED' | 'NEEDS_REAUTH';
export const capabilities = {
  capture: 'LIVE', dailyPlan: 'LIVE', memory: 'LIVE',
  assistantPreparation: 'COMING_SOON', weeklyMode: 'COMING_SOON',
  assistantPersonality: 'COMING_SOON', assistantName: 'COMING_SOON',
  gmail: 'COMING_SOON', googleCalendar: 'COMING_SOON', drive: 'COMING_SOON',
  location: 'COMING_SOON', camera: 'COMING_SOON',
  goals: 'LIVE', habits: 'LIVE', planDiff: 'LIVE',
  watcherBuilder: 'LIVE', watcherManagement: 'LIVE', export: 'LIVE',
} as const satisfies Record<string, Availability>;

/** What arrives through the Share Sheet. It exists only in a build whose
 * share target is switched on (`EXPO_PUBLIC_FEATURE_SHARE_INTAKE`); in any
 * other build it is honestly still to come. */
export type ShareCapability = 'whatsapp' | 'files' | 'photos';
export function shareCapability(): Availability {
  return shareIntakeEnabled() ? 'VIA_SHARE' : 'COMING_SOON';
}
export type CapabilityKey = keyof typeof capabilities | ShareCapability;

/**
 * The mobile screen and the `/api/mobile` route each capability stands on.
 * `null` means none exists yet, and such a capability must be COMING_SOON.
 * `capabilityRows.test.tsx` checks every route here exists on disk and pins the
 * Coming-soon list: when a server route ships, add it here, flip the status
 * above, give the row its action, and update that test.
 */
export const capabilityDependsOn: Record<CapabilityKey, { screen: Screen | null; api: string | null }> = {
  capture: { screen: 'capture', api: '/api/mobile/capture' },
  dailyPlan: { screen: 'plan', api: '/api/mobile/plans/[date]' },
  memory: { screen: 'memory', api: '/api/mobile/memory' },
  goals: { screen: 'goalExecution', api: '/api/mobile/goals/[goalId]/execution' },
  habits: { screen: 'habitDetail', api: '/api/mobile/habits' },
  planDiff: { screen: 'patchReview', api: '/api/mobile/plans/[date]/actions' },
  watcherBuilder: { screen: 'watchBuilder', api: '/api/mobile/watchers' },
  watcherManagement: { screen: 'backgroundActivity', api: '/api/mobile/trust/background-activity' },
  whatsapp: { screen: 'share', api: '/api/mobile/capture/share' },
  files: { screen: 'share', api: '/api/mobile/capture/share' },
  photos: { screen: 'share', api: '/api/mobile/capture/share' },
  assistantPreparation: { screen: null, api: null },
  weeklyMode: { screen: null, api: null },
  assistantPersonality: { screen: null, api: null },
  assistantName: { screen: null, api: null },
  gmail: { screen: null, api: null },
  googleCalendar: { screen: null, api: null },
  drive: { screen: null, api: null },
  location: { screen: null, api: null },
  camera: { screen: null, api: null },
  export: { screen: 'personalization', api: '/api/mobile/account/export' },
};

export const availabilityKey = {
  LIVE: 'xLive', AVAILABLE: 'xLive', VIA_SHARE: 'xViaShare', COMING_SOON: 'xSoon', BETA: 'xBeta',
  BLOCKED: 'xBlocked', NEEDS_REAUTH: 'xReauth',
} as const;
export const watchSources = {
  flight: { title: 'xFlight', conditions: ['xFlightDelay', 'xGate', 'xDeparture', 'xCancelled'] },
  package: { title: 'xPackage', conditions: ['xDelivery'] },
  football: { title: 'xFootball', conditions: ['xKickoff'] },
  assignment: { title: 'xAssignment', conditions: ['xDeadlineChange'] },
  readiness: { title: 'xReadiness', conditions: ['xEnergyChange'] },
  other: { title: 'xOther', conditions: ['xCustom'] },
} as const;
export type WatchSource = keyof typeof watchSources;
