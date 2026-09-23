/**
 * Bringing in a profile another AI assistant wrote about the user.
 *
 * ── The paste is never stored ────────────────────────────────────
 *
 * Not in the proposal, not in an audit line, not in a log. It reaches the
 * injection guard, reaches the model, and is gone when the request ends. What
 * is kept for thirty minutes is the *candidates* — short sentences the user is
 * about to be shown — plus the index of records they may relate to. The
 * alternative is somebody's whole life summary, written by another company's
 * model, sitting in a database because it was convenient.
 *
 * ── Its own collection, not `profileProposals` ───────────────────
 *
 * Sharing that collection would cost no registry edits and would make the two
 * proposal kinds interchangeable by id: `confirmProfileSuggestions` would read
 * an import document quite happily, write every candidate with
 * `origin: 'self_description'`, and ignore every relation. Adding a
 * discriminator to describe's confirm to prevent that is a change to a shipped
 * path in service of a new one.
 *
 * ── The relation is re-resolved at write time ────────────────────
 *
 * The proposal names records by index and lives for half an hour. In that time
 * another device can revoke a record, supersede it, or the user can delete it
 * from the memory screen. So the target is fetched again at the moment of
 * writing, and anything that is no longer this user's active record becomes a
 * plain write. Honouring a half-hour-old relation is how an import overwrites
 * something the user had meanwhile fixed by hand.
 *
 * ── A conflict is not a licence to delete ───────────────────────
 *
 * The model saying two sentences cannot both be true is a model's opinion about
 * a fact a human confirmed. Unless the user chose `replace`, both survive.
 */
import { randomUUID } from 'node:crypto';
import { createPilotAuditEvent } from '../../pilot/closedPilotControls';
import { appendAudit } from '../../pilot/pilotTrustStore';
import { shareLlmProvider, type ShareStructuredGenerator } from '../../llm/shareProvider';
import { MAX_INPUT_CHARACTERS } from '../../llm/usageGuard';
import { createStorageRuntimeMemoryStore } from '../../runtimeMemory/runtimeMemoryStore';
import {
  AI_CONTEXT_IMPORTS,
  getStorage,
  requireDocId,
  requireUserId,
  userCol,
  userDoc,
  type StorageAdapter,
} from '../../storage';
import { toVertexSchema } from '../../../src/extraction/llm/vertexSchema';
import { detectPromptInjection } from '../../../src/extraction/ollamaExtractor';
import {
  AI_CONTEXT_IMPORT_TTL_MS,
  MAX_EXISTING_MEMORY_RECORDS,
  MAX_IMPORT_LENGTH,
  AI_CONTEXT_IMPORT_PROMPT_VERSION,
  type AiContextImportProposal,
  type ImportAssistant,
  type ImportCandidate,
  type ImportSummary,
  type RawImportCandidate,
} from '../../../src/profile/aiContextImportContracts';
import { AI_CONTEXT_IMPORT_SCHEMA, buildAiContextImportPrompt } from '../../../src/profile/aiContextImportPrompt';
import { normalizeForComparison, validateImportCandidates } from '../../../src/profile/importCandidateValidator';
import { languageOf, stripUndefined } from '../../../src/profile/memoryWriteHelpers';
import { splitPrompt } from '../../llm/captureProvider';
import { USER_STATED_MEMORY_TTL_MS } from '../../../src/contracts/v1/memoryContracts';
import type { CreateMemoryInput, RuntimeMemoryRecord, RuntimeMemoryStore } from '../../../src/contracts/v1/memoryContracts';

/**
 * Between the provider's 8 s text default and its 45 s media default. This call
 * sends no bytes, but it asks for eighteen items rather than one sentence.
 */
const IMPORT_TIMEOUT_MS = 20_000;

/** Eighteen candidates at roughly sixty-five tokens each, with room to spare. */
const IMPORT_MAX_OUTPUT_TOKENS = 2_048;

