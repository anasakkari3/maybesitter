/**
 * Where a piece of personal state came from, kept as data.
 *
 * The product invariant is "an inference must never silently become a user
 * fact". Nothing in this file is a prompt string, and that is deliberate: a
 * prompt can be injected, and an injected prompt that talks a model into
 * relabelling its own guess as a fact would defeat the whole boundary. The
 * label is decided by the caller's declared source and changed by exactly one
 * function, below.
 */

/**
 * Listed once, at runtime, with the type derived from the list — so a class
 * cannot be added to the type and forgotten by the code that enumerates them.
 */
export const PROVENANCE_VALUES = [
  'FACT',
  'PREFERENCE',
  'GOAL',
  'CONSTRAINT',
  'OBSERVATION',
  'INFERENCE',
] as const;

export type Provenance = (typeof PROVENANCE_VALUES)[number];

export interface PersonalStateEntry {
  id: string;
  key: string;
  value: string;
  provenance: Provenance;
  confidence: number;
  createdAt: string;
}

/** What produced the value. Each source maps to exactly one provenance. */
export type EntrySource =
  | 'model'
  | 'behaviour'
  | 'user_explicit'
  | 'user_preference'
  | 'user_goal'
  | 'user_constraint';

/**
 * The six classes are six different kinds of claim, not six confidence tiers.
 * Collapsing any pair would lose the distinction the rest of the system
 * dispatches on — a CONSTRAINT bounds the scheduler, a GOAL does not.
 */
const PROVENANCE_BY_SOURCE: Record<EntrySource, Provenance> = {
  model: 'INFERENCE',
  behaviour: 'OBSERVATION',
  user_explicit: 'FACT',
  user_preference: 'PREFERENCE',
  user_goal: 'GOAL',
  user_constraint: 'CONSTRAINT',
};

/**
 * The two classes that are the system's own provisional claim about the user,
 * and therefore the only ones a user confirmation can promote.
 *
 * INFERENCE is what a model guessed; OBSERVATION is what the person's own
 * behaviour showed. Both say "we think this is true of you", so the user
 * saying "yes, it is" resolves them the same way.
 */
const PROMOTABLE: readonly Provenance[] = ['INFERENCE', 'OBSERVATION'];

function isProvenance(value: unknown): value is Provenance {
  return (PROVENANCE_VALUES as readonly unknown[]).includes(value);
}

/**
 * Provenance is decided by where the value came from, never by how sure the
 * model sounded. A model-produced value is an INFERENCE at 0.99 exactly as
 * much as at 0.4.
 */
export function createEntry(input: {
  id: string;
  key: string;
  value: string;
  source: EntrySource;
  confidence: number;
  now: Date;
}): PersonalStateEntry {
  return {
    id: input.id,
    key: input.key,
    value: input.value,
    provenance: PROVENANCE_BY_SOURCE[input.source],
    confidence: input.confidence,
    createdAt: input.now.toISOString(),
  };
}

/**
 * The only route into FACT.
 *
 * Two rules, both enforced here rather than in a prompt:
 *
 *  1. Confidence is not consent. Nothing promotes without `confirmedByUser`,
 *     at any confidence.
 *  2. Only a provisional class promotes. A confirmed PREFERENCE, GOAL or
 *     CONSTRAINT keeps its class: those are not weaker facts awaiting
 *     upgrade, they are different kinds of statement, and relabelling one
 *     "FACT" would silently discard the meaning the planner reads. FACT is
 *     already a fact, so confirming it is a no-op. This is a decision, not an
 *     omission — raising a confirmed constraint's certainty, if that is ever
 *     wanted, belongs in its own operation with its own name.
 *
 * The entry is returned as a new object; the stored one is never edited in
 * place, so a caller that ignores the result has not changed anything.
 */
export function promoteToFact(
  entry: PersonalStateEntry,
  confirmedByUser: boolean,
): PersonalStateEntry {
  if (!confirmedByUser) return entry;
  if (!PROMOTABLE.includes(entry.provenance)) return entry;
  return { ...entry, provenance: 'FACT', confidence: 1 };
}

/**
 * Everything the user may inspect, each tagged with where it came from.
 *
 * Entries come back from storage as JSON, where the union type no longer
 * exists. An entry whose provenance we cannot recognise is shown as an
 * INFERENCE — the weakest claim — because displaying an unverifiable origin as
 * a fact is the exact failure this module exists to prevent. Copies are
 * returned so editing what was displayed cannot write back into the store.
 */
export function sendableToUser(
  entries: PersonalStateEntry[],
): PersonalStateEntry[] {
  return entries.map((entry) => ({
    id: entry.id,
    key: entry.key,
    value: entry.value,
    provenance: isProvenance(entry.provenance) ? entry.provenance : 'INFERENCE',
    confidence: entry.confidence,
    createdAt: entry.createdAt,
  }));
}
