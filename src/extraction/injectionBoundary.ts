import { detectPromptInjection } from './ollamaExtractor';

/**
 * The single injection boundary every model call passes through.
 *
 * It used to be inline in the local path only, which meant a second model
 * call added later would route around it. It sits in its own module because
 * both the extraction service and the arbiter import it, and the service
 * imports the arbiter's types -- putting it in either would cycle.
 *
 * @returns the name of the pattern that matched, or null when the text is clean.
 */
export function screenForInjection(rawText: string): string | null {
  return detectPromptInjection(rawText);
}
