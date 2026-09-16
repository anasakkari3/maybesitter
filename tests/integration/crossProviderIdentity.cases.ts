import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CROSS_PROVIDER_IDENTITY_POLICY,
  decideCrossProviderIdentity,
  decideCrossProviderIdentitySet,
  type CrossProviderIdentityCandidate,
  type IdentityReference,
} from '../../lib/integrations/identity/crossProviderLinker';

const NOW = '2026-09-16T12:00:00.000Z';
const DUE = '2026-09-18T09:00:00.000Z';

function candidate(
  candidateId: string,
  overrides: Partial<CrossProviderIdentityCandidate> = {},
): CrossProviderIdentityCandidate {
  return {
    scopeId: 'user-1',
    candidateId,
    entityKind: 'external_task',
    provider: 'todoist',
    connectionId: 'connection-1',
    externalId: candidateId,
    canonicalId: null,
    title: 'Submit final report',
    dueAt: DUE,
    owner: 'Anas',
    references: [],
    observedAt: NOW,
    ...overrides,
  };
}

function reference(
  namespace: string,
  value: string,
  trust: IdentityReference['trust'] = 'system_asserted',
): IdentityReference {
  return { namespace, value, trust };
}

test('the same provider object is the same identity and receives a deterministic link key', () => {
  const left = candidate('todoist-copy-a', { externalId: 'task-42' });
  const right = candidate('todoist-copy-b', { externalId: 'task-42' });
  const first = decideCrossProviderIdentity(left, right);
  const second = decideCrossProviderIdentity(right, left);
  assert.equal(first.confidence, 'high');
  assert.equal(first.resolution, 'link');
  assert.deepEqual(first.reasons, ['same_provider_object']);
  assert.match(first.linkKey ?? '', /^identity-link:[a-f0-9]{64}$/);
  assert.deepEqual(first, second);
});

test('an explicit canonical id links Gmail context and a Todoist task across providers', () => {
  const mail = candidate('mail-1', {
    entityKind: 'email', provider: 'google', connectionId: 'gmail-1', externalId: 'message-1',
    canonicalId: 'commitment-9',
  });
  const task = candidate('task-1', { canonicalId: 'commitment-9' });
  const result = decideCrossProviderIdentity(mail, task);
  assert.equal(result.confidence, 'high');
  assert.equal(result.resolution, 'link');
  assert.deepEqual(result.reasons, ['same_canonical_id']);
});

test('a system provenance reference links an Outlook message to its derived meeting proposal', () => {
  const sourceRef = reference('rfc822_message', '<message-9@example.test>');
  const mail = candidate('outlook-mail', {
    entityKind: 'email', provider: 'microsoft', references: [sourceRef],
  });
  const proposal = candidate('meeting-proposal', {
    entityKind: 'meeting_proposal', provider: 'teams', connectionId: 'teams-1',
    references: [sourceRef],
  });
  const result = decideCrossProviderIdentity(mail, proposal);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.reasons, ['shared_system_reference']);
});

test('an identity claim inside untrusted email or transcript content is inert', () => {
  const injected = reference('canonical_commitment', 'commitment-7', 'untrusted_content_claim');
  const mail = candidate('gmail-injection', {
    entityKind: 'email', provider: 'google', references: [injected], dueAt: null, owner: null,
  });
  const commitment = candidate('commitment-7', {
    entityKind: 'commitment', provider: 'maybesitter', connectionId: null, externalId: null,
    references: [reference('canonical_commitment', 'commitment-7')], dueAt: null, owner: null,
  });
  const result = decideCrossProviderIdentity(mail, commitment);
  assert.equal(result.confidence, 'low');
  assert.equal(result.resolution, 'preserve_separate');
  assert.deepEqual(result.reasons, ['same_title_only']);
});

test('matching title, due time, and owner suggests a merge but never links silently', () => {
  const todoist = candidate('todoist-1');
  const notion = candidate('notion-1', {
    provider: 'notion', connectionId: 'notion-1', externalId: 'page-8',
  });
  const result = decideCrossProviderIdentity(todoist, notion);
  assert.equal(result.confidence, 'medium');
  assert.equal(result.resolution, 'suggest_merge');
  assert.equal(result.linkKey, null);
  assert.deepEqual(result.reasons, ['same_title_due_owner']);
});

