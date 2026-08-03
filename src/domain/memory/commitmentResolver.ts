import type { CommitmentMemory, CommitmentMatchScore, MemoryCandidate } from './memoryTypes.ts';

function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9؀-ۿ֐-׿\s]/g, '').replace(/\s+/g, ' ').trim();
}

function wordOverlap(a: string, b: string): number {
  const arrA = normalizeForComparison(a).split(' ').filter(Boolean);
  const arrB = normalizeForComparison(b).split(' ').filter(Boolean);
  if (arrA.length === 0 || arrB.length === 0) return 0;
  const setB: Record<string, boolean> = {};
  for (const w of arrB) setB[w] = true;
  let overlap = 0;
  const seen: Record<string, boolean> = {};
  for (const word of arrA) {
    if (!seen[word] && setB[word]) overlap++;
    seen[word] = true;
  }
  return overlap / Math.max(arrA.length, arrB.length);
}

function participantOverlap(candidateParticipants: string[], commitmentParticipants: string[]): number {
  if (candidateParticipants.length === 0 && commitmentParticipants.length === 0) return 0.5;
  if (candidateParticipants.length === 0 || commitmentParticipants.length === 0) return 0;
  const normA = candidateParticipants.map(normalizeForComparison);
  const normB = commitmentParticipants.map(normalizeForComparison);
  let matches = 0;
  for (const a of normA) {
    for (const b of normB) {
      if (a === b || a.includes(b) || b.includes(a)) {
        matches++;
        break;
      }
    }
  }
  return matches / Math.max(normA.length, normB.length);
}

function temporalProximity(candidateDue: string | undefined, commitmentDue: string | undefined): number {
  if (!candidateDue || !commitmentDue) return 0.3;
  const diff = Math.abs(Date.parse(candidateDue) - Date.parse(commitmentDue));
  const dayMs = 24 * 60 * 60 * 1000;
  if (diff < dayMs) return 1.0;
  if (diff < 3 * dayMs) return 0.7;
  if (diff < 7 * dayMs) return 0.4;
  return 0.1;
}

export function scoreMatch(
  candidate: MemoryCandidate,
  commitment: CommitmentMemory,
  candidateParticipants: string[] = [],
): CommitmentMatchScore {
  const actionScore = wordOverlap(candidate.normalizedText, commitment.title);
  const participantScore = participantOverlap(candidateParticipants, commitment.participants);
  const temporalScore = temporalProximity(candidate.temporal?.resolvedAt, commitment.dueAt);
  const semanticScore = wordOverlap(candidate.normalizedText, commitment.title);

  // Text similarity (action + semantic) is the dominant signal: strong text
  // overlap alone should be able to clear the 0.85 auto-link threshold, while
  // participant/temporal act as tie-breakers that nudge the score.
  const totalScore =
    actionScore * 0.5 +
    participantScore * 0.1 +
    temporalScore * 0.05 +
    semanticScore * 0.35;

  const matchReasons: string[] = [];
  if (participantScore > 0.5) matchReasons.push(`participant overlap: ${participantScore.toFixed(2)}`);
  if (actionScore > 0.5) matchReasons.push(`action similarity: ${actionScore.toFixed(2)}`);
  if (temporalScore > 0.5) matchReasons.push(`temporal proximity: ${temporalScore.toFixed(2)}`);

  return {
    commitmentId: commitment.id,
    participantScore,
    actionScore,
    temporalScore,
    semanticScore,
    totalScore,
    matchReasons,
  };
}

export type ResolutionDecision =
  | { action: 'link'; commitmentId: string; score: CommitmentMatchScore }
  | { action: 'confirm_link'; commitmentId: string; score: CommitmentMatchScore }
  | { action: 'create_new' };

export function resolveCommitment(
  candidate: MemoryCandidate,
  openCommitments: CommitmentMemory[],
  candidateParticipants: string[] = [],
): ResolutionDecision {
  if (openCommitments.length === 0) return { action: 'create_new' };

  const scores = openCommitments.map((c) => scoreMatch(candidate, c, candidateParticipants));
  scores.sort((a, b) => b.totalScore - a.totalScore);
  const best = scores[0];

  if (best.totalScore >= 0.85) {
    return { action: 'link', commitmentId: best.commitmentId, score: best };
  }
  if (best.totalScore >= 0.60) {
    return { action: 'confirm_link', commitmentId: best.commitmentId, score: best };
  }
  return { action: 'create_new' };
}
