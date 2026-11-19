/**
 * `recommendationGrantedIn` answers exactly what `getRecommendationConsent`
 * answers, from a user document already read (review of #873). The Gmail
 * proposal step reads it inside its transaction; a disagreement would let a
 * model call or a stored suggestion through after «وقّف».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage';
import {
  getRecommendationConsent,
  recommendationGrantedIn,
  RECOMMENDATION_CONSENT_VERSION,
} from '../../lib/consents/recommendationConsentService';

const cases: Array<[string, unknown]> = [
  ['no user document', null],
  ['an empty document', {}],
  ['no consents', { consents: {} }],
  ['granted at the current version', { consents: { recommendations: { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION } } }],
  ['granted at an old version', { consents: { recommendations: { state: 'granted', version: 'v0' } } }],
  ['granted with no version', { consents: { recommendations: { state: 'granted' } } }],
  ['declined', { consents: { recommendations: { state: 'declined', version: RECOMMENDATION_CONSENT_VERSION } } }],
  ['a state that is not a string', { consents: { recommendations: { state: 5, version: RECOMMENDATION_CONSENT_VERSION } } }],
  ['a record that is a string', { consents: { recommendations: 'granted' } }],
  ['consents that are a string', { consents: 'x' }],
  ['only another question answered', { consents: { personalization: { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION } } }],
];

for (const [name, user] of cases) {
  test(`recommendationGrantedIn agrees with getRecommendationConsent: ${name}`, async () => {
    const storage = createMemoryStorage();
    if (user !== null) await storage.set('users/parity-user', user as never);
    const read = (await getRecommendationConsent('parity-user', { storage })) === 'granted';
    assert.equal(recommendationGrantedIn(user), read);
  });
}

test('only a granted answer at the current version is a yes', () => {
  assert.equal(recommendationGrantedIn({ consents: { recommendations: { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION } } }), true);
  assert.equal(recommendationGrantedIn({ consents: { recommendations: { state: 'granted', version: 'v0' } } }), false);
});