export class ImportTextTooLongError extends Error {
  readonly maxCharacters = MAX_IMPORT_LENGTH;
  constructor() {
    super(`an imported profile may be at most ${MAX_IMPORT_LENGTH} characters`);
    this.name = 'ImportTextTooLongError';
  }
}

export class ImportProposalNotFoundError extends Error {
  constructor() {
    super('import proposal not found');
    this.name = 'ImportProposalNotFoundError';
  }
}

/**
 * When the account last brought context over, and what it did.
 *
 * On the user document's profile map beside `profile.routine`, for the reason
 * that one is there: it is a single small per-account value the Settings row
 * reads on every render. A memory record would be a receipt about memory,
 * inside memory; a collection would need its own deletion classification for
 * one field.
 */
export interface AiContextImportReceipt {
  lastImportedAt: string;
  assistant: ImportAssistant;
  counts: { created: number; superseded: number; unchanged: number; conflicts: number };
  promptVersion: string;
}

interface ProfileBearingUser {
  profile?: { aiContextImport?: AiContextImportReceipt };
}

export interface ImportOptions {
  storage?: StorageAdapter;
  memory?: RuntimeMemoryStore;
  /** Injected so a test can drive the model without one. */
  generate?: ShareStructuredGenerator;
}

interface StoredImportProposal {
  proposalId: string;
  assistant: ImportAssistant;
  candidates: RawImportCandidate[];
  /**
   * Index to record id. Never sent to the client and never shown to the model:
   * the client is given the resolved ids it already holds, and the model is
   * given the numbers only.
   */
  existingIndex: string[];
  existingTotal: number;
  existingTruncated: boolean;
  createdAt: string;
  promptVersion: string;
  model: string | null;
}

export interface AcceptedImportCandidate {
  index: number;
  /** The user's edit. When present it replaces the content and the source. */
  content?: string;
  /** Only read on a `conflict`. Absent means keep both, which is the safe way. */
  resolve?: 'replace' | 'keep_both';
}

export interface ImportApplyResult {
  created: number;
  superseded: number;
  unchanged: number;
  conflicts: number;
  /** Updates whose target stopped being active between propose and confirm. */
  demoted: number;
  kinds: Record<string, number>;
}

function storageOf(options: ImportOptions): StorageAdapter {
  return options.storage ?? getStorage();
}

function memoryOf(options: ImportOptions): RuntimeMemoryStore {
  return options.memory ?? createStorageRuntimeMemoryStore(undefined, options.storage);
}

function proposalPath(uid: string, proposalId: string): string {
  return `${userCol(uid, AI_CONTEXT_IMPORTS)}/${requireDocId(proposalId)}`;
}

/**
 * The order `listMemory` uses.
 *
 * `retrieve`'s final tiebreak is the record id, which is a random uuid, so a
 * batch written at one instant comes back in a different order on every read.
 * The selection of *which* forty records the model sees has to be stable across
 * reads or the same paste yields different relations each time.
 */
function byListOrder(a: RuntimeMemoryRecord, b: RuntimeMemoryRecord): number {
  return b.observedAt.localeCompare(a.observedAt)
    || b.createdAt.localeCompare(a.createdAt)
    || a.content.localeCompare(b.content)
    || a.id.localeCompare(b.id);
}

/**
 * Reads an imported profile and proposes what it might mean.
 *
 * Returns an empty list rather than throwing when the guard fires or the model
 * gives nothing usable: "we found nothing to bring over" is a normal outcome,
 * and the screen shows it as one. The consent refusal is the route's to make,
 * because the user can act on that one.
 */
