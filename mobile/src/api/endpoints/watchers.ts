import { apiRequest } from '../client';
import { ValidationError } from '../errors';
import { monitoringSettingsResponseSchema, watcherChangedSchema, watcherDeletedSchema, watcherListSchema, type WatcherEffect } from '../schemas/watchers';
function path(id: string) {
  if (!/^wtc_[0-9a-fA-F-]{36}$/.test(id)) throw new ValidationError('invalid watcher identity');
  return `/api/mobile/watchers/${encodeURIComponent(id)}`;
}
export const listWatchers = () => apiRequest('GET', '/api/mobile/watchers', { schema: watcherListSchema });
export const createReadinessWatcher = (effect: WatcherEffect) => apiRequest('POST', '/api/mobile/watchers', {
  body: {
    enabled: true,
    source: { provider: 'maybesitter', connectionId: null, signalKind: 'readiness', subjectRef: 'self' },
    condition: { kind: 'digest_changed' },
    effect,
    createdBy: 'user',
  },
  schema: watcherChangedSchema,
  expectStatus: 201,
});
/**
 * Follow a club (closure CL7). The server makes it a follow *and* a watcher,
 * and answers 201 for a club already followed too, so a second tap is the same
 * follow. `label` is the club's name in the language the user read it in.
 */
export const createFootballWatcher = (clubId: string, effect: WatcherEffect, label: string) => apiRequest('POST', '/api/mobile/watchers', {
  body: {
    enabled: true,
    label,
    source: { provider: 'football_data', connectionId: null, signalKind: 'football_team', subjectRef: clubId },
    condition: { kind: 'digest_changed' },
    effect,
    createdBy: 'user',
  },
  schema: watcherChangedSchema,
  expectStatus: 201,
});
export const pauseWatcher = (id: string, paused: boolean) => apiRequest('POST', `${path(id)}/pause`, { body: { paused }, schema: watcherChangedSchema });
export const deleteWatcher = (id: string) => apiRequest('DELETE', path(id), { schema: watcherDeletedSchema });
export const getMonitoringSettings = async () => {
  const response = await apiRequest('GET', '/api/mobile/settings/monitoring', { schema: monitoringSettingsResponseSchema });
  return response.monitoringSettings;
};
export const putMonitoringSettings = async (paused: boolean) => {
  const response = await apiRequest('PATCH', '/api/mobile/settings/monitoring', { body: { paused }, schema: monitoringSettingsResponseSchema });
  return response.monitoringSettings;
};
