import {
  NEXT_STEP_CONTRACT_VERSION,
  type NextStepDecision,
  type NextStepDecisionContract,
  type NextStepLocale,
  type NextStepRecommendationContract,
} from '../../src/contracts/v1/nextStepContracts';
import { compareByCodePoint } from '../planning/shared/compare';

export interface NextStepCandidate {
  commitmentId: string;
  title: string;
  reason: string | null;
  evidenceLabels: string[];
  rank: number;
}

const ACTIONS: NextStepDecision[] = ['accept', 'edit', 'defer', 'dismiss', 'done'];
const FORBIDDEN_LANGUAGE = /\b(must|should|lazy|failure|disappoint|guilty|obey)\b|يجب|كسول|فشل|אכזב|עצלן|חייב/i;

function cleanText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function isSafeText(value: string): boolean {
  return value.length > 0 && !FORBIDDEN_LANGUAGE.test(value);
}

export function proposeNextStep(
  candidates: readonly NextStepCandidate[],
  locale: NextStepLocale,
  proposalId: string,
): NextStepRecommendationContract {
  const eligible = candidates
    .filter((candidate) => isSafeText(cleanText(candidate.title, 120)))
    // Code-unit ordering, never `localeCompare`: the no-argument form resolves
    // against the host's default locale, which would make *which commitment the
    // user is shown* depend on LANG/LC_ALL on the serving machine. Measured:
    // 'i-ITEM' and 'I-item' swap between en-US and tr-TR. The same rule is
    // stated in lib/runtimeMemory, lib/lifeState, lib/feedback and
    // lib/planning/shared/compare.ts, whose compareByCodePoint this reuses.
    .sort((left, right) => left.rank - right.rank
      || compareByCodePoint(left.commitmentId, right.commitmentId));
  const selected = eligible[0];

  if (!selected) {
    return {
      version: NEXT_STEP_CONTRACT_VERSION,
      proposalId,
      state: candidates.length === 0 ? 'empty' : 'insufficient_evidence',
      locale,
      primaryStep: null,
      explanation: null,
      availableActions: [],
      persistence: { occurred: false, confirmationRequired: true },
    };
  }

  const reason = cleanText(selected.reason || '', 160);
  if (!isSafeText(reason)) {
    return {
      version: NEXT_STEP_CONTRACT_VERSION,
      proposalId,
      state: 'insufficient_evidence',
      locale,
      primaryStep: null,
      explanation: null,
      availableActions: [],
      persistence: { occurred: false, confirmationRequired: true },
    };
  }

  return {
    version: NEXT_STEP_CONTRACT_VERSION,
    proposalId,
    state: 'ready',
    locale,
    primaryStep: { commitmentId: selected.commitmentId, title: cleanText(selected.title, 120) },
    explanation: {
      summary: reason,
      evidenceLabels: selected.evidenceLabels.slice(0, 3).map((label) => cleanText(label, 40)),
      sensitiveInferenceUsed: false,
    },
    availableActions: [...ACTIONS],
    persistence: { occurred: false, confirmationRequired: true },
  };
}

export type NextStepInteractionOutcome =
  | { status: 'confirmation_required'; decision: NextStepDecisionContract; persisted: false }
  | { status: 'recorded_without_penalty'; decision: NextStepDecisionContract; persisted: false };

export function decideNextStep(
  proposal: NextStepRecommendationContract,
  decision: NextStepDecision,
  decidedAt: string,
  editedTitle?: string,
): NextStepInteractionOutcome {
  if (proposal.state !== 'ready' || !proposal.availableActions.includes(decision)) {
    throw new Error('decision is not available for this proposal');
  }
  if (decision === 'edit' && !cleanText(editedTitle || '', 120)) {
    throw new Error('editedTitle is required for edit');
  }
  const record: NextStepDecisionContract = {
    version: NEXT_STEP_CONTRACT_VERSION,
    proposalId: proposal.proposalId,
    decision,
    decidedAt,
    ...(decision === 'edit' ? { editedTitle: cleanText(editedTitle || '', 120) } : {}),
  };
  return decision === 'accept' || decision === 'edit' || decision === 'done'
    ? { status: 'confirmation_required', decision: record, persisted: false }
    : { status: 'recorded_without_penalty', decision: record, persisted: false };
}