export async function importAiContext(
  uid: string,
  text: string,
  assistant: ImportAssistant,
  at: Date,
  options: ImportOptions = {},
): Promise<AiContextImportProposal> {
  requireUserId(uid);
  if (typeof text !== 'string') throw new ImportTextTooLongError();
  const paste = text.trim();
  if (Array.from(paste).length > MAX_IMPORT_LENGTH) throw new ImportTextTooLongError();

  const memory = memoryOf(options);
  const active = [...await memory.retrieve({ scopeId: uid, now: at.toISOString() })].sort(byListOrder);
  const shown = active.slice(0, MAX_EXISTING_MEMORY_RECORDS);

  const proposal: StoredImportProposal = {
    proposalId: randomUUID(),
    assistant,
    candidates: [],
    existingIndex: shown.map((record) => record.id),
    existingTotal: active.length,
    existingTruncated: active.length > shown.length,
    createdAt: at.toISOString(),
    promptVersion: AI_CONTEXT_IMPORT_PROMPT_VERSION,
    model: null,
  };

  // The guard first, before a single token is sent. An injection attempt is not
  // a profile of anybody, and paying for it would be paying to be attacked.
  if (paste === '' || detectPromptInjection(paste)) {
    await save(uid, proposal, options);
    return freeze(proposal);
  }

  const built = buildAiContextImportPrompt(
    paste,
    shown.map((record, i) => ({ index: i + 1, content: record.content })),
  );
  // `shareLlmProvider`'s own ceiling is 60,000, so the 20,000 the capture path
  // enforces is not inherited. The contracts test makes this unreachable; it is
  // here because "unreachable" is a property of today's rule block.
  if (built.length > MAX_INPUT_CHARACTERS) {
    await save(uid, proposal, options);
    return freeze(proposal);
  }

  const generate = options.generate ?? shareLlmProvider(uid, { purpose: 'ai_context_import' });
  const { system, user } = splitPrompt(built);

  let raw: unknown;
  try {
    const response = await generate({
      system,
      parts: [{ kind: 'text', text: user }],
      responseSchema: toVertexSchema(AI_CONTEXT_IMPORT_SCHEMA),
      maxOutputTokens: IMPORT_MAX_OUTPUT_TOKENS,
      timeoutMs: IMPORT_TIMEOUT_MS,
    });
    proposal.model = response.model;
    raw = JSON.parse(response.text);
  } catch {
    // No model, no consent, over a cap, a timeout, or a malformed answer. All
    // of them mean the same thing to the user: nothing to bring over.
    proposal.model = null;
    await save(uid, proposal, options);
    return freeze(proposal);
  }

  proposal.candidates = [...validateImportCandidates(raw, {
    now: at,
    existingCount: shown.length,
    // The whole active set, not the forty. Truncation may cost a relation; it
    // must never cost the duplicate check, because a duplicate row is the only
    // outcome here the user cannot undo by reading.
    existingContents: new Set(active.map((record) => normalizeForComparison(record.content))),
  }).candidates];

  await save(uid, proposal, options);
  return freeze(proposal);
}

async function save(uid: string, proposal: StoredImportProposal, options: ImportOptions): Promise<void> {
  await storageOf(options).set<StoredImportProposal>(proposalPath(uid, proposal.proposalId), proposal);
}

function summarise(candidates: readonly RawImportCandidate[]): ImportSummary {
  let updates = 0;
  let conflicts = 0;
  for (const candidate of candidates) {
    if (candidate.relation === 'update') updates += 1;
    else if (candidate.relation === 'conflict') conflicts += 1;
  }
  return { new: candidates.length - updates - conflicts, updates, conflicts };
}

/** The wire shape: indices resolved to ids, and no `existingIndex`. */
function freeze(proposal: StoredImportProposal): AiContextImportProposal {
  const candidates: ImportCandidate[] = proposal.candidates.map(({ relatesTo, ...rest }) => Object.freeze({
    ...rest,
    relatesToId: relatesTo === null ? null : proposal.existingIndex[relatesTo - 1] ?? null,
  }));

  return Object.freeze({
    proposalId: proposal.proposalId,
    assistant: proposal.assistant,
    candidates: Object.freeze(candidates),
    summary: summarise(proposal.candidates),
    existingConsidered: proposal.existingIndex.length,
    existingTotal: proposal.existingTotal,
    existingTruncated: proposal.existingTruncated,
    createdAt: proposal.createdAt,
    promptVersion: proposal.promptVersion,
    model: proposal.model,
  });
}

