import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_CONSENT_CLAIMS_V1,
  CONTEXT_ENRICHMENT_CONSENT_CLAIMS_V1,
  CONTEXT_ENRICHMENT_CONSENT_VERSION,
  contextEnrichmentConsentClaimsDigest,
  isSupportedContextEnrichmentConsentVersion,
} from '../../src/contracts/v1/consentContracts.ts';
import {
  USER_CONTEXT_LIMITS,
  USER_CONTEXT_SCHEMA_VERSION,
  USER_CONTEXT_SOURCES,
} from '../../src/contracts/v1/userContextContracts.ts';
import { INTELLIGENCE_MODULE_CONTRACTS } from '../../src/contracts/v1/moduleContracts.ts';

test('context enrichment has an independent pinned consent contract', () => {
  assert.equal(CONTEXT_ENRICHMENT_CONSENT_VERSION, 'context-enrichment-consent-v1');
  assert.equal(isSupportedContextEnrichmentConsentVersion(CONTEXT_ENRICHMENT_CONSENT_VERSION), true);
  assert.equal(isSupportedContextEnrichmentConsentVersion('ai-consent-v1'), false);
  assert.equal(contextEnrichmentConsentClaimsDigest(), 'e50a37b899549be9');

  const claims = CONTEXT_ENRICHMENT_CONSENT_CLAIMS_V1.join('\n');
  assert.match(claims, /busy_intervals_only,no_titles,no_details,no_attendees/);
  assert.match(claims, /one_shot_scan_only,no_recurring_sync/);
  assert.match(claims, /user_selected_file_only,no_unselected_files/);
  assert.match(claims, /oauth_tokens,authorization_headers,credentials/);
  assert.match(claims, /proposal_only/);

  assert.match(AI_CONSENT_CLAIMS_V1.join('\n'), /what_is_not_sent:.*calendar/);
});

test('context schema has bounded source-specific sections', () => {
  assert.equal(USER_CONTEXT_SCHEMA_VERSION, 'user-context-v1');
  assert.deepEqual(USER_CONTEXT_SOURCES, [
    'memory',
    'goal',
    'commitment',
    'calendar_busy',
    'gmail',
    'drive',
    'share',
  ]);
  assert.deepEqual(USER_CONTEXT_LIMITS, {
    memories: 12,
    goals: 8,
    commitments: 16,
    busyBlocks: 48,
    externalReferences: 20,
    memoryCodePoints: 200,
    commitmentTitleCodePoints: 120,
    maxTextCodePoints: 6000,
  });

  const maximumProjectedText =
    USER_CONTEXT_LIMITS.memories * USER_CONTEXT_LIMITS.memoryCodePoints
    + USER_CONTEXT_LIMITS.goals * USER_CONTEXT_LIMITS.memoryCodePoints
    + USER_CONTEXT_LIMITS.commitments * USER_CONTEXT_LIMITS.commitmentTitleCodePoints;
  assert.ok(maximumProjectedText <= USER_CONTEXT_LIMITS.maxTextCodePoints);
});

test('the context enrichment module descriptor points at this schema and pure builder', async () => {
  const result = await INTELLIGENCE_MODULE_CONTRACTS.contextEnrichment.execute({
    scopeId: 'scope',
    input: {},
    provenance: {
      traceId: 'trace',
      producedAt: '2026-09-29T12:00:00.000Z',
      source: 'system',
      confidence: null,
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.output, {
      status: 'implemented',
      module: 'contextEnrichment',
      schemaVersion: USER_CONTEXT_SCHEMA_VERSION,
      entryPoint: 'lib/userContext/buildUserContextSnapshot#buildUserContextSnapshot',
    });
  }
});
