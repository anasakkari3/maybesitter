/** Reviewed against this branch's mobile routes AND runtime registrations.
 * Availability is not a connection claim. Never infer connection from login. */
export type Availability = 'LIVE' | 'AVAILABLE' | 'COMING_SOON' | 'BETA' | 'BLOCKED' | 'NEEDS_REAUTH';
export const capabilities = {
  capture: 'LIVE', dailyPlan: 'LIVE', memory: 'LIVE',
  assistantPreparation: 'COMING_SOON', weeklyMode: 'COMING_SOON',
  assistantPersonality: 'COMING_SOON', assistantName: 'COMING_SOON',
  gmail: 'COMING_SOON', googleCalendar: 'COMING_SOON', drive: 'COMING_SOON',
  whatsappConnection: 'COMING_SOON', location: 'COMING_SOON',
  camera: 'COMING_SOON', filePicker: 'COMING_SOON', pdf: 'COMING_SOON',
  goals: 'COMING_SOON', habits: 'COMING_SOON', planDiff: 'COMING_SOON',
  watcherBuilder: 'COMING_SOON', watcherManagement: 'BETA', export: 'COMING_SOON',
} as const satisfies Record<string, Availability>;
export const availabilityKey = {
  LIVE: 'xLive', AVAILABLE: 'xLive', COMING_SOON: 'xSoon', BETA: 'xBeta',
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