test('blank provider identifiers never become shared high-confidence identity', () => {
  const left = candidate('left', { connectionId: '', externalId: '' });
  const right = candidate('right', { connectionId: '', externalId: '' });
  const result = decideCrossProviderIdentity(left, right);
  assert.equal(result.confidence, 'medium');
  assert.equal(result.resolution, 'suggest_merge');
  assert.equal(result.linkKey, null);
});

test('same title and deadline with conflicting owners remains separate', () => {
  const mine = candidate('mine', { owner: 'Anas' });
  const theirs = candidate('theirs', { provider: 'notion', owner: 'Someone else' });
  const result = decideCrossProviderIdentity(mine, theirs);
  assert.equal(result.confidence, 'low');
  assert.equal(result.resolution, 'preserve_separate');
});

test('matching titles without a shared deadline are low confidence collision evidence', () => {
  const task = candidate('task', { dueAt: null, owner: null });
  const meeting = candidate('meeting', {
    entityKind: 'meeting_proposal', provider: 'zoom', dueAt: DUE, owner: null,
  });
  const result = decideCrossProviderIdentity(task, meeting);
  assert.equal(result.confidence, 'low');
  assert.equal(result.resolution, 'preserve_separate');
  assert.deepEqual(result.reasons, ['same_title_only']);
});

test('different canonical ids override fuzzy content matches', () => {
  const left = candidate('left', { canonicalId: 'commitment-a' });
  const right = candidate('right', { provider: 'notion', canonicalId: 'commitment-b' });
  const result = decideCrossProviderIdentity(left, right);
  assert.equal(result.confidence, 'none');
  assert.equal(result.resolution, 'preserve_separate');
  assert.deepEqual(result.reasons, ['conflicting_canonical_ids']);
});

test('identical provider ids and references never link across accounts', () => {
  const left = candidate('left', {
    scopeId: 'user-a', externalId: 'shared-id', references: [reference('calendar_uid', 'uid-7')],
  });
  const right = candidate('right', {
    scopeId: 'user-b', externalId: 'shared-id', references: [reference('calendar_uid', 'uid-7')],
  });
  const result = decideCrossProviderIdentity(left, right);
  assert.equal(result.confidence, 'none');
  assert.deepEqual(result.reasons, ['different_scope']);
});

test('Unicode compatibility and whitespace normalization support suggestions without erasing punctuation', () => {
  const left = candidate('left', { title: 'Submit   final report' });
  const right = candidate('right', { provider: 'notion', title: '\uFF33ubmit final report' });
  const punctuationCollision = candidate('punctuation', { provider: 'microsoft', title: 'Submit final report!' });
  assert.equal(decideCrossProviderIdentity(left, right).confidence, 'medium');
  assert.equal(decideCrossProviderIdentity(left, punctuationCollision).confidence, 'none');
});

test('pairwise decisions do not create transitive auto-merges from ambiguous content', () => {
  const decisions = decideCrossProviderIdentitySet([
    candidate('gmail', { entityKind: 'email', provider: 'google' }),
    candidate('notion', { provider: 'notion', connectionId: 'notion-1' }),
    candidate('todoist'),
  ]);
  assert.equal(decisions.length, 3);
  assert.equal(decisions.every((entry) => entry.resolution === 'suggest_merge'), true);
  assert.equal(decisions.every((entry) => entry.linkKey === null), true);
});

test('decision output contains identifiers and reason codes but no private titles', () => {
  const result = decideCrossProviderIdentity(
    candidate('a', { title: 'Private medical appointment' }),
    candidate('b', { provider: 'notion', title: 'Private medical appointment' }),
  );
  assert.equal(JSON.stringify(result).includes('medical'), false);
});

test('duplicate candidate ids and malformed timestamps fail closed', () => {
  assert.throws(
    () => decideCrossProviderIdentitySet([candidate('same'), candidate('same', { provider: 'notion' })]),
    /must be unique/,
  );
  assert.throws(
    () => decideCrossProviderIdentity(candidate('valid'), candidate('bad-time', { dueAt: 'tomorrow' })),
    /dueAt must be an instant/,
  );
});

test('the boundary owns no persistence, provider mutation, planner mutation, or ambiguous auto-merge', () => {
  assert.deepEqual(CROSS_PROVIDER_IDENTITY_POLICY, {
    ambiguousAutoMergeAllowed: false,
    untrustedContentCanAssertIdentity: false,
    crossAccountLinkingAllowed: false,
    persistenceOwnedHere: false,
    providerMutationAllowed: false,
    plannerMutationAllowed: false,
  });
});
