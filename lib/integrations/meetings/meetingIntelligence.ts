import { createHash } from 'node:crypto';
import { untrustedExternalContentBoundary, type ExternalInstructionSignal } from '../providers/untrustedExternalContent';

export interface MeetingTranscriptSegment {
  readonly speaker: string | null;
  readonly spokenAt: string | null;
  readonly text: string;
}

export interface MeetingTranscriptPayload {
  readonly provider: string;
  readonly connectionId: string;
  readonly meetingId: string;
  readonly occurredAt: string;
  readonly segments: readonly MeetingTranscriptSegment[];
}

export interface UntrustedMeetingContext {
  readonly trust: 'untrusted_external_content';
  readonly allowedEffect: 'interpret_or_propose_only';
  readonly privilegedActionAllowed: false;
  readonly injectionSignals: readonly ExternalInstructionSignal[];
  readonly contentClass: 'meeting_transcript';
  readonly provider: string;
  readonly connectionId: string;
  readonly meetingId: string;
  readonly occurredAt: string;
  readonly transcript: string;
  readonly provenance: { readonly source: 'meeting_provider'; readonly rawTranscriptPersisted: false };
}

export interface MeetingActionCandidate {
  readonly candidateId: string;
  readonly owner: string | null;
  readonly action: string;
  readonly deadlineAt: string | null;
  readonly confidence: number;
  readonly sourceSegmentIndexes: readonly number[];
}

export interface MeetingCommitmentProposal {
  readonly proposalId: string;
  readonly meetingId: string;
  readonly candidate: MeetingActionCandidate;
  readonly status: 'pending_confirmation';
  readonly requiresExplicitConfirmation: true;
  readonly sourceTrust: 'untrusted_external_content';
}

export interface MeetingCommitmentDraft {
  readonly title: string;
  readonly owner: string | null;
  readonly dueAt: string | null;
  readonly source: 'meeting_proposal';
  readonly sourceRef: string;
}

export type MeetingProposalDecision =
  | { readonly status: 'confirmed'; readonly decidedAt: string; readonly draft: MeetingCommitmentDraft }
  | { readonly status: 'dismissed'; readonly decidedAt: string; readonly draft: null };

export interface MeetingTranscriptPort {
  readTranscript(connectionId: string, meetingId: string): Promise<MeetingTranscriptPayload>;
}

export function normalizeMeetingTranscript(payload: MeetingTranscriptPayload): UntrustedMeetingContext {
  if (!payload.meetingId.trim() || !Number.isFinite(Date.parse(payload.occurredAt))) {
    throw new TypeError('Malformed meeting transcript metadata');
  }
  if (payload.segments.length === 0 || payload.segments.some((segment) => !segment.text.trim())) {
    throw new TypeError('Meeting transcript requires non-empty segments');
  }
  const transcript = payload.segments
    .map((segment, index) => `[${index}] ${segment.speaker ? `${segment.speaker}: ` : ''}${segment.text}`)
    .join('\n');
  return {
    ...untrustedExternalContentBoundary(transcript),
    contentClass: 'meeting_transcript',
    provider: payload.provider,
    connectionId: payload.connectionId,
    meetingId: payload.meetingId,
    occurredAt: payload.occurredAt,
    transcript,
    provenance: { source: 'meeting_provider', rawTranscriptPersisted: false },
  };
}

export function createMeetingActionProposals(
  context: UntrustedMeetingContext,
  candidates: readonly Omit<MeetingActionCandidate, 'candidateId'>[],
): readonly MeetingCommitmentProposal[] {
  const seen = new Set<string>();
  const proposals: MeetingCommitmentProposal[] = [];
  for (const candidate of candidates) {
    const action = candidate.action.trim();
    if (!action || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
      throw new TypeError('Malformed meeting action candidate');
    }
    if (candidate.deadlineAt !== null && !Number.isFinite(Date.parse(candidate.deadlineAt))) {
      throw new TypeError('Meeting deadline must be an instant');
    }
    const identity = [context.connectionId, context.meetingId, candidate.owner ?? '', action.toLowerCase(), candidate.deadlineAt ?? ''].join('\0');
    const candidateId = `meeting-candidate-${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
    if (seen.has(candidateId)) continue;
    seen.add(candidateId);
    const normalized: MeetingActionCandidate = {
      ...candidate,
      candidateId,
      action,
      sourceSegmentIndexes: Array.from(new Set(candidate.sourceSegmentIndexes)).sort((left, right) => left - right),
    };
    proposals.push({
      proposalId: `meeting-proposal-${candidateId.slice('meeting-candidate-'.length)}`,
      meetingId: context.meetingId,
      candidate: normalized,
      status: 'pending_confirmation',
      requiresExplicitConfirmation: true,
      sourceTrust: 'untrusted_external_content',
    });
  }
  return proposals;
}

export function decideMeetingProposal(
  proposal: MeetingCommitmentProposal,
  decision: 'confirm' | 'dismiss',
  decidedAt: string,
): MeetingProposalDecision {
  if (!Number.isFinite(Date.parse(decidedAt))) throw new TypeError('Meeting decision time must be an instant');
  if (decision === 'dismiss') return { status: 'dismissed', decidedAt, draft: null };
  return {
    status: 'confirmed',
    decidedAt,
    draft: {
      title: proposal.candidate.action,
      owner: proposal.candidate.owner,
      dueAt: proposal.candidate.deadlineAt,
      source: 'meeting_proposal',
      sourceRef: proposal.proposalId,
    },
  };
}

export const MEETING_INTELLIGENCE_POLICY = Object.freeze({
  rawTranscriptIsInstruction: false,
  rawTranscriptPersisted: false,
  silentCommitmentCreationAllowed: false,
  explicitConfirmationRequired: true,
  providerSpecificCommitmentLogicAllowed: false,
});
