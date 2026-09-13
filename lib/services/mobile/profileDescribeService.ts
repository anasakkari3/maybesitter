/**
 * Turning a self-description into suggestions, and suggestions into memory
 * (UC-2.7b, #168).
 *
 * ── The raw text is never stored ─────────────────────────────────
 *
 * Not in a proposal, not in an audit line, not in a log. It reaches the
 * injection guard, reaches the model, and is gone when the request ends. What
 * is kept for thirty minutes is the *suggestions* — short neutral phrases the
 * user is about to be shown and asked about.
 *
 * That is a deliberate cost: a user who reloads the review screen after the
 * TTL has to describe themselves again, because there is nothing to re-derive
 * from. The alternative is a paragraph about somebody's life sitting in a
 * database because it was convenient.
 *
 * ── Nothing is written until they tick a box ─────────────────────
 *
 * `describe` writes no memory record. `confirm` writes exactly the ones named
 * in `accepted`, and the store itself refuses a `model_inferred` record with
 * no `confirmedByUserAt` — so "nothing persists without explicit confirmation"
 * is enforced a layer below this file as well as in it.
 *
 * ── An edit makes it theirs ──────────────────────────────────────
 *
 * A suggestion the user changed is stored as `user_stated`, not
 * `model_inferred`. Once somebody has corrected a sentence about themselves,
 * the sentence is theirs — and the difference is visible on the memory screen
 * as a different provenance chip.
 */
import { randomUUID } from 'node:crypto';
import {
  MAX_DESCRIPTION_LENGTH,
  PROFILE_PROMPT_VERSION,
  PROFILE_PROPOSAL_TTL_MS,
  type ProfileProposal,
  type ProfileSuggestion,
} from '../../../src/profile/profileContracts';
import { buildProfilePrompt } from '../../../src/profile/profilePrompt';
import { validateProfileSuggestions } from '../../../src/profile/profileSuggestionValidator';
import { detectPromptInjection } from '../../../src/extraction/ollamaExtractor';
import { captureLlmProvider } from '../../llm/captureProvider';
import { createStorageRuntimeMemoryStore } from '../../runtimeMemory/runtimeMemoryStore';
import { createPilotAuditEvent } from '../../pilot/closedPilotControls';
import { appendAudit } from '../../pilot/pilotTrustStore';
import {
  PROFILE_PROPOSALS,
  getStorage,
  requireDocId,
  requireUserId,
  userCol,
  type StorageAdapter,
} from '../../storage';
import {
  USER_STATED_MEMORY_TTL_MS,
  type CreateMemoryInput,
  type MemoryLanguage,
  type RuntimeMemoryStore,
} from '../../../src/contracts/v1/memoryContracts';

export class DescriptionTooLongError extends Error {
  constructor() {
    super(`a description may be at most ${MAX_DESCRIPTION_LENGTH} characters`);
    this.name = 'DescriptionTooLongError';
  }
}

export class ProposalNotFoundError extends Error {
  constructor() {
    super('proposal not found');
    this.name = 'ProposalNotFoundError';
  }
}

export interface DescribeOptions {
  storage?: StorageAdapter;
  memory?: RuntimeMemoryStore;
  /** Injected so a test can drive the model without one. */
  complete?: (prompt: string) => Promise<string>;
}

interface StoredProposal {
  proposalId: string;
  suggestions: ProfileSuggestion[];
  createdAt: string;
  promptVersion: string;
  model: string | null;
}

function storageOf(options: DescribeOptions): StorageAdapter {
  return options.storage ?? getStorage();
}

function proposalPath(uid: string, proposalId: string): string {
  return `${userCol(uid, PROFILE_PROPOSALS)}/${requireDocId(proposalId)}`;
}

/**
 * Reads a description and proposes what it might mean.
 *
 * Returns an empty list rather than throwing when the guard fires or the model
 * gives nothing usable: "we found nothing to suggest" is a normal outcome of
 * describing yourself, and the screen shows it as one.
 */
export async function describeProfile(
  uid: string,
  text: string,
  at: Date,
  options: DescribeOptions = {},
): Promise<ProfileProposal> {
  requireUserId(uid);
  if (typeof text !== 'string') throw new DescriptionTooLongError();
  const description = text.trim();
  if (Array.from(description).length > MAX_DESCRIPTION_LENGTH) throw new DescriptionTooLongError();

  const proposal: StoredProposal = {
    proposalId: randomUUID(),
    suggestions: [],
    createdAt: at.toISOString(),
    promptVersion: PROFILE_PROMPT_VERSION,
    model: process.env.MAYBESITTER_LLM_MODEL ?? null,
  };

  // The guard first, before a single token is sent. An injection attempt is
  // not a description of anybody, and paying for it would be paying to be
  // attacked.
  if (description === '' || detectPromptInjection(description)) {
    await save(uid, proposal, options);
    return freeze(proposal);
  }

  const complete = options.complete ?? captureLlmProvider(uid, { purpose: 'profile_extraction' });

  let raw: unknown;
  try {
    raw = JSON.parse(await complete(buildProfilePrompt(description)));
  } catch {
    // No model, no consent, over the cap, or a malformed answer. All of them
    // mean the same thing to the user: nothing to suggest. The consent refusal
    // is surfaced by the route, which asks before calling this.
    await save(uid, proposal, options);
    return freeze(proposal);
  }

  const suggestions = validateProfileSuggestions(
    (raw as { suggestions?: unknown })?.suggestions,
    { now: at },
  ).suggestions;

  proposal.suggestions = [...suggestions];
  await save(uid, proposal, options);
  return freeze(proposal);
}

