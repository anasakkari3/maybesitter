import { createHash } from 'node:crypto';

export const CROSS_PROVIDER_IDENTITY_VERSION = 'cross-provider-identity-v1' as const;

export type CrossProviderEntityKind =
  | 'commitment'
  | 'email'
  | 'calendar_event'
  | 'external_task'
  | 'meeting_proposal';

export type IdentityReferenceTrust = 'system_asserted' | 'untrusted_content_claim';

export interface IdentityReference {
  readonly namespace: string;
  readonly value: string;
  readonly trust: IdentityReferenceTrust;
}

export interface CrossProviderIdentityCandidate {
  readonly scopeId: string;
  readonly candidateId: string;
  readonly entityKind: CrossProviderEntityKind;
  readonly provider: string;
  readonly connectionId: string | null;
  readonly externalId: string | null;
  readonly canonicalId: string | null;
  readonly title: string;
  readonly dueAt: string | null;
  readonly owner: string | null;
  readonly references: readonly IdentityReference[];
  readonly observedAt: string;
}

export type IdentityMatchConfidence = 'high' | 'medium' | 'low' | 'none';
export type IdentityResolution = 'link' | 'suggest_merge' | 'preserve_separate';

export type IdentityMatchReason =
  | 'different_scope'
  | 'conflicting_canonical_ids'
  | 'same_canonical_id'
  | 'same_provider_object'
  | 'shared_system_reference'
  | 'same_title_due_owner'
  | 'same_title_and_due'
  | 'same_title_and_owner'
  | 'same_title_only'
  | 'no_meaningful_match';

export interface CrossProviderIdentityDecision {
  readonly version: typeof CROSS_PROVIDER_IDENTITY_VERSION;
  readonly leftCandidateId: string;
  readonly rightCandidateId: string;
  readonly confidence: IdentityMatchConfidence;
  readonly resolution: IdentityResolution;
  readonly reasons: readonly IdentityMatchReason[];
  readonly linkKey: string | null;
}

interface NormalizedCandidate {
  readonly title: string;
  readonly owner: string | null;
  readonly canonicalId: string | null;
  readonly providerObjectKey: string | null;
  readonly systemReferences: ReadonlySet<string>;
}

export function decideCrossProviderIdentity(
  left: CrossProviderIdentityCandidate,
  right: CrossProviderIdentityCandidate,
): CrossProviderIdentityDecision {
  const normalizedLeft = normalizeCandidate(left);
  const normalizedRight = normalizeCandidate(right);
  const ids = [left.candidateId, right.candidateId].sort();

  if (left.scopeId !== right.scopeId) {
    return decision(ids, 'none', 'preserve_separate', ['different_scope'], null);
  }

  if (
    normalizedLeft.canonicalId !== null
    && normalizedRight.canonicalId !== null
    && normalizedLeft.canonicalId !== normalizedRight.canonicalId
  ) {
    return decision(ids, 'none', 'preserve_separate', ['conflicting_canonical_ids'], null);
  }

  const highConfidenceReasons: IdentityMatchReason[] = [];
  const highConfidenceEvidence: string[] = [];
  if (
    normalizedLeft.canonicalId !== null
    && normalizedLeft.canonicalId === normalizedRight.canonicalId
  ) {
    highConfidenceReasons.push('same_canonical_id');
    highConfidenceEvidence.push(`canonical:${normalizedLeft.canonicalId}`);
  }
  if (
    normalizedLeft.providerObjectKey !== null
    && normalizedLeft.providerObjectKey === normalizedRight.providerObjectKey
  ) {
    highConfidenceReasons.push('same_provider_object');
    highConfidenceEvidence.push(`provider-object:${normalizedLeft.providerObjectKey}`);
  }
  const sharedReferences = intersection(normalizedLeft.systemReferences, normalizedRight.systemReferences);
  if (sharedReferences.length > 0) {
    highConfidenceReasons.push('shared_system_reference');
    highConfidenceEvidence.push(...sharedReferences.map((reference) => `reference:${reference}`));
  }
  if (highConfidenceReasons.length > 0) {
    return decision(
      ids,
      'high',
      'link',
      highConfidenceReasons,
      linkKey(left.scopeId, highConfidenceEvidence),
    );
  }

  const sameTitle = normalizedLeft.title === normalizedRight.title;
  const sameDue = left.dueAt !== null && left.dueAt === right.dueAt;
  const sameOwner = normalizedLeft.owner !== null && normalizedLeft.owner === normalizedRight.owner;
  const conflictingOwners = normalizedLeft.owner !== null
    && normalizedRight.owner !== null
    && normalizedLeft.owner !== normalizedRight.owner;

  if (sameTitle && sameDue && sameOwner) {
    return decision(ids, 'medium', 'suggest_merge', ['same_title_due_owner'], null);
  }
  if (sameTitle && sameDue && !conflictingOwners) {
    return decision(ids, 'medium', 'suggest_merge', ['same_title_and_due'], null);
  }
  if (sameTitle && sameOwner && left.dueAt === null && right.dueAt === null) {
    return decision(ids, 'medium', 'suggest_merge', ['same_title_and_owner'], null);
  }
  if (sameTitle) {
    return decision(ids, 'low', 'preserve_separate', ['same_title_only'], null);
  }
  return decision(ids, 'none', 'preserve_separate', ['no_meaningful_match'], null);
}