/**
 * Writes the candidates the user kept, and nothing else.
 *
 * An index the proposal does not have is ignored rather than refused: the
 * screen and the store can disagree only if the proposal expired underneath the
 * user, and failing the whole save because one row went stale would lose the
 * others they did keep.
 */
export async function confirmAiContextImport(
  uid: string,
  proposalId: string,
  accepted: readonly AcceptedImportCandidate[],
  at: Date,
  options: ImportOptions = {},
): Promise<ImportApplyResult> {
  requireUserId(uid);
  const storage = storageOf(options);
  const stored = await storage.get<StoredImportProposal>(proposalPath(uid, proposalId));
  if (!stored) throw new ImportProposalNotFoundError();

  const age = at.getTime() - Date.parse(stored.createdAt);
  if (!Number.isFinite(age) || age > AI_CONTEXT_IMPORT_TTL_MS) throw new ImportProposalNotFoundError();

  const memory = memoryOf(options);
  const isoAt = at.toISOString();
  const result: ImportApplyResult = {
    created: 0, superseded: 0, unchanged: 0, conflicts: 0, demoted: 0, kinds: {},
  };

  const choices = [...accepted ?? []].sort((a, b) => a.index - b.index);

  for (let position = 0; position < choices.length; position += 1) {
    const choice = choices[position]!;
    const candidate = stored.candidates[choice.index];
    if (!candidate) continue;

    const edited = typeof choice.content === 'string' ? choice.content.trim() : '';
    const useEdit = edited !== '' && edited !== candidate.content;
    const content = useEdit ? edited : candidate.content;

    const input = stripUndefined({
      scopeId: uid,
      kind: candidate.kind,
      content,
      language: languageOf(content),
      // Once somebody has corrected a sentence about themselves, it is theirs.
      source: useEdit ? 'user_stated' : 'model_inferred',
      confidence: useEdit ? 1 : candidate.confidence,
      // Staggered so the first row the user reviewed is the newest, and the
      // memory screen — which sorts `observedAt` descending — lists them in the
      // order they just read. Without the stagger a batch written at one instant
      // comes back sorted by content: stable, but arbitrary to a reader. The
      // spread is one millisecond per row and never reaches into the future.
      observedAt: new Date(at.getTime() - position).toISOString(),
      ttlMs: useEdit ? USER_STATED_MEMORY_TTL_MS : undefined,
      provenance: {
        origin: 'ai_context_import',
        originRef: proposalId,
        assistant: stored.assistant,
        ...(useEdit ? {} : { model: stored.model ?? undefined }),
        promptVersion: stored.promptVersion,
        // Required by the store for anything `model_inferred`, and true for
        // both branches: the user kept this row.
        confirmedByUserAt: isoAt,
      },
    } as CreateMemoryInput);

    // Re-resolved now, not trusted from the proposal. Half an hour is long
    // enough for another device to have revoked or replaced the target.
    const target = candidate.relatesTo === null
      ? null
      : await activeTarget(memory, uid, stored.existingIndex[candidate.relatesTo - 1]);

    if (candidate.relation === 'update') {
      if (!target) {
        await memory.put(input, isoAt);
        result.demoted += 1;
        result.created += 1;
      } else if (target.content === content) {
        // Nothing to say. This is what makes a re-import idempotent rather than
        // a churn of supersessions that all mean the same sentence.
        result.unchanged += 1;
      } else if (await supersedeOrPut(memory, target.id, input, isoAt)) {
        result.superseded += 1;
      } else {
        result.demoted += 1;
        result.created += 1;
      }
    } else if (candidate.relation === 'conflict' && choice.resolve === 'replace' && target) {
      if (await supersedeOrPut(memory, target.id, input, isoAt)) {
        result.superseded += 1;
      } else {
        result.demoted += 1;
        result.created += 1;
      }
    } else if (candidate.relation === 'conflict') {
      // Both survive. Deciding between them is the user's, and the memory
      // screen is where they can see both sentences and their provenance.
      await memory.put(input, isoAt);
      result.conflicts += 1;
    } else {
      await memory.put(input, isoAt);
      result.created += 1;
    }

    result.kinds[candidate.kind] = (result.kinds[candidate.kind] ?? 0) + 1;
  }

  // The proposal has done its job. Removing it is also the cheapest way to
  // guarantee a second confirm cannot write the same facts twice.
  await storage.delete(proposalPath(uid, proposalId));

  // Only when something was actually brought over. Reading a profile and
  // keeping none of it is not an import, and a date for it would claim the
  // store had changed when it had not.
  if (result.created + result.superseded + result.unchanged + result.conflicts > 0) {
    const user = await storage.get<ProfileBearingUser>(userDoc(uid)) ?? {};
    await storage.set(userDoc(uid), {
      ...user,
      profile: {
        ...user.profile,
        aiContextImport: {
          lastImportedAt: isoAt,
          assistant: stored.assistant,
          counts: {
            created: result.created,
            superseded: result.superseded,
            unchanged: result.unchanged,
            conflicts: result.conflicts,
          },
          promptVersion: stored.promptVersion,
        },
      },
    });
  }

  // Counts only. What the facts said is not in the audit trail.
  await appendAudit(createPilotAuditEvent({
    version: 'v1',
    eventType: 'profile_updated',
    participantId: uid,
    occurredAt: isoAt,
    outcome: 'recorded',
    reasonCode: `ai_context_import_applied_${result.created + result.superseded}`,
  }));

  return result;
}

