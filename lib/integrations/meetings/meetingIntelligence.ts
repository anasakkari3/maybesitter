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
  /**
   * Where the text came from. A provider's transcript by default; `user_notes`
   * when the person typed or pasted it themselves into «حضّرني» (CL5a). The
   * notes are exactly as untrusted as a transcript — pasted text is somebody
   * else's words as often as it is theirs — so only the label differs.
   */
  readonly source?: MeetingContentSource;
}

export type MeetingContentSource = 'meeting_provider' | 'user_notes';

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
  readonly provenance: { readonly source: MeetingContentSource; readonly rawTranscriptPersisted: false };
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
    provenance: { source: payload.source ?? 'meeting_provider', rawTranscriptPersisted: false },
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

/**
 * How many follow-ups one meeting prep may propose.
 *
 * Three. The prep step is the point; follow-ups are a courtesy, and a review
 * screen with eight of them is a to-do list the person did not ask for.
 */
export const MAX_MEETING_FOLLOW_UPS = 3;

export interface MeetingPrepProposals {
  /** The one step to do before the meeting. Always exactly one. */
  readonly prep: MeetingCommitmentProposal;
  /** What to do after it, if the notes said. Never a repeat of `prep`. */
  readonly followUps: readonly MeetingCommitmentProposal[];
}

/**
 * One prep step plus at most three follow-ups, all still proposals (CL5a).
 *
 * Built by `createMeetingActionProposals`, the same function the transcript
 * path uses, so a prep step is validated, deduplicated and identified exactly
 * as any other meeting action — and is equally unable to become a commitment
 * without an explicit confirm. A follow-up that says what the prep step says
 * is dropped: the review screen would otherwise ask the same thing twice.
 */
export function createMeetingPrepProposals(
  context: UntrustedMeetingContext,
  prep: Omit<MeetingActionCandidate, 'candidateId'>,
  followUps: readonly Omit<MeetingActionCandidate, 'candidateId'>[],
): MeetingPrepProposals {
  const [prepProposal] = createMeetingActionProposals(context, [prep]);
  if (!prepProposal) throw new TypeError('A meeting prep needs exactly one prep step');
  const sameAsPrep = (action: string) => action.trim().toLowerCase() === prepProposal.candidate.action.toLowerCase();
  const rest = createMeetingActionProposals(context, followUps.filter((candidate) => !sameAsPrep(candidate.action)));
  return { prep: prepProposal, followUps: rest.slice(0, MAX_MEETING_FOLLOW_UPS) };
}

/** The longest action a meeting proposal carries, in code points. */
export const MAX_MEETING_ACTION_LENGTH = 120;

/**
 * Words that mark a sentence as something to *do*, in the three languages the
 * app speaks. Matched as whole tokens, never with `\b` — a JS word boundary
 * next to an Arabic or Hebrew letter only fires beside ASCII (#401).
 */
const ACTION_TOKENS = new Set([
  // Arabic, spoken: "I want to", "must", and the everyday prep verbs in both
  // the imperative and the first person.
  'بدي', 'لازم', 'ضروري', 'حضر', 'احضر', 'أحضر', 'جهز', 'أجهز', 'اجهز', 'راجع', 'أراجع', 'اراجع',
  'اطبع', 'أطبع', 'ابعت', 'أبعت', 'اكتب', 'أكتب', 'اقرأ', 'أقرأ', 'اقرا', 'اتصل', 'أتصل', 'جيب', 'أجيب',
  'لخص', 'ألخص', 'اسأل', 'أسأل', 'رتب', 'أرتب', 'شيك', 'أشيك', 'اتأكد', 'أتأكد',
  // English.
  'prepare', 'prep', 'review', 'check', 'print', 'send', 'bring', 'read', 'write', 'call', 'email',
  'book', 'finish', 'update', 'draft', 'ask', 'collect', 'gather', 'confirm', 'practise', 'practice',
  'rehearse', 'summarise', 'summarize', 'need', 'must', 'should',
  // Hebrew.
  'צריך', 'צריכה', 'חייב', 'חייבת', 'להכין', 'לבדוק', 'לשלוח', 'להדפיס', 'לקרוא', 'לסכם', 'לכתוב',
  'להביא', 'לעבור', 'לתרגל', 'לשאול', 'להתקשר', 'הכן', 'בדוק', 'שלח',
]);

/** Arabic short vowels and the shadda: «بدّي» and «بدي» are one word here. */
const ARABIC_MARKS = /[\u064B-\u0652\u0670]/g;

/** Punctuation that can hug a word: quotes, brackets, stops, dashes, bullets. */
const TOKEN_EDGE = /^["'«»“”‘’()[\]{}.,:;!?؟،؛\-–—*•·]+|["'«»“”‘’()[\]{}.,:;!?؟،؛\-–—*•·]+$/g;

function normalisedToken(token: string): string {
  const bare = token.replace(ARABIC_MARKS, '').replace(TOKEN_EDGE, '').toLowerCase();
  // A leading «و» (and) is a prefix on the next word, not part of it.
  return bare.length > 3 && bare.startsWith('و') ? bare.slice(1) : bare;
}

/** Sentences, one per line or per full stop, with any list marker removed. */
function sentencesOf(text: string): string[] {
  return text
    .split(/\n|[.!?؟؛;](?=\s|$)/)
    .map((part) => part.replace(/^\s*(?:[-–—*•·]+|\d+[.)])\s*/, '').trim())
    .filter((part) => part.length > 0);
}

/** "I need to", «بدي», «צריך» — the wanting, not the thing wanted. */
function withoutModal(sentence: string): string {
  return sentence
    .replace(/^(?:i\s+)?(?:need|have|want|must|should)(?:\s+to)?\s+/i, '')
    .replace(/^(?:أنا\s+|انا\s+)?(?:بد[ّ]?ي|لازم|ضروري)\s+/, '')
    .replace(/^(?:אני\s+)?(?:צריך|צריכה|חייב|חייבת)\s+/, '')
    .trim();
}

function bounded(sentence: string): string {
  const points = Array.from(sentence);
  if (points.length <= MAX_MEETING_ACTION_LENGTH) return sentence;
  const cut = points.slice(0, MAX_MEETING_ACTION_LENGTH).join('');
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}

/**
 * The prep step, read without a model (CL5a).
 *
 * The first sentence that asks for something to be done — the notes usually
 * open by saying what the meeting *is*, and that line is not a step. With no
 * such sentence anywhere, the first sentence is the step: the person was
 * asked what they want to prepare, so the first thing they wrote is the
 * honest reading of the answer. Null only for notes with no words at all.
 */
export function firstActionSentence(text: string): string | null {
  const sentences = sentencesOf(text);
  if (sentences.length === 0) return null;
  const chosen = sentences.find((sentence) => sentence.split(/\s+/).some((token) => ACTION_TOKENS.has(normalisedToken(token))))
    ?? sentences[0]!;
  const action = bounded(withoutModal(chosen) || chosen);
  return action.length > 0 ? action : null;
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
