/**
 * The schemas that decide whether an imported record can be displayed at all.
 *
 * ── The guard this file is ───────────────────────────────────────
 *
 * `memoryOriginSchema` is a hard-listed enum, and `apiRequest` parses every
 * response through it. So the moment the server learns a sixth origin, this app
 * rejects *every record in the list* — not just the new one — and the memory
 * screen goes blank with a parse error. The origin and the source label are
 * therefore not incidental additions; they are the difference between the
 * feature working and the screen it writes to breaking.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  memoryItemSchema,
  memoryOriginSchema,
  memoryProvenanceSchema,
  memorySourceLabelSchema,
} from '../schemas/profile';
import {
  aiContextImportProposalSchema,
  aiContextImportConfirmedSchema,
  importAssistantSchema,
} from '../schemas/aiContextImport';
import { profileResponseSchema } from '../schemas/profile';

const FIXTURES = join(__dirname, '..', '__fixtures__');

/** A real response, written by invoking the handler in process. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

describe('the real responses these routes return', () => {
  // The guard that matters: these files are regenerated from the handlers
  // themselves, so a server change that alters a shape fails here rather than
  // on somebody's screen.
  it('parses a real import proposal', () => {
    expect(aiContextImportProposalSchema.parse(fixture('profile.imported')).promptVersion)
      .toBe('ai-context-import-v1');
  });

  it('parses a real confirm', () => {
    expect(aiContextImportConfirmedSchema.parse(fixture('profile.importConfirmed')).created).toBe(0);
  });

  it('reads the last-imported receipt off a real profile', () => {
    // Null here, and defaulted rather than required, so a server that predates
    // this feature still parses instead of taking the routine settings down.
    expect(profileResponseSchema.parse(fixture('profile.one')).aiContextImport).toBeNull();
  });

  it('records a real refusal carrying the number the screen may show', () => {
    const refused = fixture('profile.importTooLong') as { reason: string; maxCharacters: number };
    expect(refused.reason).toBe('import_too_long');
    expect(refused.maxCharacters).toBe(4_000);
  });

  it('records a real expired proposal', () => {
    expect((fixture('profile.importExpired') as { reason: string }).reason).toBe('proposal_not_found');
  });
});

describe('the origin and label the import writes', () => {
  it('accepts the imported origin', () => {
    expect(memoryOriginSchema.parse('ai_context_import')).toBe('ai_context_import');
  });

  it('accepts the imported source label', () => {
    expect(memorySourceLabelSchema.parse('you_brought_from_ai')).toBe('you_brought_from_ai');
  });

  it('carries the assistant name through', () => {
    const parsed = memoryProvenanceSchema.parse({
      origin: 'ai_context_import',
      originRef: 'imp_1',
      assistant: 'chatgpt',
      confirmedByUserAt: '2026-09-23T09:00:00.000Z',
    });
    expect(parsed.assistant).toBe('chatgpt');
  });

  it('still parses a record with no assistant at all', () => {
    // Everything written before this feature, and everything written by any
    // other origin.
    const parsed = memoryProvenanceSchema.parse({ origin: 'manual' });
    expect(parsed.assistant).toBeUndefined();
  });

  it('rejects an assistant the app has no name for', () => {
    expect(() => memoryProvenanceSchema.parse({ origin: 'ai_context_import', assistant: 'copilot' })).toThrow();
  });

  it('parses a whole imported memory row', () => {
    const row = memoryItemSchema.parse({
      id: 'mem_1',
      kind: 'fact',
      content: 'Is a nursing student',
      language: 'en',
      source: 'model_inferred',
      sourceLabel: 'you_brought_from_ai',
      confidence: 0.9,
      createdAt: '2026-09-23T09:00:00.000Z',
      observedAt: '2026-09-23T09:00:00.000Z',
      staleAfter: '2026-12-22T09:00:00.000Z',
      provenance: { origin: 'ai_context_import', originRef: 'imp_1', assistant: 'chatgpt' },
      evidence: {
        origin: 'ai_context_import',
        observedAt: '2026-09-23T09:00:00.000Z',
        recordedAt: '2026-09-23T09:00:00.000Z',
        confirmedAt: '2026-09-23T09:00:00.000Z',
        edited: false,
        observationCount: 0,
        pattern: null,
      },
    });
    expect(row.sourceLabel).toBe('you_brought_from_ai');
  });
});

describe('the import proposal', () => {
  const proposal = {
    success: true as const,
    proposalId: 'imp_1',
    assistant: 'chatgpt',
    candidates: [{
      kind: 'fact', category: 'work_study', content: 'Is a nursing student',
      targetDate: null, confidence: 0.9, relation: 'new', relatesToId: null,
    }],
    summary: { new: 1, updates: 0, conflicts: 0 },
    existingConsidered: 0,
    existingTotal: 0,
    existingTruncated: false,
    createdAt: '2026-09-23T09:00:00.000Z',
    promptVersion: 'ai-context-import-v1',
    model: 'gemini-2.5-flash',
  };

  it('parses a proposal', () => {
    expect(aiContextImportProposalSchema.parse(proposal).candidates).toHaveLength(1);
  });

  it('parses an update that names a record the app already holds', () => {
    const updating = {
      ...proposal,
      candidates: [{ ...proposal.candidates[0], relation: 'update', relatesToId: 'mem_9' }],
      summary: { new: 0, updates: 1, conflicts: 0 },
      existingConsidered: 1,
      existingTotal: 1,
    };
    expect(aiContextImportProposalSchema.parse(updating).candidates[0]!.relatesToId).toBe('mem_9');
  });

  it('rejects a relation it has no screen for', () => {
    const bad = { ...proposal, candidates: [{ ...proposal.candidates[0], relation: 'merges' }] };
    expect(() => aiContextImportProposalSchema.parse(bad)).toThrow();
  });

  it('accepts a truncated comparison so the screen can say so', () => {
    const truncated = { ...proposal, existingConsidered: 40, existingTotal: 57, existingTruncated: true };
    expect(aiContextImportProposalSchema.parse(truncated).existingTruncated).toBe(true);
  });

  it('parses what a confirm answered', () => {
    const result = aiContextImportConfirmedSchema.parse({
      success: true, created: 3, superseded: 1, unchanged: 2, conflicts: 1, demoted: 0, kinds: { fact: 4 },
    });
    expect(result.created).toBe(3);
  });

  it('names the four assistants and nothing else', () => {
    for (const name of ['chatgpt', 'gemini', 'claude', 'other']) {
      expect(importAssistantSchema.parse(name)).toBe(name);
    }
    expect(() => importAssistantSchema.parse('deepseek')).toThrow();
  });
});
