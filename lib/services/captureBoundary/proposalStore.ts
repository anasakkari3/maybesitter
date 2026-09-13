/**
 * Where a capture proposal lives between proposing it and confirming it
 * (UC-1.0c #142, fixing #252).
 *
 * ── Why this is not a Map any more ───────────────────────────────
 *
 * It was: one `Map` per process, held on `globalThis`. On Cloud Run that means
 * a capture served by one instance cannot be confirmed by another — the second
 * instance has never seen the proposal — and `confirmCapture` answers
 * `proposal_not_found` while the route returns HTTP 200. The first #153
 * durability run against staging caught exactly that: six captures, two
 * commitments, four confirms that reported success and wrote nothing. The same
 * hole swallows a proposal on every redeploy and every scale-to-zero.
 *
 * So a proposal is now a document in the owner's tree, like everything else a
 * user can lose.
 *
 * ── Two expiries, deliberately ───────────────────────────────────
 *
 * A proposal is worthless once the moment has passed, so the document carries
 * `expiresAt` for Firestore's TTL policy (infra/firestore-ttl.sh) — the same
 * arrangement `clarifications` uses. Nothing here reads that stamp to decide
 * whether a proposal may still be confirmed: the boundary already refuses a
 * proposal whose status is not `proposed`, and a confirm arriving after the
 * TTL swept the document is simply `proposal_not_found`, which is the honest
 * answer.
 *
 * ── The map that JSON would have eaten ───────────────────────────
 *
 * `commandsByItemId` is a `Map`, and `JSON.stringify` turns a Map into `{}`
 * without complaining. Confirm would then find the proposal, find no commands
 * for the selected item, and answer `invalid_selection` — a different silent
 * failure from the one being fixed here.
 *
 * It is stored as a map of arrays, not as entry pairs: Firestore refuses
 * nested arrays outright (`INVALID_ARGUMENT: Nested arrays are not allowed`),
 * while the memory adapter stores anything JSON accepts. The first version of
 * this file used `[[itemId, commands]]`, passed every test on memory, and
 * answered 400 on the first real capture in staging.
 * `tests/storage/captureProposalStore.emulator.test.ts` is the round trip that
 * catches that, because it runs against Firestore.
 */
import type { Command } from '../../../src/domain/stateMachine';
import type { ExtractionResult } from '../../../src/extraction/extractionTypes';
import type { CaptureProposalContract } from '../../../src/contracts/v1/captureContracts';
import {
  CAPTURE_PROPOSALS,
  getStorage,
  requireDocId,
  userCol,
  userIdForKey,
  type StorageAdapter,
} from '../../storage';

export interface StoredCaptureProposal {
  contract: CaptureProposalContract;
  scopeId: string;
  commandsByItemId: ReadonlyMap<string, readonly Command[]>;
  confirmedResult?: unknown;
  idempotencyKey?: string;
  /**
   * When the proposal was made (UC-2.4, #164).
   *
   * Separate from the document's `expiresAt`, which is Firestore's TTL sweep and
   * runs on its own schedule — up to 24 hours late, by design. This is what the
   * confirm actually reads, because "tomorrow at 9" resolved against a `now`
   * from yesterday is wrong and the user has no way to see it.
   */
  proposedAt?: string;
  /**
   * The extraction each item came from, kept so one clarification can be
   * answered (UC-2.5, #165).
   *
   * The answer is applied to the *result*, not to the contract: the command is
   * then rebuilt by `mapExtractionToCommand`, the same function that built it
   * the first time. Patching the contract's `resolvedTime` and leaving the
   * command behind is how a user answers "9 in the evening" and gets a
   * commitment at nine in the morning.
   *
   * Optional because a proposal with nothing to clarify has no use for it.
   */
  resultsByItemId?: ReadonlyMap<string, ExtractionResult>;
  /** Which items have already spent their one round (#165). */
  clarifiedItemIds?: readonly string[];
}

/**
 * Async because the durable implementation is a network call. The memory one
 * satisfies the same shape so a test cannot exercise semantics production does
 * not have.
 */
export interface CaptureProposalStore {
  put(proposal: StoredCaptureProposal): Promise<void>;
  get(proposalId: string): Promise<StoredCaptureProposal | undefined>;
}

/** How long a proposal is kept before Firestore's TTL policy removes it. */
export const CAPTURE_PROPOSAL_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The document as it is stored: the Map flattened, plus the TTL stamp. */
interface StoredProposalDocument {
  contract: CaptureProposalContract;
  scopeId: string;
  /**
   * The proposal id, repeated at the top level so the lookup filters on a
   * plain field. `contract.proposalId` would work — both adapters walk a
   * dotted path — but it would be this repository's only nested `where`, and
   * a nested Firestore field override is a sharper edge than a flat one.
   */
  proposalId: string;
  commands: Record<string, Command[]>;
  /**
   * The extraction each item came from (UC-2.5, #165), so one clarification can
   * be answered against it rather than by patching the contract.
   */
  results?: Record<string, ExtractionResult>;
  /** Items that have spent their one clarification round (#165). */
  clarifiedItemIds?: string[];
  /**
   * When the proposal was made (UC-2.4, #164).
   *
   * This was absent from the document while `StoredCaptureProposal` carried it,
   * so it survived the `Map`-backed store and was dropped by the durable one —
   * which is the only one production uses. `stored.proposedAt` was therefore
   * always `undefined` there and the thirty-minute staleness guard could never
   * fire: a proposal resolved against yesterday's `now` confirmed happily. The
   * tests did not catch it because they use the Map.
   */
  proposedAt?: string;
  confirmedResult?: unknown;
  idempotencyKey?: string;
  expiresAt: Date;
}

