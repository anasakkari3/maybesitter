import { apiRequest } from '../client';
import { backgroundActivitySchema, backgroundAttributionSchema } from '../schemas/backgroundActivity';

const activityPath = '/api/mobile/trust/background-activity';

export const getBackgroundActivity = () => apiRequest('GET', activityPath, { schema: backgroundActivitySchema });

export const setBackgroundActivityPaused = (paused: boolean) => apiRequest('PATCH', activityPath, {
  body: { paused },
  schema: backgroundActivitySchema,
});

export const getBackgroundAttribution = () => apiRequest('GET', `${activityPath}/attribution`, {
  schema: backgroundAttributionSchema,
});
