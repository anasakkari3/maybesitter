import { apiRequest } from '../client';
import { ValidationError } from '../errors';
import { watcherChangedSchema, watcherDeletedSchema, watcherListSchema } from '../schemas/watchers';
function path(id: string) {
  if (!/^wtc_[0-9a-fA-F-]{36}$/.test(id)) throw new ValidationError('invalid watcher identity');
  return `/api/mobile/watchers/${encodeURIComponent(id)}`;
}
export const listWatchers = () => apiRequest('GET', '/api/mobile/watchers', { schema: watcherListSchema });
export const pauseWatcher = (id: string, paused: boolean) => apiRequest('POST', `${path(id)}/pause`, { body: { paused }, schema: watcherChangedSchema });
export const deleteWatcher = (id: string) => apiRequest('DELETE', path(id), { schema: watcherDeletedSchema });