function toDocument(proposal: StoredCaptureProposal, now: Date): StoredProposalDocument {
  return {
    contract: proposal.contract,
    scopeId: proposal.scopeId,
    proposalId: proposal.contract.proposalId,
    commands: Object.fromEntries(Array.from(proposal.commandsByItemId, ([itemId, commands]) => [itemId, [...commands]])),
    // Maps do not survive a JSON document; every one of them is mapped
    // explicitly, and a field added to `StoredCaptureProposal` without a line
    // here is a field production silently loses.
    ...(proposal.resultsByItemId
      ? { results: Object.fromEntries(proposal.resultsByItemId) }
      : {}),
    ...(proposal.clarifiedItemIds?.length ? { clarifiedItemIds: [...proposal.clarifiedItemIds] } : {}),
    ...(proposal.proposedAt === undefined ? {} : { proposedAt: proposal.proposedAt }),
    ...(proposal.confirmedResult === undefined ? {} : { confirmedResult: proposal.confirmedResult }),
    ...(proposal.idempotencyKey === undefined ? {} : { idempotencyKey: proposal.idempotencyKey }),
    expiresAt: new Date(now.getTime() + CAPTURE_PROPOSAL_RETENTION_MS),
  };
}

function fromDocument(document: StoredProposalDocument): StoredCaptureProposal {
  return {
    contract: document.contract,
    scopeId: document.scopeId,
    commandsByItemId: new Map(Object.entries(document.commands ?? {})),
    ...(document.results ? { resultsByItemId: new Map(Object.entries(document.results)) } : {}),
    ...(document.clarifiedItemIds ? { clarifiedItemIds: [...document.clarifiedItemIds] } : {}),
    ...(document.proposedAt === undefined ? {} : { proposedAt: document.proposedAt }),
    ...(document.confirmedResult === undefined ? {} : { confirmedResult: document.confirmedResult }),
    ...(document.idempotencyKey === undefined ? {} : { idempotencyKey: document.idempotencyKey }),
  };
}

/**
 * Proposals in the owner's tree.
 *
 * The scope id is the participant id on the mobile path, so the document lives
 * under that user and goes with the account when it is deleted.
 */
/**
 * Where a scope's proposal lives. Exported because the atomic confirm (#148)
 * has to address the very same document this store wrote, and deriving the path
 * twice from the same function is how that stays true.
 */
export function captureProposalPath(scopeId: string, proposalId: string): string {
  return `${userCol(userIdForKey(scopeId), CAPTURE_PROPOSALS)}/${requireDocId(proposalId)}`;
}

export class StorageCaptureProposalStore implements CaptureProposalStore {
  constructor(private readonly injected?: StorageAdapter) {}

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  private path(scopeId: string, proposalId: string): string {
    return captureProposalPath(scopeId, proposalId);
  }

  async put(proposal: StoredCaptureProposal): Promise<void> {
    await this.storage.set<StoredProposalDocument>(
      this.path(proposal.scopeId, proposal.contract.proposalId),
      toDocument(proposal, new Date()),
    );
  }

  /**
   * A proposal is addressed by id alone, but the path needs its owner — so the
   * lookup is a collection-group read on the id, the same shape
   * `alphaTraceStore` uses for a session id. The boundary still checks the
   * scope, so finding another user's proposal here changes nothing: it is
   * refused as `proposal_not_found`.
   */
  async get(proposalId: string): Promise<StoredCaptureProposal | undefined> {
    const rows = await this.storage.listGroup<StoredProposalDocument>(CAPTURE_PROPOSALS, {
      where: [['proposalId', '==', proposalId]],
      limit: 1,
    });
    const document = rows[0]?.data;
    return document ? fromDocument(document) : undefined;
  }
}

/**
 * The same shape over a private in-memory adapter, for tests and for callers
 * that have no storage at all. It is a Map, so it keeps the old behaviour
 * exactly — including that nothing survives the process.
 */
export class MemoryCaptureProposalStore implements CaptureProposalStore {
  private readonly proposals = new Map<string, StoredCaptureProposal>();

  async put(proposal: StoredCaptureProposal): Promise<void> {
    this.proposals.set(proposal.contract.proposalId, proposal);
  }

  async get(proposalId: string): Promise<StoredCaptureProposal | undefined> {
    return this.proposals.get(proposalId);
  }
}

export function createStorageCaptureProposalStore(storage?: StorageAdapter): CaptureProposalStore {
  return new StorageCaptureProposalStore(storage);
}
