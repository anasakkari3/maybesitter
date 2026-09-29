import { shareIntakeEnabled } from '../../config/env';
import type { Screen } from '../../state/types';

/** Reviewed against this branch's mobile routes AND runtime registrations.
 * Availability is not a connection claim. Never infer connection from login.
 *
 * There is no "coming soon" status. Something not built is absent — not
 * listed, not drawn, not labelled (council: a coming-soon badge is a FAIL; UAT
 * 2026-09-27, #17). `capabilityRows.test.tsx` fails on the word anywhere in
 * the app's source.
 *
 * VIA_SHARE: shipped, and reached from another app's Share Sheet rather than
 * from a connection — WhatsApp exports, PDFs/files and photos
 * (`lib/services/share/channels/*`, `/api/mobile/capture/share`). */
export type Availability = 'LIVE' | 'AVAILABLE' | 'VIA_SHARE' | 'BETA' | 'BLOCKED' | 'NEEDS_REAUTH';
export const capabilities = {
  capture: 'LIVE', dailyPlan: 'LIVE', memory: 'LIVE',
  assistantPreparation: 'LIVE', weeklyMode: 'LIVE',
  // No assistant personality or name: nothing is built behind them, and a
  // Coming-soon row is a FAIL (council, closure CL7). Absent, not labelled
  // (UAT 2026-09-27, #17).
  // Built to the credential line (CL6a): until the owner adds the OAuth
  // client the Google page says so in one line and offers no connect button.
  gmail: 'AVAILABLE', googleCalendar: 'AVAILABLE', drive: 'AVAILABLE',
  location: 'LIVE',
  goals: 'LIVE', habits: 'LIVE', planDiff: 'LIVE',
  watcherBuilder: 'LIVE', watcherManagement: 'LIVE', export: 'LIVE',
} as const satisfies Record<string, Availability>;

/** What arrives through the Share Sheet. It exists only in a build whose
 * share target is switched on (`EXPO_PUBLIC_FEATURE_SHARE_INTAKE`); in any
 * other build its rows are absent (`null`). */
export type ShareCapability = 'whatsapp' | 'files' | 'photos';
export function shareCapability(): 'VIA_SHARE' | null {
  return shareIntakeEnabled() ? 'VIA_SHARE' : null;
}
export type CapabilityKey = keyof typeof capabilities | ShareCapability;

/**
 * The mobile screen and the `/api/mobile` route each capability stands on.
 * `capabilityRows.test.tsx` checks every route here exists on disk. A
 * capability with no route is not listed at all.
 */
export const capabilityDependsOn: Record<CapabilityKey, { screen: Screen; api: string }> = {
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
  // «حضّرني» (CL5a): offered on the Calendar tab's busy times and on a
  // meeting commitment; the proposal it makes is reviewed in capture.
  assistantPreparation: { screen: 'calendar', api: '/api/mobile/meetings/prepare' },
  weeklyMode: { screen: 'weekPlan', api: '/api/mobile/plans/week' },
  gmail: { screen: 'googleIntegration', api: '/api/mobile/integrations/google/gmail/scan' },
  googleCalendar: { screen: 'googleIntegration', api: '/api/mobile/integrations/google/calendar' },
  drive: { screen: 'googleIntegration', api: '/api/mobile/integrations/google/drive/import' },
  // Place reminders (closure CL4): the places live on the phone; the account
  // learns only that a commitment has one, through the commitment's PATCH.
  location: { screen: 'places', api: '/api/mobile/commitments/[id]' },
  export: { screen: 'personalization', api: '/api/mobile/account/export' },
};

export const availabilityKey = {
  LIVE: 'xLive', AVAILABLE: 'xLive', VIA_SHARE: 'xViaShare', BETA: 'xBeta',
  BLOCKED: 'xBlocked', NEEDS_REAUTH: 'xReauth',
} as const;
/**
 * The watcher sources the app knows. Flights and parcels are deliberately
 * absent — not "coming soon" — until the owner approves a provider and its
 * price (council ruling, closure CL7); `capabilityRows.test.tsx` holds that.
 * Football is offered only when the server reports its key configured.
 */
export const watchSources = {
  football: { title: 'xFootball', conditions: ['xKickoff'] },
  assignment: { title: 'xAssignment', conditions: ['xDeadlineChange'] },
  readiness: { title: 'xReadiness', conditions: ['xEnergyChange'] },
  other: { title: 'xOther', conditions: ['xCustom'] },
} as const;
export type WatchSource = keyof typeof watchSources;