async function save(uid: string, proposal: StoredProposal, options: DescribeOptions): Promise<void> {
  await storageOf(options).set<StoredProposal>(proposalPath(uid, proposal.proposalId), proposal);
}

function freeze(proposal: StoredProposal): ProfileProposal {
  return Object.freeze({
    proposalId: proposal.proposalId,
    suggestions: Object.freeze([...proposal.suggestions]),
    createdAt: proposal.createdAt,
    promptVersion: proposal.promptVersion,
    model: proposal.model,
  });
}

export interface AcceptedSuggestion {
  index: number;
  /** The user's edit. When present it replaces the content and the source. */
  content?: string;
}

export interface ConfirmResult {
  saved: number;
  kinds: Record<string, number>;
}

/**
 * Writes the suggestions the user ticked, and nothing else.
 *
 * An index the proposal does not have is ignored rather than refused: the
 * screen and the store can disagree only if the proposal expired underneath
 * the user, and failing the whole save because one row went stale would lose
 * the four they did tick.
 */
export async function confirmProfileSuggestions(
  uid: string,
  proposalId: string,
  accepted: readonly AcceptedSuggestion[],
  at: Date,
  options: DescribeOptions = {},
): Promise<ConfirmResult> {
  requireUserId(uid);
  const storage = storageOf(options);
  const stored = await storage.get<StoredProposal>(proposalPath(uid, proposalId));
  if (!stored) throw new ProposalNotFoundError();

  // Expired proposals are refused, not silently written. The suggestions were
  // shown half an hour ago; the user may have forgotten what they said yes to.
  const age = at.getTime() - Date.parse(stored.createdAt);
  if (!Number.isFinite(age) || age > PROFILE_PROPOSAL_TTL_MS) throw new ProposalNotFoundError();

  const memory = options.memory ?? createStorageRuntimeMemoryStore(undefined, options.storage);
  const isoAt = at.toISOString();
  const kinds: Record<string, number> = {};
  let saved = 0;

  for (const choice of accepted ?? []) {
    const suggestion = stored.suggestions[choice.index];
    if (!suggestion) continue;

    const edited = typeof choice.content === 'string' ? choice.content.trim() : '';
    const useEdit = edited !== '' && edited !== suggestion.content;
    const content = useEdit ? edited : suggestion.content;

    const input: CreateMemoryInput = {
      scopeId: uid,
      kind: suggestion.kind,
      content,
      language: languageOf(content),
      // Once somebody has corrected a sentence about themselves, it is theirs.
      source: useEdit ? 'user_stated' : 'model_inferred',
      confidence: useEdit ? 1 : suggestion.confidence,
      observedAt: isoAt,
      ttlMs: useEdit ? USER_STATED_MEMORY_TTL_MS : undefined,
      provenance: {
        origin: 'self_description',
        originRef: proposalId,
        ...(useEdit ? {} : { model: stored.model ?? undefined }),
        promptVersion: stored.promptVersion,
        // Required by the store for anything `model_inferred`, and true for
        // both branches: the user ticked this box.
        confirmedByUserAt: isoAt,
      },
    };
    await memory.put(stripUndefined(input), isoAt);
    saved += 1;
    kinds[suggestion.kind] = (kinds[suggestion.kind] ?? 0) + 1;
  }

  // The proposal has done its job. Removing it is also the cheapest way to
  // guarantee a second confirm cannot write the same facts twice.
  await storage.delete(proposalPath(uid, proposalId));

  // Counts and kinds only. What the facts said is not in the audit trail.
  await appendAudit(createPilotAuditEvent({
    version: 'v1',
    eventType: 'profile_updated',
    participantId: uid,
    occurredAt: isoAt,
    outcome: 'recorded',
    reasonCode: `memory_facts_confirmed_${saved}`,
  }));

  return { saved, kinds };
}

/** The script the content is written in. Not the user's locale — the text's. */
function languageOf(content: string): MemoryLanguage {
  const arabic = /[؀-ۿ]/.test(content);
  const hebrew = /[֐-׿]/.test(content);
  const latin = /[A-Za-z]/.test(content);
  if (arabic && !hebrew && !latin) return 'ar';
  if (hebrew && !arabic && !latin) return 'he';
  if (latin && !arabic && !hebrew) return 'en';
  return 'mixed';
}

function stripUndefined(input: CreateMemoryInput): CreateMemoryInput {
  const provenance = input.provenance
    ? Object.fromEntries(Object.entries(input.provenance).filter(([, v]) => v !== undefined))
    : undefined;
  const entries = Object.entries({ ...input, provenance }).filter(([, v]) => v !== undefined);
  return Object.fromEntries(entries) as unknown as CreateMemoryInput;
}