export async function readAiContextImportReceipt(
  uid: string,
  options: ImportOptions = {},
): Promise<AiContextImportReceipt | null> {
  requireUserId(uid);
  const user = await storageOf(options).get<ProfileBearingUser>(userDoc(uid));
  return user?.profile?.aiContextImport ?? null;
}

/**
 * Removes the receipt.
 *
 * Called by "delete everything", which purges collections and cannot see the
 * profile map. Without this a user who deleted all their memories would return
 * to a row reporting the date they brought over memories that no longer exist.
 */
export async function clearAiContextImportReceipt(
  uid: string,
  options: ImportOptions = {},
): Promise<void> {
  requireUserId(uid);
  const storage = storageOf(options);
  const user = await storage.get<ProfileBearingUser>(userDoc(uid));
  if (!user?.profile?.aiContextImport) return;
  const { aiContextImport: _gone, ...rest } = user.profile;
  await storage.set(userDoc(uid), { ...user, profile: rest });
}

/** The target, only if it is still this user's own active record. */
async function activeTarget(
  memory: RuntimeMemoryStore,
  uid: string,
  id: string | undefined,
): Promise<RuntimeMemoryRecord | null> {
  if (!id) return null;
  const record = await memory.get(id);
  if (!record || record.scopeId !== uid || record.status !== 'active') return null;
  return record;
}

/**
 * `true` when the supersession landed.
 *
 * `supersede` refuses a scope change, a non-head of a chain and a revoked
 * record. Any of those means the record moved between the read above and this
 * write, so the claim is kept as a plain record rather than lost.
 */
async function supersedeOrPut(
  memory: RuntimeMemoryStore,
  targetId: string,
  input: CreateMemoryInput,
  isoAt: string,
): Promise<boolean> {
  try {
    await memory.supersede(targetId, input, isoAt);
    return true;
  } catch {
    await memory.put(input, isoAt);
    return false;
  }
}
