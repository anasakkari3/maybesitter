import { stripTimeExpressions } from './ruleBasedExtractor';
import { withoutLeadingConsideration } from './unresolvedIntent';

const LEADING_CONNECTIVE = new RegExp(
  '^(?:إني|إنّي|اني|إنو|انو|إنه|انه|if\\s+i\\s+should|about|to)(?=$|[\\s\\p{P}])',
  'iu',
);

function withoutLeadingConnective(text: string): string {
  const match = LEADING_CONNECTIVE.exec(text);
  if (!match) return text;
  const stripped = text.slice(match[0].length).replace(/^[\s,:;.!?؟،\-–—]+/, '').trim();
  return stripped || text;
}

/** The thought's words after only its leading doubt phrase and connective. */
export function withoutLeadingThoughtLeadIn(rawText: string): string {
  const original = rawText.trim();
  const withoutConsideration = withoutLeadingConsideration(original);
  return (withoutConsideration === original
    ? withoutConsideration
    : withoutLeadingConnective(withoutConsideration)).trim();
}

/**
 * The title used only when a thought becomes a commitment without replacement
 * words from the person. Doubt comes from the unresolved-intent detector's
 * own phrases; timing comes from the ordinary commitment title cleaner.
 */
export function thoughtCommitmentTitle(
  rawText: string,
  options: { separatedTime?: boolean } = {},
): string {
  const original = rawText.trim();
  let title = withoutLeadingThoughtLeadIn(original);
  if (options.separatedTime) title = stripTimeExpressions(title);
  return title.trim() || original;
}
