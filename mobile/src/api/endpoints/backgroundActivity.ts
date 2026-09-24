import { apiRequest } from '../client';
import {
  backgroundActivityHistorySchema,
  backgroundActivitySchema,
  backgroundAttributionSchema,
} from '../schemas/backgroundActivity';

const activityPath = '/api/mobile/trust/background-activity';

export const getBackgroundActivity = () => apiRequest('GET', activityPath, { schema: backgroundActivitySchema });

export const setBackgroundActivityPaused = (paused: boolean) => apiRequest('PATCH', activityPath, {
  body: { paused },
  schema: backgroundActivitySchema,
});

export const getBackgroundAttribution = () => apiRequest('GET', `${activityPath}/attribution`, {
  schema: backgroundAttributionSchema,
});

export const getBackgroundActivityHistory = (query?: {
  limit?: number | undefined;
  watcherId?: string | undefined;
  kind?: string | undefined;
}) =>
  apiRequest('GET', `${activityPath}/history`, {
    query: query as Record<string, string | number | boolean | undefined>,
    schema: backgroundActivityHistorySchema,
  });
