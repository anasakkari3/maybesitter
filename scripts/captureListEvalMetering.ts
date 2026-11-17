/**
 * Whether the capture list eval has lost sight of its spend (B3 review).
 *
 * `scripts/run-capture-list-eval.ts` prices each model call from the
 * product's content-free `llm_call` log line. A case the model answered with
 * no such line seen means the line changed shape — and every later case would
 * read as free, so the spend cap could never trip. The run stops there.
 */
export function meteringLost(input: {
  engine: 'rules' | 'model';
  /** `llm_call` lines seen while the case ran. */
  callsSeen: number;
  /** The proposal's `provenance.executedEngine`, or null when there is none. */
  executedEngine: string | null;
}): boolean {
  if (input.engine !== 'model' || input.callsSeen > 0) return false;
  return input.executedEngine !== null && input.executedEngine !== 'rule-based';
}
