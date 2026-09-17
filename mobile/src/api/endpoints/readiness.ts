import { apiRequest } from '../client';
import {
  readinessResponseSchema,
  readinessSavedSchema,
  type ReadinessResponse,
  type ReadinessSaved,
} from '../schemas/readiness';

export function getReadiness(): Promise<ReadinessResponse> {
  return apiRequest('GET', '/api/mobile/readiness', { schema: readinessResponseSchema });
}

export function putSubjectiveEnergy(input: { energy: 1 | 2 | 3 | 4 | 5; observedAt: string }): Promise<ReadinessSaved> {
  return apiRequest('PUT', '/api/mobile/readiness', {
    body: input,
    schema: readinessSavedSchema,
  });
}