export function decideCrossProviderIdentitySet(
  candidates: readonly CrossProviderIdentityCandidate[],
): readonly CrossProviderIdentityDecision[] {
  const byId = new Map<string, CrossProviderIdentityCandidate>();
  for (const candidate of candidates) {
    normalizeCandidate(candidate);
    if (byId.has(candidate.candidateId)) throw new TypeError('Identity candidate ids must be unique');
    byId.set(candidate.candidateId, candidate);
  }
  const ordered = Array.from(byId.values()).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  const decisions: CrossProviderIdentityDecision[] = [];
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      decisions.push(decideCrossProviderIdentity(ordered[left]!, ordered[right]!));
    }
  }
  return decisions;
}

export const CROSS_PROVIDER_IDENTITY_POLICY = Object.freeze({
  ambiguousAutoMergeAllowed: false,
  untrustedContentCanAssertIdentity: false,
  crossAccountLinkingAllowed: false,
  persistenceOwnedHere: false,
  providerMutationAllowed: false,
  plannerMutationAllowed: false,
});

function normalizeCandidate(candidate: CrossProviderIdentityCandidate): NormalizedCandidate {
  if (!candidate.scopeId.trim() || !candidate.candidateId.trim() || !candidate.provider.trim()) {
    throw new TypeError('Identity candidate scope, id, and provider are required');
  }
  if (!candidate.title.trim()) throw new TypeError('Identity candidate title is required');
  if (!Number.isFinite(Date.parse(candidate.observedAt))) {
    throw new TypeError('Identity candidate observedAt must be an instant');
  }
  if (candidate.dueAt !== null && !Number.isFinite(Date.parse(candidate.dueAt))) {
    throw new TypeError('Identity candidate dueAt must be an instant');
  }
  const connectionId = nullableExact(candidate.connectionId);
  const externalId = nullableExact(candidate.externalId);
  const providerObjectKey = connectionId !== null && externalId !== null
    ? [candidate.provider.trim().toLocaleLowerCase('en-US'), connectionId, externalId].join('\0')
    : null;
  return {
    title: normalizeText(candidate.title),
    owner: nullableText(candidate.owner),
    canonicalId: nullableExact(candidate.canonicalId),
    providerObjectKey,
    systemReferences: new Set(candidate.references
      .filter((reference) => reference.trust === 'system_asserted')
      .map((reference) => referenceKey(reference))),
  };
}

function referenceKey(reference: IdentityReference): string {
  const namespace = reference.namespace.trim().toLocaleLowerCase('en-US');
  const value = reference.value.trim();
  if (!namespace || !value) throw new TypeError('Identity references require namespace and value');
  return `${namespace}\0${value}`;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function nullableText(value: string | null): string | null {
  return value === null || !value.trim() ? null : normalizeText(value);
}

function nullableExact(value: string | null): string | null {
  return value === null || !value.trim() ? null : value.trim();
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): readonly string[] {
  return Array.from(left).filter((value) => right.has(value)).sort();
}

function linkKey(scopeId: string, evidence: readonly string[]): string {
  const digest = createHash('sha256')
    .update([scopeId, ...Array.from(new Set(evidence)).sort()].join('\0'))
    .digest('hex');
  return `identity-link:${digest}`;
}

function decision(
  ids: readonly string[],
  confidence: IdentityMatchConfidence,
  resolution: IdentityResolution,
  reasons: readonly IdentityMatchReason[],
  key: string | null,
): CrossProviderIdentityDecision {
  return {
    version: CROSS_PROVIDER_IDENTITY_VERSION,
    leftCandidateId: ids[0]!,
    rightCandidateId: ids[1]!,
    confidence,
    resolution,
    reasons: Object.freeze(Array.from(new Set(reasons))),
    linkKey: key,
  };
}
