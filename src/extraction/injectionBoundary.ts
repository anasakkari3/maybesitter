import { detectPromptInjection } from './ollamaExtractor';

/**
 * The single injection boundary every model call passes through.
 *
 * It used to be inline in the local path only, which meant a second model
 * call added later would route around it. It sits in its own module so the
 * boundary has one name and one import that every call site -- the extraction
 * service, the arbiter, the dialect eval harness -- reaches the same way, and
 * so that adding a caller is a visible act rather than a copied regex.
 *
 * @returns the name of the pattern that matched, or null when the text is clean.
 */
export function screenForInjection(rawText: string): string | null {
  return detectPromptInjection(rawText);
}
