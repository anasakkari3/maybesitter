/**
 * The Sprint 09 coaching tone and faithfulness evaluation set (issue #37).
 *
 * Three modules, in the order a caller uses them:
 *
 *  - `rubric`        — the dimensions, the lexicons and `evaluateRubric`, whose
 *                      verdict carries a tone score on **one variant only**.
 *                      Faithfulness is a separate gate from tone, structurally:
 *                      a turn that says something the recommendation did not is
 *                      never assigned a tone score at all.
 *  - `evaluationSet` — the corpus. Authored adversarial rows across three
 *                      locales, a seeded generator, lock state derived from each
 *                      row's id, and the typed partition that keeps locked rows
 *                      out of tuning.
 *  - `scoring`       — the automated scorer, its report, and the typed slot where
 *                      human scores merge in later.
 *
 * **No copyrighted, private or real conversation data is used.** Every sentence
 * in every locale was authored for this package; every generated row is a seeded
 * recombination of those authored parts. There is no file read, no fixture and
 * no network call anywhere under `lib/coaching/`, and
 * `tests/coaching/rubric.test.ts` scans for all three.
 *
 * **Nothing here is reviewed.** `AnnotationProvenance` has one member and
 * `CorpusReviewStatus` has one member, so the claim cannot be made by editing a
 * string. Every tone figure the automated scorer produces is a lexical proxy and
 * says so in `automatedIsProxy`; the faithfulness figures are not proxies. See
 * `docs/data/coaching-evaluation-set.md`.
 */
export * from './rubric';
export * from './evaluationSet';
export * from './scoring';
