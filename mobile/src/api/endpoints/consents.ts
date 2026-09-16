import { apiRequest } from '../client';
import {
  aiConsentUpdatedSchema,
  consentsViewSchema,
  personalizationConsentUpdatedSchema,
  recommendationConsentUpdatedSchema,
  type ConsentsView,
  type ConsentState,
} from '../schemas/consents';

/**
 * Reads consent from the server, every time (UC-2.1, #161).
 *
 * Never from device storage. Consent lives in one place, and a device that was
 * offline when somebody revoked on another device has to show the revocation as
 * soon as it asks — a cached "granted" is exactly the case where it would not.
 */
export function getConsents(): Promise<ConsentsView> {
  return apiRequest('GET', '/api/mobile/consents', { schema: consentsViewSchema });
}

export interface ConsentAnswer {
  state: ConsentState;
  /** The version the server said it recognises, from `currentVersions`. */
  version: string;
  locale?: 'ar' | 'he' | 'en';
  platform?: 'ios' | 'android';
}

/**
 * Records an answer (UC-2.1 #161, UC-2.9 #170, asked by UC-2.R1 #171).
 *
 * The version is echoed from `getConsents` rather than hard-coded: an unknown
 * one is refused outright, and a hard-coded one would claim agreement to words
 * this build cannot prove were shown.
 */
export function putAiConsent(answer: ConsentAnswer) {
  return apiRequest('PUT', '/api/mobile/consents/ai-processing', {
    body: answer,
    schema: aiConsentUpdatedSchema,
  });
}

export function putRecommendationConsent(answer: ConsentAnswer) {
  return apiRequest('PUT', '/api/mobile/consents/recommendations', {
    body: answer,
    schema: recommendationConsentUpdatedSchema,
  });
}

/**
 * "Notice patterns in when you finish things" (UC-3.16, #202).
 *
 * Declining stops the suggestions and stops a pattern the user kept shaping
 * their plan. It does not delete what they kept — that is the memory screen's
 * Delete, and the toggle's copy says so.
 */
export function putPersonalizationConsent(answer: ConsentAnswer) {
  return apiRequest('PUT', '/api/mobile/consents/personalization', {
    body: answer,
    schema: personalizationConsentUpdatedSchema,
  });
}
