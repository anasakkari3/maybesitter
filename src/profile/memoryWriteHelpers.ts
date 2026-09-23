/**
 * The two things every "turn a validated suggestion into a memory record" path
 * needs, in one place.
 *
 * Both were private to `profileDescribeService`. A second caller — the AI
 * context import — needs exactly the same two behaviours, and a copy of
 * `languageOf` is a copy that drifts: the moment one of them learns about a
 * fourth script the other is silently wrong about it. This is a move, not a
 * change; describe imports them from here now.
 */
import type { CreateMemoryInput, MemoryLanguage } from '../contracts/v1/memoryContracts';

/** The script the content is written in. Not the user's locale — the text's. */
export function languageOf(content: string): MemoryLanguage {
  const arabic = /[؀-ۿ]/.test(content);
  const hebrew = /[֐-׿]/.test(content);
  const latin = /[A-Za-z]/.test(content);
  if (arabic && !hebrew && !latin) return 'ar';
  if (hebrew && !arabic && !latin) return 'he';
  if (latin && !arabic && !hebrew) return 'en';
  return 'mixed';
}

/**
 * Drops the keys whose value is `undefined`, provenance included.
 *
 * The store's validator distinguishes "absent" from "present and undefined" —
 * `assertValidProvenance` throws on a `model` key even when its value is
 * undefined — so an optional field has to be removed rather than blanked.
 */
export function stripUndefined(input: CreateMemoryInput): CreateMemoryInput {
  const provenance = input.provenance
    ? Object.fromEntries(Object.entries(input.provenance).filter(([, v]) => v !== undefined))
    : undefined;
  const entries = Object.entries({ ...input, provenance }).filter(([, v]) => v !== undefined);
  return Object.fromEntries(entries) as unknown as CreateMemoryInput;
}
