export interface ResolvableStatement {
  id: string;
  scope: string;
  statement: string;
}

export interface StatementMatchScore {
  id: string;
  scopeScore: number;
  textScore: number;
  totalScore: number;
}

// Duplicated from commitmentResolver.ts rather than imported: Sprint 1's resolver is
// working, tested code and this keeps the two resolvers independently modifiable
// without cross-coupling commitment matching to statement matching.
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

export function scoreStatementMatch(candidateScope: string, candidateText: string, existing: ResolvableStatement): StatementMatchScore {
  const scopeScore = normalizeForComparison(candidateScope) === normalizeForComparison(existing.scope) ? 1 : 0;
  const textScore = wordOverlap(candidateText, existing.statement);
  const totalScore = scopeScore * 0.5 + textScore * 0.5;
  return { id: existing.id, scopeScore, textScore, totalScore };
}

export type StatementResolutionDecision =
  | { action: 'link'; id: string; score: StatementMatchScore }
  | { action: 'confirm_link'; id: string; score: StatementMatchScore }
  | { action: 'create_new' };

export function resolveStatement(
  candidateScope: string,
  candidateText: string,
  existingActive: ResolvableStatement[],
): StatementResolutionDecision {
  if (existingActive.length === 0) return { action: 'create_new' };

  const scores = existingActive.map((existing) => scoreStatementMatch(candidateScope, candidateText, existing));
  scores.sort((a, b) => b.totalScore - a.totalScore);
  const best = scores[0];

  if (best.totalScore >= 0.85) return { action: 'link', id: best.id, score: best };
  if (best.totalScore >= 0.60) return { action: 'confirm_link', id: best.id, score: best };
  return { action: 'create_new' };
}
