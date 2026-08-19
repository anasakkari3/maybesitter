/**
 * The Sprint 06 decomposition dataset and evaluator (issue #26).
 *
 * Four modules, in the order a caller uses them:
 *
 *  - `corpus`  — load the shipped examples, queue them for review, ingest what
 *                comes back, and check that any row claiming human review has a
 *                reviewer behind it.
 *  - `splits`  — assign each example to train / valid / locked-test by a digest
 *                of its id, and seal the result with a checksum.
 *  - `example` — validate one labelled example against the shared violation
 *                vocabulary #27's validator also speaks.
 *  - `metrics` — boundary, coverage and semantic-faithfulness scores, each
 *                reported with the denominator it was computed over.
 *
 * Nothing here imports a test fixture. The golden set lives under `tests/` and
 * is ground truth the evaluator is *exercised* against, not data it depends on:
 * a production module that cannot start without a test file is a production
 * module that ships its tests.
 *
 * **Every row this package ships is `provenance: 'synthetic'` and the reviewed
 * corpus is empty.** The pipeline is real and exercised; nothing in it has been
 * reviewed by a person, and no score computed from the seed corpus is evidence
 * about model quality. See `docs/data/decomposition-annotation-guide.md`.
 */
export * from './corpus';
export * from './example';
export * from './metrics';
export * from './splits';
