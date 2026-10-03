import { apiRequest } from '../client';
import {
  intelligenceAnalyzeSchema, intelligenceGenerateSchema, intelligenceInboxSchema,
  intelligenceObservationReviewSchema, intelligenceSuggestionDecisionSchema,
  intelligenceGmailScanSchema,
  intelligenceGmailMonitorSchema,
} from '../schemas/intelligence';

export function getIntelligenceInbox() {
  return apiRequest('GET', '/api/mobile/intelligence', { schema: intelligenceInboxSchema });
}
export function analyzeIntelligenceStatement(text: string) {
  return apiRequest('POST', '/api/mobile/intelligence', { body: { text }, schema: intelligenceAnalyzeSchema, expectStatus: 201 });
}
/**
 * `visit`: a screen opening (Today's banner, «يتابع لك»), which the server
 * holds to its visit floor so opening screens cannot multiply model calls.
 * Without it the request is explicit (the panel's button). A server that
 * predates the floor ignores the body.
 */
export function generateIntelligenceSuggestions(options: { signal?: AbortSignal; visit?: boolean } = {}) {
  return apiRequest('POST', '/api/mobile/intelligence/generate', {
    body: options.visit ? { trigger: 'visit' } : {}, schema: intelligenceGenerateSchema,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
export function reviewIntelligenceObservation(id: string, review: 'confirmed' | 'dismissed') {
  return apiRequest('POST', `/api/mobile/intelligence/observations/${encodeURIComponent(id)}`, {
    body: { review }, schema: intelligenceObservationReviewSchema,
  });
}
export function decideIntelligenceSuggestion(
  id: string, decision: 'accept' | 'dismiss', title?: string,
  slot?: { startsAt: string; endsAt: string },
) {
  return apiRequest('POST', `/api/mobile/intelligence/suggestions/${encodeURIComponent(id)}`, {
    body: { decision, ...(title === undefined ? {} : { title }), ...(slot === undefined ? {} : { slot }) },
    schema: intelligenceSuggestionDecisionSchema,
  });
}
export function scanGmailForIntelligence() {
  return apiRequest('POST', '/api/mobile/intelligence/sources/gmail/scan', {
    body: {}, schema: intelligenceGmailScanSchema, timeoutMs: 60_000,
  });
}
export function getGmailIntelligenceMonitor() {
  return apiRequest('GET', '/api/mobile/intelligence/sources/gmail/monitor', { schema: intelligenceGmailMonitorSchema });
}
export function setGmailIntelligenceMonitor(enabled: boolean) {
  return apiRequest('POST', '/api/mobile/intelligence/sources/gmail/monitor', {
    body: { enabled }, schema: intelligenceGmailMonitorSchema,
  });
}
export function answerIntelligenceQuestion(id: string, answer: string) {
  return apiRequest('POST', `/api/mobile/intelligence/suggestions/${encodeURIComponent(id)}/answer`, {
    body: { answer }, schema: intelligenceSuggestionDecisionSchema,
  });
}
