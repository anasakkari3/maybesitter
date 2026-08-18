/**
 * Shadow comparison (Sprint 05, issue #23).
 *
 * A read-only surface. Everything exported here returns a value; nothing here
 * writes, and `tests/priority/shadowBoundaries.test.ts` walks the transitive
 * import closure to keep it that way.
 */
export { derivePolicy, policyDelta, WEIGHT_FEATURES } from './candidatePolicy';
export type { PolicyDelta, PolicyPerturbation, PolicyWeightKey, WeightedFeatureName } from './candidatePolicy';
export { isSampled, sampleFraction, selectSample, validateSamplingConfig } from './shadowSampling';
export { buildShadowComparisonReport, generateShadowComparisonMarkdown } from './shadowComparison';
export type { ShadowComparisonInput, ShadowSubject } from './shadowComparison';
