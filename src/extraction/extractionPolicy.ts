import type { ExtractionDisposition, ExtractionResult } from './extractionTypes';

export const HIGH_CONFIDENCE = 0.85;
export const MEDIUM_CONFIDENCE = 0.6;

function hasRequiredFields(result: ExtractionResult): boolean {
  if (result.type === 'task') {
    return Boolean(result.action && (result.dueAt || result.remindAt));
  }
  if (result.type === 'follow_up') {
    return Boolean(result.action && result.person && (result.dueAt || result.remindAt));
  }
  if (result.type === 'informational_context') {
    return true;
  }
  return false;
}

export function decideExtractionDisposition(result: ExtractionResult): ExtractionDisposition {
  if (
    result.type === 'informational_context' ||
    (result.confidence.overall < MEDIUM_CONFIDENCE && !result.explicitReminderRequest)
  ) {
    return 'store_note';
  }

  if (
    result.explicitReminderRequest &&
    result.confidence.overall >= HIGH_CONFIDENCE &&
    hasRequiredFields(result) &&
    !result.ambiguityFlags.includes('multiple_commitments') &&
    !result.ambiguityFlags.includes('contradictory_time') &&
    !result.ambiguityFlags.includes('negated_request') &&
    !result.ambiguityFlags.includes('weak_commitment_language')
  ) {
    return 'auto_confirm';
  }

  if (result.confidence.overall >= MEDIUM_CONFIDENCE && !hasRequiredFields(result)) {
    return 'needs_clarification';
  }

  if (result.confidence.overall >= MEDIUM_CONFIDENCE && hasRequiredFields(result)) {
    return 'pending_confirmation';
  }

  return 'needs_clarification';
}
