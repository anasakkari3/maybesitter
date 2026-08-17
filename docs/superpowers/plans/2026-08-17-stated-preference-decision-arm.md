# Stated-Preference Decision Arm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate Sprint 2 of the memory contract (`fact`/`preference` memory kinds) and add a benchmark-only `'stated-preference'` next-step decision arm that ranks candidates using explicit, provenance-tracked user state instead of inferred behavior — to test whether that beats the existing `personalized` (behavior-inferred) and `generic` (baseline) arms, without ever reaching live V03 pilot traffic.

**Architecture:** New `PreferenceMemory`/`FactMemory` types and file-backed stores mirror `CommitmentMemory`/`FileCommitmentMemoryStore` exactly (event-sourced, atomic writes). A new rule-based extraction path (checked before existing commitment-modality detection) classifies free text as `preference`/`fact` and feeds the existing `memoryIngestionService.ts` extension seam. A new `'stated-preference'` arm plugs into the existing `lib/experiments/nextStepArms.ts` dispatcher, reusing its baseline-eligibility invariant (arms reorder, never invent, candidates). The new arm is *not* added to the `NEXT_STEP_ARMS` tuple that live traffic assignment buckets over, so it is structurally unreachable by real pilot users.

**Tech Stack:** TypeScript, Node's built-in `node:test` runner (`node --no-warnings --loader ./scripts/ts-resolver.mjs --test <files>`), no new dependencies.

**Spec:** `docs/architecture/adr-0002-stated-preference-decision-arm.md`

## Global Constraints

- Node >= 22.5.0 (repo `engines` field). This worktree has Node v24.18.1 — fine.
- No new npm dependencies.
- No ML, no vector DB, no cross-user data — rule-based/deterministic only, matching Sprint 1's existing extraction style (`docs/MEMORY_CONTRACT.md`).
- `'stated-preference'` must never be added to `NEXT_STEP_ARMS` in `src/contracts/v1/experimentContracts.ts` — that tuple governs live pilot assignment. This is the load-bearing safety property of the whole slice; a task that violates it fails review regardless of what else it does correctly.
- All file imports use explicit `.ts` extensions (ESM + `ts-resolver.mjs` loader convention already used throughout the repo).
- Every store follows the existing atomic-write pattern: write to `<file>.tmp`, then `renameSync` to the real path.
- Run tests from the repo root of this worktree (`/Users/anasakkari/Desktop/1-Projects/MaybeSitter/code/maybesitter-s00-dataset-registry/.claude/worktrees/decision-poc`), which is on branch `worktree-decision-poc`. Do not push or merge to `main`.

---

### Task 1: Sprint 2 memory types + classification policy

**Files:**
- Modify: `src/domain/memory/memoryTypes.ts`
- Modify: `src/domain/memory/memoryPolicy.ts`
- Test: `tests/memory/memoryPolicy.test.ts` (extend)

**Interfaces:**
- Produces: `PreferenceMemory`, `FactMemory`, `PreferenceEvent`, `FactEvent`, `PreferenceStrength`, `PreferencePolarity`, `StatementStatus` (all in `memoryTypes.ts`); `classifyPreferenceStrength(candidate: MemoryCandidate): PreferenceStrength`, `classifyPreferencePolarity(candidate: MemoryCandidate): PreferencePolarity`, `deriveStatementScope(candidate: MemoryCandidate): string` (all in `memoryPolicy.ts`) — used by Tasks 3, 4, 6.

- [ ] **Step 1: Write the failing tests**

Append to `tests/memory/memoryPolicy.test.ts` (add these imports to the existing `import` block at the top, and add the test cases at the end of the file):

```typescript
// Add to the existing import from '../../src/domain/memory/memoryPolicy.ts':
//   classifyPreferenceStrength, classifyPreferencePolarity, deriveStatementScope

function makePreferenceCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    candidateType: 'preference',
    normalizedText: 'I prefer not to go to the gym three days in a row',
    modality: 'certain',
    confidence: 0.75,
    evidenceSpan: { start: 0, end: 10, text: 'preference' },
    ...overrides,
  };
}

test('policy: "always"/"never"/"must" → hard strength', () => {
  assert.equal(classifyPreferenceStrength(makePreferenceCandidate({ normalizedText: 'I always need 8 hours of sleep' })), 'hard');
  assert.equal(classifyPreferenceStrength(makePreferenceCandidate({ normalizedText: 'ما بحب اروح الجيم دايماً ثلاث أيام متتالية' })), 'hard');
});

test('policy: "usually"/"prefer" without hard markers → soft strength', () => {
  assert.equal(classifyPreferenceStrength(makePreferenceCandidate({ normalizedText: 'I usually prefer working on projects' })), 'soft');
});

test('policy: "avoid"/"don\'t like"/"hate" → avoid polarity', () => {
  assert.equal(classifyPreferencePolarity(makePreferenceCandidate({ normalizedText: "I don't like going to the gym three days in a row" })), 'avoid');
  assert.equal(classifyPreferencePolarity(makePreferenceCandidate({ normalizedText: 'ما بحب اروح الجيم' })), 'avoid');
});

test('policy: "I prefer"/"I like" → prefer polarity', () => {
  assert.equal(classifyPreferencePolarity(makePreferenceCandidate({ normalizedText: 'I prefer working on projects in the evening' })), 'prefer');
});

test('policy: scope derived from known vocabulary keyword', () => {
  assert.equal(deriveStatementScope(makePreferenceCandidate({ normalizedText: "I don't like going to the gym three days in a row" })), 'gym');
  assert.equal(deriveStatementScope(makePreferenceCandidate({ normalizedText: 'Thursday Wolt shifts pay more', candidateType: 'fact' })), 'wolt');
  assert.equal(deriveStatementScope(makePreferenceCandidate({ normalizedText: 'بشتغل الثلاثاء من الخامسة للثامنة', candidateType: 'fact' })), 'work');
});

test('policy: scope falls back to normalized text when no keyword matches', () => {
  const scope = deriveStatementScope(makePreferenceCandidate({ normalizedText: 'I prefer quiet mornings' }));
  assert.equal(scope, 'i prefer quiet mornings');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/memoryPolicy.test.ts`
Expected: FAIL — `classifyPreferenceStrength` is not exported.

- [ ] **Step 3: Add the new types to `memoryTypes.ts`**

Add after the existing `NotificationDecision`/`CommitmentMatchScore` interfaces at the end of `src/domain/memory/memoryTypes.ts`, and change the `EnabledMemoryKind` line near the top:

```typescript
// Replace this line:
// export type EnabledMemoryKind = 'observation' | 'commitment';
// with:
export type EnabledMemoryKind = 'observation' | 'commitment' | 'fact' | 'preference';
```

Append to the end of the file:

```typescript
export type StatementStatus = 'active' | 'superseded' | 'rejected';
export type PreferenceStrength = 'soft' | 'hard';
export type PreferencePolarity = 'prefer' | 'avoid';

export interface PreferenceMemory {
  id: string;
  userId: string;
  statement: string;
  scope: string;
  strength: PreferenceStrength;
  polarity: PreferencePolarity;
  confidence: number;
  status: StatementStatus;
  createdAt: string;
  updatedAt: string;
  evidenceIds: string[];
  supersedesPreferenceId?: string;
}

export interface FactMemory {
  id: string;
  userId: string;
  statement: string;
  scope: string;
  confidence: number;
  status: StatementStatus;
  createdAt: string;
  updatedAt: string;
  evidenceIds: string[];
  supersedesFactId?: string;
}

export type PreferenceEventType = 'created' | 'corrected' | 'confidence_adjusted';
export interface PreferenceEvent {
  id: string;
  preferenceId: string;
  type: PreferenceEventType;
  fromStatus?: StatementStatus;
  toStatus?: StatementStatus;
  fromConfidence?: number;
  toConfidence?: number;
  observationId?: string;
  reason: string;
  actor: 'user' | 'system' | 'model';
  createdAt: string;
}

export type FactEventType = 'created' | 'corrected' | 'confidence_adjusted';
export interface FactEvent {
  id: string;
  factId: string;
  type: FactEventType;
  fromStatus?: StatementStatus;
  toStatus?: StatementStatus;
  fromConfidence?: number;
  toConfidence?: number;
  observationId?: string;
  reason: string;
  actor: 'user' | 'system' | 'model';
  createdAt: string;
}
```

- [ ] **Step 4: Add the classification functions to `memoryPolicy.ts`**

Append to `src/domain/memory/memoryPolicy.ts` (add `PreferenceStrength, PreferencePolarity` to the existing type-only import from `'./memoryTypes.ts'` at the top of the file):

```typescript
function mkPolicyPattern(alternatives: string[]): RegExp {
  return new RegExp(`(?:${alternatives.join('|')})`, 'i');
}

const HARD_STRENGTH_PATTERNS = mkPolicyPattern([
  'always', 'never', 'must', 'دايماً', 'دائما', 'لازم', 'תמיד', 'אף\\s+פעם',
]);

const AVOID_POLARITY_PATTERNS = mkPolicyPattern([
  "don't\\s+like", 'avoid', 'hate', 'ما\\s+بحب', 'مش\\s+بحب', 'לא\\s+אוהב',
]);

export function classifyPreferenceStrength(candidate: MemoryCandidate): PreferenceStrength {
  return HARD_STRENGTH_PATTERNS.test(candidate.normalizedText) ? 'hard' : 'soft';
}

export function classifyPreferencePolarity(candidate: MemoryCandidate): PreferencePolarity {
  return AVOID_POLARITY_PATTERNS.test(candidate.normalizedText) ? 'avoid' : 'prefer';
}

/**
 * Small closed vocabulary, not open-domain topic extraction — consistent with the
 * rule-based (no ML, no vector DB) extraction approach used throughout Sprint 1.
 * Falls back to the normalized statement text, which simply will not match any
 * commitment title later (fails safe: no scope match means no arm effect).
 */
const SCOPE_KEYWORDS: Record<string, string> = {
  'جيم': 'gym', gym: 'gym',
  wolt: 'wolt', 'وولت': 'wolt',
  // 'بشتغل' (not just 'شغل') because the colloquial present-tense conjugation
  // inserts a ت between the ب prefix and the شغل root — 'شغل' alone is not a
  // substring of 'بشتغل', so an "I work" statement would otherwise match nothing.
  'بشتغل': 'work', 'شغل': 'work', 'دوام': 'work', work: 'work', shift: 'work',
  'نوم': 'sleep', sleep: 'sleep',
};

export function deriveStatementScope(candidate: MemoryCandidate): string {
  const normalized = candidate.normalizedText.toLowerCase();
  for (const [keyword, scope] of Object.entries(SCOPE_KEYWORDS)) {
    if (normalized.includes(keyword.toLowerCase())) return scope;
  }
  return normalized;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/memoryPolicy.test.ts`
Expected: PASS, all tests including the new ones.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/domain/memory/memoryTypes.ts src/domain/memory/memoryPolicy.ts tests/memory/memoryPolicy.test.ts
git commit -m "feat: activate Sprint 2 fact/preference memory types and classification policy"
```

---

### Task 2: Statement resolver (dedup/link/create for preferences and facts)

**Files:**
- Create: `src/domain/memory/statementResolver.ts`
- Test: `tests/memory/statementResolver.test.ts`

**Interfaces:**
- Consumes: nothing new (pure functions over plain data).
- Produces: `ResolvableStatement { id, scope, statement }`, `StatementMatchScore { id, scopeScore, textScore, totalScore }`, `StatementResolutionDecision = { action: 'link'; id: string; score: StatementMatchScore } | { action: 'confirm_link'; id: string; score: StatementMatchScore } | { action: 'create_new' }`, `resolveStatement(candidateScope: string, candidateText: string, existingActive: ResolvableStatement[]): StatementResolutionDecision` — used by Task 6.

- [ ] **Step 1: Write the failing test**

Create `tests/memory/statementResolver.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatement, scoreStatementMatch, type ResolvableStatement } from '../../src/domain/memory/statementResolver.ts';

function makeExisting(overrides: Partial<ResolvableStatement> = {}): ResolvableStatement {
  return { id: 'pref_1', scope: 'gym', statement: 'avoid gym three days in a row', ...overrides };
}

test('resolver: identical scope and text → high score, auto-link', () => {
  const decision = resolveStatement('gym', 'avoid gym three days in a row', [makeExisting()]);
  assert.equal(decision.action, 'link');
});

test('resolver: no existing statements → create new', () => {
  const decision = resolveStatement('gym', 'avoid gym three days in a row', []);
  assert.equal(decision.action, 'create_new');
});

test('resolver: same scope, unrelated text → create new (not auto-linked)', () => {
  const decision = resolveStatement('gym', 'the gym closes at 10pm on weekdays', [makeExisting()]);
  assert.equal(decision.action, 'create_new');
});

test('resolver: different scope, similar text → create new', () => {
  const decision = resolveStatement('wolt', 'avoid gym three days in a row', [makeExisting()]);
  assert.equal(decision.action, 'create_new');
});

test('resolver: partial text overlap in same scope → confirm_link band', () => {
  const decision = resolveStatement('gym', 'avoid gym three days straight', [makeExisting()]);
  assert.ok(decision.action === 'link' || decision.action === 'confirm_link');
});

test('resolver: score includes scope and text components', () => {
  const score = scoreStatementMatch('gym', 'avoid gym three days in a row', makeExisting());
  assert.equal(score.scopeScore, 1);
  assert.ok(score.textScore > 0.9);
  assert.ok(score.totalScore >= 0 && score.totalScore <= 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/statementResolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `statementResolver.ts`**

Create `src/domain/memory/statementResolver.ts`:

```typescript
export interface ResolvableStatement {
  id: string;
  scope: string;
  statement: string;
}

export interface StatementMatchScore {
  id: string;
  scopeScore: number;
  textScore: number;
  totalScore: number;
}

// Duplicated from commitmentResolver.ts rather than imported: Sprint 1's resolver is
// working, tested code and this keeps the two resolvers independently modifiable
// without cross-coupling commitment matching to statement matching.
function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9؀-ۿ֐-׿\s]/g, '').replace(/\s+/g, ' ').trim();
}

function wordOverlap(a: string, b: string): number {
  const arrA = normalizeForComparison(a).split(' ').filter(Boolean);
  const arrB = normalizeForComparison(b).split(' ').filter(Boolean);
  if (arrA.length === 0 || arrB.length === 0) return 0;
  const setB: Record<string, boolean> = {};
  for (const w of arrB) setB[w] = true;
  let overlap = 0;
  const seen: Record<string, boolean> = {};
  for (const word of arrA) {
    if (!seen[word] && setB[word]) overlap++;
    seen[word] = true;
  }
  return overlap / Math.max(arrA.length, arrB.length);
}

export function scoreStatementMatch(candidateScope: string, candidateText: string, existing: ResolvableStatement): StatementMatchScore {
  const scopeScore = normalizeForComparison(candidateScope) === normalizeForComparison(existing.scope) ? 1 : 0;
  const textScore = wordOverlap(candidateText, existing.statement);
  const totalScore = scopeScore * 0.6 + textScore * 0.4;
  return { id: existing.id, scopeScore, textScore, totalScore };
}

export type StatementResolutionDecision =
  | { action: 'link'; id: string; score: StatementMatchScore }
  | { action: 'confirm_link'; id: string; score: StatementMatchScore }
  | { action: 'create_new' };

export function resolveStatement(
  candidateScope: string,
  candidateText: string,
  existingActive: ResolvableStatement[],
): StatementResolutionDecision {
  if (existingActive.length === 0) return { action: 'create_new' };

  const scores = existingActive.map((existing) => scoreStatementMatch(candidateScope, candidateText, existing));
  scores.sort((a, b) => b.totalScore - a.totalScore);
  const best = scores[0];

  if (best.totalScore >= 0.85) return { action: 'link', id: best.id, score: best };
  if (best.totalScore >= 0.60) return { action: 'confirm_link', id: best.id, score: best };
  return { action: 'create_new' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/statementResolver.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/memory/statementResolver.ts tests/memory/statementResolver.test.ts
git commit -m "feat: add statement resolver for preference/fact dedup and linking"
```

---

### Task 3: Preference memory store

**Files:**
- Create: `src/domain/memory/preferenceMemoryStore.ts`
- Test: `tests/memory/preferenceMemoryStore.test.ts`

**Interfaces:**
- Consumes: `PreferenceMemory`, `PreferenceEvent`, `PreferenceEventType`, `PreferenceStrength`, `PreferencePolarity`, `StatementStatus` from `memoryTypes.ts` (Task 1).
- Produces: `CreatePreferenceMemoryInput`, `UpdatePreferenceInput`, `PreferenceMemoryStore` interface, `FilePreferenceMemoryStore` class with `create`, `getById`, `getActiveByUserId`, `update`, `addEvidence`, `adjustConfidence`, `getEvents`, `getAllEvents` — used by Tasks 6, 7, 9.

- [ ] **Step 1: Write the failing test**

Create `tests/memory/preferenceMemoryStore.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { FilePreferenceMemoryStore } from '../../src/domain/memory/preferenceMemoryStore.ts';

function withTempStore(fn: (store: FilePreferenceMemoryStore) => void): void {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'maybesitter-pref-test-'));
  try {
    fn(new FilePreferenceMemoryStore(tmpDir));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('preferenceStore: create stores an active preference with a created event', () => {
  withTempStore((store) => {
    const preference = store.create({
      userId: 'user_1', statement: 'avoid gym three days in a row', scope: 'gym',
      strength: 'hard', polarity: 'avoid', confidence: 0.9, evidenceIds: ['obs_1'],
    }, 'Created from message', 'obs_1');

    assert.equal(preference.status, 'active');
    assert.equal(preference.strength, 'hard');
    assert.equal(preference.polarity, 'avoid');

    const events = store.getEvents(preference.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'created');
  });
});

test('preferenceStore: getById returns null for unknown id', () => {
  withTempStore((store) => {
    assert.equal(store.getById('does_not_exist'), null);
  });
});

test('preferenceStore: getActiveByUserId excludes other users and superseded entries', () => {
  withTempStore((store) => {
    const mine = store.create({
      userId: 'user_1', statement: 'prefer working in the evening', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.7, evidenceIds: [],
    }, 'created', undefined);
    store.create({
      userId: 'user_2', statement: 'avoid gym', scope: 'gym',
      strength: 'soft', polarity: 'avoid', confidence: 0.7, evidenceIds: [],
    }, 'created', undefined);
    store.update({ id: mine.id, status: 'superseded' }, 'replaced by a newer statement', 'system');

    const secondMine = store.create({
      userId: 'user_1', statement: 'prefer deep work blocks in the morning', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.8, evidenceIds: [],
    }, 'created', undefined);

    const active = store.getActiveByUserId('user_1');
    assert.equal(active.length, 1);
    assert.equal(active[0].id, secondMine.id);
  });
});

test('preferenceStore: update changes fields and records a corrected event on terminal status', () => {
  withTempStore((store) => {
    const preference = store.create({
      userId: 'user_1', statement: 'avoid gym three days in a row', scope: 'gym',
      strength: 'soft', polarity: 'avoid', confidence: 0.6, evidenceIds: [],
    }, 'created', undefined);
    store.update({ id: preference.id, status: 'superseded' }, 'user corrected this', 'user');
    const updated = store.update({ id: preference.id, status: 'active' }, 'user restored this', 'user');

    assert.equal(updated.status, 'active');
    const events = store.getEvents(preference.id);
    assert.ok(events.some((event) => event.type === 'corrected'));
  });
});

test('preferenceStore: adjustConfidence clamps within [0.2, 0.99] and records events', () => {
  withTempStore((store) => {
    const preference = store.create({
      userId: 'user_1', statement: 'prefer short tasks in the evening', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.95, evidenceIds: [],
    }, 'created', undefined);

    const boosted = store.adjustConfidence(preference.id, 0.5, 'accepted repeatedly');
    assert.equal(boosted.confidence, 0.99);

    const lowered = store.adjustConfidence(preference.id, -2, 'dismissed repeatedly');
    assert.equal(lowered.confidence, 0.2);

    const events = store.getEvents(preference.id);
    assert.ok(events.filter((event) => event.type === 'confidence_adjusted').length === 2);
  });
});

test('preferenceStore: addEvidence appends without duplicating', () => {
  withTempStore((store) => {
    const preference = store.create({
      userId: 'user_1', statement: 'prefer short tasks', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.7, evidenceIds: ['obs_1'],
    }, 'created', undefined);
    store.addEvidence(preference.id, 'obs_2');
    store.addEvidence(preference.id, 'obs_2');
    const stored = store.getById(preference.id);
    assert.deepEqual(stored!.evidenceIds, ['obs_1', 'obs_2']);
  });
});

test('preferenceStore: persists across store instances (file-backed)', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'maybesitter-pref-test-'));
  try {
    const first = new FilePreferenceMemoryStore(tmpDir);
    const created = first.create({
      userId: 'user_1', statement: 'prefer mornings', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.7, evidenceIds: [],
    }, 'created', undefined);

    const second = new FilePreferenceMemoryStore(tmpDir);
    assert.deepEqual(second.getById(created.id), created);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/preferenceMemoryStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `preferenceMemoryStore.ts`**

Create `src/domain/memory/preferenceMemoryStore.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  PreferenceMemory, PreferenceEvent, PreferenceEventType, PreferenceStrength, PreferencePolarity, StatementStatus,
} from './memoryTypes.ts';

export interface CreatePreferenceMemoryInput {
  userId: string;
  statement: string;
  scope: string;
  strength: PreferenceStrength;
  polarity: PreferencePolarity;
  confidence: number;
  evidenceIds: string[];
  supersedesPreferenceId?: string;
}

export interface UpdatePreferenceInput {
  id: string;
  statement?: string;
  strength?: PreferenceStrength;
  polarity?: PreferencePolarity;
  confidence?: number;
  status?: StatementStatus;
}

export interface PreferenceMemoryStore {
  create(input: CreatePreferenceMemoryInput, reason: string, observationId?: string): PreferenceMemory;
  getById(id: string): PreferenceMemory | null;
  getActiveByUserId(userId: string): PreferenceMemory[];
  update(input: UpdatePreferenceInput, reason: string, actor: PreferenceEvent['actor'], observationId?: string): PreferenceMemory;
  addEvidence(preferenceId: string, observationId: string): void;
  adjustConfidence(id: string, delta: number, reason: string): PreferenceMemory;
  getEvents(preferenceId: string): PreferenceEvent[];
  getAllEvents(): PreferenceEvent[];
}

interface PreferenceMemoryData {
  preferences: Record<string, PreferenceMemory>;
  events: PreferenceEvent[];
}

const MIN_CONFIDENCE = 0.2;
const MAX_CONFIDENCE = 0.99;

export class FilePreferenceMemoryStore implements PreferenceMemoryStore {
  private dataDir: string;
  private filePath: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(process.cwd(), '.maybesitter');
    this.filePath = path.join(this.dataDir, 'preference-memory.json');
  }

  private load(): PreferenceMemoryData {
    if (!existsSync(this.filePath)) return { preferences: {}, events: [] };
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as PreferenceMemoryData;
    } catch {
      return { preferences: {}, events: [] };
    }
  }

  private save(data: PreferenceMemoryData): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }

  private createEvent(
    preferenceId: string,
    type: PreferenceEventType,
    reason: string,
    actor: PreferenceEvent['actor'],
    fromStatus?: StatementStatus,
    toStatus?: StatementStatus,
    fromConfidence?: number,
    toConfidence?: number,
    observationId?: string,
  ): PreferenceEvent {
    return {
      id: `pevt_${randomUUID()}`,
      preferenceId, type, fromStatus, toStatus, fromConfidence, toConfidence,
      observationId, reason, actor, createdAt: new Date().toISOString(),
    };
  }

  create(input: CreatePreferenceMemoryInput, reason: string, observationId?: string): PreferenceMemory {
    const data = this.load();
    const now = new Date().toISOString();
    const preference: PreferenceMemory = {
      id: `pref_${randomUUID()}`,
      userId: input.userId,
      statement: input.statement,
      scope: input.scope,
      strength: input.strength,
      polarity: input.polarity,
      confidence: input.confidence,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      evidenceIds: input.evidenceIds,
      supersedesPreferenceId: input.supersedesPreferenceId,
    };
    data.preferences[preference.id] = preference;
    data.events.push(this.createEvent(preference.id, 'created', reason, 'model', undefined, 'active', undefined, input.confidence, observationId));
    this.save(data);
    return preference;
  }

  getById(id: string): PreferenceMemory | null {
    return this.load().preferences[id] || null;
  }

  getActiveByUserId(userId: string): PreferenceMemory[] {
    return Object.values(this.load().preferences)
      .filter((preference) => preference.userId === userId && preference.status === 'active')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  update(input: UpdatePreferenceInput, reason: string, actor: PreferenceEvent['actor'], observationId?: string): PreferenceMemory {
    const data = this.load();
    const preference = data.preferences[input.id];
    if (!preference) throw new Error(`Preference not found: ${input.id}`);

    const fromStatus = preference.status;
    if (input.statement !== undefined) preference.statement = input.statement;
    if (input.strength !== undefined) preference.strength = input.strength;
    if (input.polarity !== undefined) preference.polarity = input.polarity;
    if (input.confidence !== undefined) preference.confidence = input.confidence;
    if (input.status !== undefined) preference.status = input.status;
    preference.updatedAt = new Date().toISOString();

    if (input.status !== undefined && input.status !== fromStatus) {
      data.events.push(this.createEvent(input.id, 'corrected', reason, actor, fromStatus, input.status, undefined, undefined, observationId));
    }

    this.save(data);
    return preference;
  }

  addEvidence(preferenceId: string, observationId: string): void {
    const data = this.load();
    const preference = data.preferences[preferenceId];
    if (!preference) return;
    if (!preference.evidenceIds.includes(observationId)) {
      preference.evidenceIds.push(observationId);
      preference.updatedAt = new Date().toISOString();
      this.save(data);
    }
  }

  adjustConfidence(id: string, delta: number, reason: string): PreferenceMemory {
    const data = this.load();
    const preference = data.preferences[id];
    if (!preference) throw new Error(`Preference not found: ${id}`);
    const from = preference.confidence;
    const to = Math.max(MIN_CONFIDENCE, Math.min(MAX_CONFIDENCE, from + delta));
    preference.confidence = to;
    preference.updatedAt = new Date().toISOString();
    data.events.push(this.createEvent(id, 'confidence_adjusted', reason, 'system', undefined, undefined, from, to));
    this.save(data);
    return preference;
  }

  getEvents(preferenceId: string): PreferenceEvent[] {
    return this.load().events.filter((event) => event.preferenceId === preferenceId);
  }

  getAllEvents(): PreferenceEvent[] {
    return this.load().events;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/preferenceMemoryStore.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/memory/preferenceMemoryStore.ts tests/memory/preferenceMemoryStore.test.ts
git commit -m "feat: add file-backed preference memory store"
```

---

### Task 4: Fact memory store

**Files:**
- Create: `src/domain/memory/factMemoryStore.ts`
- Test: `tests/memory/factMemoryStore.test.ts`

**Interfaces:**
- Consumes: `FactMemory`, `FactEvent`, `FactEventType`, `StatementStatus` from `memoryTypes.ts` (Task 1).
- Produces: `CreateFactMemoryInput`, `UpdateFactInput`, `FactMemoryStore` interface, `FileFactMemoryStore` class with `create`, `getById`, `getActiveByUserId`, `update`, `addEvidence`, `adjustConfidence`, `getEvents`, `getAllEvents` — used by Tasks 6, 7, 9.

This mirrors Task 3 exactly, minus `strength`/`polarity`.

- [ ] **Step 1: Write the failing test**

Create `tests/memory/factMemoryStore.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { FileFactMemoryStore } from '../../src/domain/memory/factMemoryStore.ts';

function withTempStore(fn: (store: FileFactMemoryStore) => void): void {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'maybesitter-fact-test-'));
  try {
    fn(new FileFactMemoryStore(tmpDir));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('factStore: create stores an active fact with a created event', () => {
  withTempStore((store) => {
    const fact = store.create({
      userId: 'user_1', statement: 'Tuesday I work 17:00-20:00', scope: 'work',
      confidence: 0.85, evidenceIds: ['obs_1'],
    }, 'Created from message', 'obs_1');

    assert.equal(fact.status, 'active');
    const events = store.getEvents(fact.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'created');
  });
});

test('factStore: getById returns null for unknown id', () => {
  withTempStore((store) => {
    assert.equal(store.getById('does_not_exist'), null);
  });
});

test('factStore: getActiveByUserId excludes other users and superseded entries', () => {
  withTempStore((store) => {
    const mine = store.create({
      userId: 'user_1', statement: 'Thursday Wolt shifts pay more', scope: 'wolt', confidence: 0.8, evidenceIds: [],
    }, 'created', undefined);
    store.create({
      userId: 'user_2', statement: 'unrelated fact', scope: 'work', confidence: 0.8, evidenceIds: [],
    }, 'created', undefined);
    store.update({ id: mine.id, status: 'superseded' }, 'replaced', 'system');

    const secondMine = store.create({
      userId: 'user_1', statement: 'Thursday and Friday Wolt shifts pay more', scope: 'wolt', confidence: 0.85, evidenceIds: [],
    }, 'created', undefined);

    const active = store.getActiveByUserId('user_1');
    assert.equal(active.length, 1);
    assert.equal(active[0].id, secondMine.id);
  });
});

test('factStore: update changes fields and records a corrected event on status change', () => {
  withTempStore((store) => {
    const fact = store.create({
      userId: 'user_1', statement: 'the gym closes at 10pm', scope: 'gym', confidence: 0.7, evidenceIds: [],
    }, 'created', undefined);
    const updated = store.update({ id: fact.id, statement: 'the gym closes at 9pm on weekdays' }, 'corrected by user', 'user');
    assert.equal(updated.statement, 'the gym closes at 9pm on weekdays');

    store.update({ id: fact.id, status: 'superseded' }, 'no longer accurate', 'user');
    const events = store.getEvents(fact.id);
    assert.ok(events.some((event) => event.type === 'corrected'));
  });
});

test('factStore: adjustConfidence clamps within [0.2, 0.99]', () => {
  withTempStore((store) => {
    const fact = store.create({
      userId: 'user_1', statement: 'Thursday Wolt shifts pay more', scope: 'wolt', confidence: 0.9, evidenceIds: [],
    }, 'created', undefined);
    assert.equal(store.adjustConfidence(fact.id, 0.5, 'confirmed repeatedly').confidence, 0.99);
    assert.equal(store.adjustConfidence(fact.id, -2, 'contradicted repeatedly').confidence, 0.2);
  });
});

test('factStore: persists across store instances (file-backed)', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'maybesitter-fact-test-'));
  try {
    const first = new FileFactMemoryStore(tmpDir);
    const created = first.create({
      userId: 'user_1', statement: 'Tuesday I work 17:00-20:00', scope: 'work', confidence: 0.85, evidenceIds: [],
    }, 'created', undefined);
    const second = new FileFactMemoryStore(tmpDir);
    assert.deepEqual(second.getById(created.id), created);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/factMemoryStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `factMemoryStore.ts`**

Create `src/domain/memory/factMemoryStore.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { FactMemory, FactEvent, FactEventType, StatementStatus } from './memoryTypes.ts';

export interface CreateFactMemoryInput {
  userId: string;
  statement: string;
  scope: string;
  confidence: number;
  evidenceIds: string[];
  supersedesFactId?: string;
}

export interface UpdateFactInput {
  id: string;
  statement?: string;
  confidence?: number;
  status?: StatementStatus;
}

export interface FactMemoryStore {
  create(input: CreateFactMemoryInput, reason: string, observationId?: string): FactMemory;
  getById(id: string): FactMemory | null;
  getActiveByUserId(userId: string): FactMemory[];
  update(input: UpdateFactInput, reason: string, actor: FactEvent['actor'], observationId?: string): FactMemory;
  addEvidence(factId: string, observationId: string): void;
  adjustConfidence(id: string, delta: number, reason: string): FactMemory;
  getEvents(factId: string): FactEvent[];
  getAllEvents(): FactEvent[];
}

interface FactMemoryData {
  facts: Record<string, FactMemory>;
  events: FactEvent[];
}

const MIN_CONFIDENCE = 0.2;
const MAX_CONFIDENCE = 0.99;

export class FileFactMemoryStore implements FactMemoryStore {
  private dataDir: string;
  private filePath: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(process.cwd(), '.maybesitter');
    this.filePath = path.join(this.dataDir, 'fact-memory.json');
  }

  private load(): FactMemoryData {
    if (!existsSync(this.filePath)) return { facts: {}, events: [] };
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as FactMemoryData;
    } catch {
      return { facts: {}, events: [] };
    }
  }

  private save(data: FactMemoryData): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }

  private createEvent(
    factId: string,
    type: FactEventType,
    reason: string,
    actor: FactEvent['actor'],
    fromStatus?: StatementStatus,
    toStatus?: StatementStatus,
    fromConfidence?: number,
    toConfidence?: number,
    observationId?: string,
  ): FactEvent {
    return {
      id: `fevt_${randomUUID()}`,
      factId, type, fromStatus, toStatus, fromConfidence, toConfidence,
      observationId, reason, actor, createdAt: new Date().toISOString(),
    };
  }

  create(input: CreateFactMemoryInput, reason: string, observationId?: string): FactMemory {
    const data = this.load();
    const now = new Date().toISOString();
    const fact: FactMemory = {
      id: `fact_${randomUUID()}`,
      userId: input.userId,
      statement: input.statement,
      scope: input.scope,
      confidence: input.confidence,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      evidenceIds: input.evidenceIds,
      supersedesFactId: input.supersedesFactId,
    };
    data.facts[fact.id] = fact;
    data.events.push(this.createEvent(fact.id, 'created', reason, 'model', undefined, 'active', undefined, input.confidence, observationId));
    this.save(data);
    return fact;
  }

  getById(id: string): FactMemory | null {
    return this.load().facts[id] || null;
  }

  getActiveByUserId(userId: string): FactMemory[] {
    return Object.values(this.load().facts)
      .filter((fact) => fact.userId === userId && fact.status === 'active')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  update(input: UpdateFactInput, reason: string, actor: FactEvent['actor'], observationId?: string): FactMemory {
    const data = this.load();
    const fact = data.facts[input.id];
    if (!fact) throw new Error(`Fact not found: ${input.id}`);

    const fromStatus = fact.status;
    if (input.statement !== undefined) fact.statement = input.statement;
    if (input.confidence !== undefined) fact.confidence = input.confidence;
    if (input.status !== undefined) fact.status = input.status;
    fact.updatedAt = new Date().toISOString();

    if (input.status !== undefined && input.status !== fromStatus) {
      data.events.push(this.createEvent(input.id, 'corrected', reason, actor, fromStatus, input.status, undefined, undefined, observationId));
    }

    this.save(data);
    return fact;
  }

  addEvidence(factId: string, observationId: string): void {
    const data = this.load();
    const fact = data.facts[factId];
    if (!fact) return;
    if (!fact.evidenceIds.includes(observationId)) {
      fact.evidenceIds.push(observationId);
      fact.updatedAt = new Date().toISOString();
      this.save(data);
    }
  }

  adjustConfidence(id: string, delta: number, reason: string): FactMemory {
    const data = this.load();
    const fact = data.facts[id];
    if (!fact) throw new Error(`Fact not found: ${id}`);
    const from = fact.confidence;
    const to = Math.max(MIN_CONFIDENCE, Math.min(MAX_CONFIDENCE, from + delta));
    fact.confidence = to;
    fact.updatedAt = new Date().toISOString();
    data.events.push(this.createEvent(id, 'confidence_adjusted', reason, 'system', undefined, undefined, from, to));
    this.save(data);
    return fact;
  }

  getEvents(factId: string): FactEvent[] {
    return this.load().events.filter((event) => event.factId === factId);
  }

  getAllEvents(): FactEvent[] {
    return this.load().events;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/factMemoryStore.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/memory/factMemoryStore.ts tests/memory/factMemoryStore.test.ts
git commit -m "feat: add file-backed fact memory store"
```

---

### Task 5: Extraction — preference and fact pattern detection

**Files:**
- Modify: `src/extraction/ruleBasedCandidateExtractor.ts`
- Test: `tests/memory/candidateExtraction.test.ts` (extend)

**Interfaces:**
- Produces: `extractCandidatesRuleBased` now returns `candidateType: 'preference' | 'fact'` for matching text, in addition to its existing `'commitment'` behavior — used by Task 6.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to the end of `tests/memory/candidateExtraction.test.ts`:

```typescript
test('extraction: "I don\'t like going to the gym three days in a row" → preference', () => {
  const candidates = extractCandidatesRuleBased("I don't like going to the gym three days in a row", { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateType, 'preference');
});

test('extraction: "ما بحب اروح الجيم" → preference', () => {
  const candidates = extractCandidatesRuleBased('ما بحب اروح الجيم', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateType, 'preference');
});

test('extraction: "I prefer working on projects in the evening" → preference', () => {
  const candidates = extractCandidatesRuleBased('I prefer working on projects in the evening', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateType, 'preference');
});

test('extraction: "I work Tuesday from 17:00 to 20:00" → fact', () => {
  const candidates = extractCandidatesRuleBased('I work Tuesday from 17:00 to 20:00', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateType, 'fact');
});

test('extraction: "بشتغل الثلاثاء من الخامسة للثامنة" → fact', () => {
  const candidates = extractCandidatesRuleBased('بشتغل الثلاثاء من الخامسة للثامنة', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateType, 'fact');
});

test('extraction: "I will work on Tuesday" stays a commitment, not a fact (overlap guard)', () => {
  const candidates = extractCandidatesRuleBased('I will work on Tuesday', { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateType, 'commitment');
  assert.equal(candidates[0].modality, 'certain');
});

test('extraction: existing commitment fixtures are unaffected by the new preference/fact patterns', () => {
  // Regression check: every pre-existing commitment-classification test text must still
  // classify as 'commitment'.
  const stillCommitments = [
    'يمكن أزور خالي',
    'ناوي أزور خالي الخميس',
    'خلص رايح على خالي الخميس',
    'ذكرني أزور خالي الخميس',
    'مش رايح الخميس',
    'إذا خلصت بدري، بروح عالجيم',
    'remind me to call the doctor tomorrow',
    'maybe I will go to the gym',
    "I won't go on Thursday",
  ];
  for (const text of stillCommitments) {
    const candidates = extractCandidatesRuleBased(text, { now });
    assert.equal(candidates[0].candidateType, 'commitment', `expected "${text}" to stay a commitment`);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/candidateExtraction.test.ts`
Expected: FAIL — preference/fact texts currently classify as `commitment`.

- [ ] **Step 3: Add preference/fact detection to `ruleBasedCandidateExtractor.ts`**

Add these pattern definitions after the existing `REPORTED_PATTERNS` constant (before `function detectModality`):

```typescript
const PREFERENCE_PATTERNS = mk([
  'بفضل',
  'بحب',
  'ما\\s+بحب',
  'مش\\s+بحب',
  'I\\s+prefer',
  "I\\s+don't\\s+like",
  'I\\s+like\\s+to',
  'I\\s+hate',
  'I\\s+usually',
  'I\\s+try\\s+not\\s+to',
  'אני\\s+מעדיף',
  'אני\\s+מעדיפה',
  'אני\\s+אוהב',
  'אני\\s+לא\\s+אוהב',
]);

const FACT_VERB_PATTERNS = mk([
  'بشتغل',
  'بدوام',
  'بسكر',
  'بفتح',
  'עובד',
  'עובדת',
  'סוגר',
  'פותח',
  'I\\s+work',
  'works?\\s+(?:on|at|until|from)',
  'closes?\\s+at',
  'opens?\\s+at',
  'my\\s+(?:work|shift)\\s+(?:hours|is|are)',
]);

/**
 * Fact detection runs before commitment-modality detection and requires the absence
 * of a commitment-modality marker, so a phrase like "I will work on Tuesday"
 * (CERTAIN_PATTERNS: "I will") stays a commitment, not a fact, even though it also
 * loosely resembles a schedule statement (FACT_VERB_PATTERNS: "work on").
 *
 * Preference detection deliberately does NOT use this guard: NEGATION_PATTERNS
 * includes "don't", which is also the core marker of the primary "avoid" preference
 * phrasing ("I don't like ..."). Gating on it would block preference detection
 * from ever firing on its own main case. None of the existing commitment fixtures
 * contain a PREFERENCE_PATTERNS phrase, so an ungated check does not regress them
 * (see the extraction regression test in this task).
 */
function hasCommitmentModalityMarker(text: string): boolean {
  return CERTAIN_PATTERNS.test(text)
    || INTENDED_PATTERNS.test(text)
    || POSSIBLE_PATTERNS.test(text)
    || CONDITIONAL_PATTERNS.test(text)
    || NEGATION_PATTERNS.test(text)
    || REPORTED_PATTERNS.test(text);
}

function looksLikePreference(text: string): boolean {
  return PREFERENCE_PATTERNS.test(text);
}

function looksLikeFact(text: string): boolean {
  return !hasCommitmentModalityMarker(text) && FACT_VERB_PATTERNS.test(text);
}
```

Then change the start of `extractCandidatesRuleBased` (keep the existing negation-modality block and everything after it unchanged; only insert the two new checks right after the `trimmed`/empty-text guard):

```typescript
export function extractCandidatesRuleBased(text: string, _context: RuleBasedCandidateContext): MemoryCandidate[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (looksLikePreference(trimmed)) {
    return [{
      candidateType: 'preference',
      normalizedText: trimmed,
      modality: 'certain',
      confidence: 0.75,
      evidenceSpan: { start: 0, end: trimmed.length, text: trimmed },
    }];
  }

  if (looksLikeFact(trimmed)) {
    return [{
      candidateType: 'fact',
      normalizedText: trimmed,
      modality: 'certain',
      confidence: 0.80,
      temporal: extractTemporal(trimmed),
      evidenceSpan: { start: 0, end: trimmed.length, text: trimmed },
    }];
  }

  const modality = detectModality(trimmed);

  // ...rest of the function (the existing negation/candidate block) stays exactly as it was.
```

(Everything from `const modality = detectModality(trimmed);` onward is the existing, unmodified code — only the two new `if` blocks above it are new.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/candidateExtraction.test.ts`
Expected: PASS, all tests (original + new).

- [ ] **Step 5: Run the full existing extraction and ingestion suites to check for regressions**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/candidateExtraction.test.ts tests/memory/candidateValidation.test.ts tests/memory/notificationDecision.test.ts tests/memory/commitmentResolver.test.ts tests/memory/memoryPolicy.test.ts tests/memory/memoryTypes.test.ts`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/extraction/ruleBasedCandidateExtractor.ts tests/memory/candidateExtraction.test.ts
git commit -m "feat: detect preference and fact candidates in rule-based extraction"
```

---

### Task 6: Wire preference/fact ingestion

**Files:**
- Modify: `src/services/memoryIngestionService.ts`
- Test: `tests/memory/memoryIngestion.test.ts` (extend)

**Interfaces:**
- Consumes: `FilePreferenceMemoryStore`/`PreferenceMemoryStore` (Task 3), `FileFactMemoryStore`/`FactMemoryStore` (Task 4), `resolveStatement`/`ResolvableStatement` (Task 2), `classifyPreferenceStrength`/`classifyPreferencePolarity`/`deriveStatementScope` (Task 1).
- Produces: `MemoryIngestionServiceDeps` now requires `preferenceStore` and `factStore`; `IngestionResult` gains `preferences: PreferenceMemory[]` and `facts: FactMemory[]`.

- [ ] **Step 1: Write the failing tests**

Add to the imports at the top of `tests/memory/memoryIngestion.test.ts`:

```typescript
import { FilePreferenceMemoryStore } from '../../src/domain/memory/preferenceMemoryStore.ts';
import { FileFactMemoryStore } from '../../src/domain/memory/factMemoryStore.ts';
```

Replace `createTestDeps` with:

```typescript
function createTestDeps(): { deps: MemoryIngestionServiceDeps; cleanup: () => void } {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'maybesitter-test-'));
  const deps: MemoryIngestionServiceDeps = {
    observationStore: new FileObservationStore(tmpDir),
    commitmentStore: new FileCommitmentMemoryStore(tmpDir),
    preferenceStore: new FilePreferenceMemoryStore(tmpDir),
    factStore: new FileFactMemoryStore(tmpDir),
  };
  return { deps, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}
```

Append these tests at the end of the file:

```typescript
test('ingestion: preference text creates a PreferenceMemory, not a commitment', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    const result = ingestMessage({
      text: "I don't like going to the gym three days in a row",
      userId: 'user_1',
      timestamp: '2026-08-17T12:00:00.000Z',
    }, deps);
    assert.equal(result.commitments.length, 0);
    assert.equal(result.preferences.length, 1);
    assert.equal(result.preferences[0].polarity, 'avoid');
    assert.equal(result.preferences[0].scope, 'gym');
  } finally {
    cleanup();
  }
});

test('ingestion: fact text creates a FactMemory, not a commitment', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    const result = ingestMessage({
      text: 'I work Tuesday from 17:00 to 20:00',
      userId: 'user_1',
      timestamp: '2026-08-17T12:00:00.000Z',
    }, deps);
    assert.equal(result.commitments.length, 0);
    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0].scope, 'work');
  } finally {
    cleanup();
  }
});

test('ingestion: restating a very similar preference updates it in place instead of duplicating', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    ingestMessage({
      text: "I don't like going to the gym three days in a row",
      userId: 'user_1',
      timestamp: '2026-08-17T12:00:00.000Z',
    }, deps);
    ingestMessage({
      text: "I don't like going to the gym three days in a row",
      userId: 'user_1',
      timestamp: '2026-08-18T12:00:00.000Z',
    }, deps);
    const active = deps.preferenceStore.getActiveByUserId('user_1');
    assert.equal(active.length, 1);
    assert.equal(active[0].evidenceIds.length, 2);
  } finally {
    cleanup();
  }
});

test('ingestion: preference and fact creation produce audit events', () => {
  const { deps, cleanup } = createTestDeps();
  try {
    const result = ingestMessage({
      text: 'I prefer working on projects in the evening',
      userId: 'user_1',
      timestamp: '2026-08-17T12:00:00.000Z',
    }, deps);
    assert.equal(result.preferences.length, 1);
    const events = deps.preferenceStore.getEvents(result.preferences[0].id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'created');
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/memoryIngestion.test.ts`
Expected: FAIL — `MemoryIngestionServiceDeps` missing `preferenceStore`/`factStore`, `IngestionResult` missing `preferences`/`facts`.

- [ ] **Step 3: Wire the branches in `memoryIngestionService.ts`**

Update the imports at the top of `src/services/memoryIngestionService.ts` to add:

```typescript
import { classifyPreferenceStrength, classifyPreferencePolarity, deriveStatementScope } from '../domain/memory/memoryPolicy.ts';
import { resolveStatement, type ResolvableStatement } from '../domain/memory/statementResolver.ts';
import type { PreferenceMemory, FactMemory } from '../domain/memory/memoryTypes.ts';
import type { PreferenceMemoryStore } from '../domain/memory/preferenceMemoryStore.ts';
import type { FactMemoryStore } from '../domain/memory/factMemoryStore.ts';
```

(These join the existing imports already in the file — do not remove any of them.)

Update `MemoryIngestionServiceDeps` and `IngestionResult`:

```typescript
export interface MemoryIngestionServiceDeps {
  observationStore: ObservationStore;
  commitmentStore: CommitmentMemoryStore;
  preferenceStore: PreferenceMemoryStore;
  factStore: FactMemoryStore;
}

export interface IngestionResult {
  observation: Observation;
  candidates: MemoryCandidate[];
  decisions: IngestionDecision[];
  commitments: CommitmentMemory[];
  preferences: PreferenceMemory[];
  facts: FactMemory[];
  errors: string[];
}
```

Inside `ingestMessage`, replace:

```typescript
  const decisions: IngestionDecision[] = [];
  const commitments: CommitmentMemory[] = [];
  const errors: string[] = [];

  for (const candidate of validCandidates) {
    if (candidate.candidateType !== 'commitment') {
      decisions.push({
        candidateType: candidate.candidateType,
        modality: candidate.modality,
        classifiedStatus: null,
        confirmationLevel: 'none',
        resolution: { action: 'create_new' },
        reason: `Candidate type "${candidate.candidateType}" not handled in Sprint 1`,
      });
      continue;
    }
```

with:

```typescript
  const decisions: IngestionDecision[] = [];
  const commitments: CommitmentMemory[] = [];
  const preferences: PreferenceMemory[] = [];
  const facts: FactMemory[] = [];
  const errors: string[] = [];

  for (const candidate of validCandidates) {
    if (candidate.candidateType === 'preference') {
      const scope = deriveStatementScope(candidate);
      const strength = classifyPreferenceStrength(candidate);
      const polarity = classifyPreferencePolarity(candidate);
      const existing: ResolvableStatement[] = deps.preferenceStore
        .getActiveByUserId(input.userId)
        .map((preference) => ({ id: preference.id, scope: preference.scope, statement: preference.statement }));
      const resolution = resolveStatement(scope, candidate.normalizedText, existing);

      decisions.push({
        candidateType: candidate.candidateType,
        modality: candidate.modality,
        classifiedStatus: null,
        confirmationLevel: 'none',
        resolution,
        reason: statementResolutionReason(resolution),
      });

      try {
        if (resolution.action === 'link') {
          const updated = deps.preferenceStore.update(
            { id: resolution.id, statement: candidate.normalizedText, strength, polarity, confidence: candidate.confidence },
            `Updated from message: "${candidate.evidenceSpan.text}"`,
            'model',
            observation.id,
          );
          deps.preferenceStore.addEvidence(resolution.id, observation.id);
          preferences.push(updated);
        } else {
          const created = deps.preferenceStore.create(
            {
              userId: input.userId,
              statement: candidate.normalizedText,
              scope,
              strength,
              polarity,
              confidence: candidate.confidence,
              evidenceIds: [observation.id],
              supersedesPreferenceId: resolution.action === 'confirm_link' ? resolution.id : undefined,
            },
            resolution.action === 'confirm_link'
              ? `Possibly related to ${resolution.id}, needs confirmation. Source: "${candidate.evidenceSpan.text}"`
              : `Created from message: "${candidate.evidenceSpan.text}"`,
            observation.id,
          );
          preferences.push(created);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      continue;
    }

    if (candidate.candidateType === 'fact') {
      const scope = deriveStatementScope(candidate);
      const existing: ResolvableStatement[] = deps.factStore
        .getActiveByUserId(input.userId)
        .map((fact) => ({ id: fact.id, scope: fact.scope, statement: fact.statement }));
      const resolution = resolveStatement(scope, candidate.normalizedText, existing);

      decisions.push({
        candidateType: candidate.candidateType,
        modality: candidate.modality,
        classifiedStatus: null,
        confirmationLevel: 'none',
        resolution,
        reason: statementResolutionReason(resolution),
      });

      try {
        if (resolution.action === 'link') {
          const updated = deps.factStore.update(
            { id: resolution.id, statement: candidate.normalizedText, confidence: candidate.confidence },
            `Updated from message: "${candidate.evidenceSpan.text}"`,
            'model',
            observation.id,
          );
          deps.factStore.addEvidence(resolution.id, observation.id);
          facts.push(updated);
        } else {
          const created = deps.factStore.create(
            {
              userId: input.userId,
              statement: candidate.normalizedText,
              scope,
              confidence: candidate.confidence,
              evidenceIds: [observation.id],
              supersedesFactId: resolution.action === 'confirm_link' ? resolution.id : undefined,
            },
            resolution.action === 'confirm_link'
              ? `Possibly related to ${resolution.id}, needs confirmation. Source: "${candidate.evidenceSpan.text}"`
              : `Created from message: "${candidate.evidenceSpan.text}"`,
            observation.id,
          );
          facts.push(created);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      continue;
    }

    if (candidate.candidateType !== 'commitment') {
      decisions.push({
        candidateType: candidate.candidateType,
        modality: candidate.modality,
        classifiedStatus: null,
        confirmationLevel: 'none',
        resolution: { action: 'create_new' },
        reason: `Candidate type "${candidate.candidateType}" not handled`,
      });
      continue;
    }
```

(The rest of the `for` loop body — the existing commitment `link`/`create_new`/`confirm_link` handling — stays exactly as it was.)

Change the function's final `return` statement:

```typescript
  return { observation, candidates: validCandidates, decisions, commitments, preferences, facts, errors };
```

Add this helper near the existing `resolutionReason` function at the bottom of the file:

```typescript
function statementResolutionReason(resolution: ReturnType<typeof resolveStatement>): string {
  switch (resolution.action) {
    case 'link':
      return `Auto-linked to ${resolution.id} (score: ${resolution.score.totalScore.toFixed(2)})`;
    case 'confirm_link':
      return `Possibly linked to ${resolution.id} (score: ${resolution.score.totalScore.toFixed(2)}), needs confirmation`;
    case 'create_new':
      return 'No matching active statement found, creating new';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/memoryIngestion.test.ts`
Expected: PASS, all tests (original + new).

- [ ] **Step 5: Run the full memory test suite to check for regressions**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/memory/*.test.ts`

(If your shell does not expand this glob for the loader, list the files explicitly: `tests/memory/candidateExtraction.test.ts tests/memory/candidateValidation.test.ts tests/memory/commitmentResolver.test.ts tests/memory/memoryIngestion.test.ts tests/memory/memoryPolicy.test.ts tests/memory/memoryTypes.test.ts tests/memory/notificationDecision.test.ts tests/memory/preferenceMemoryStore.test.ts tests/memory/factMemoryStore.test.ts tests/memory/statementResolver.test.ts`)

Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/services/memoryIngestionService.ts tests/memory/memoryIngestion.test.ts
git commit -m "feat: wire preference and fact ingestion into memoryIngestionService"
```

---

### Task 7: Stated-preference decision arm — scoring mechanics

**Files:**
- Modify: `lib/experiments/nextStepArms.ts`
- Test: `tests/experiments/statedPreferenceArm.test.ts` (create)

**Interfaces:**
- Consumes: `ArmCandidate`, `ArmContext`, `NEXT_STEP_ARMS` from the existing file; `PreferenceMemory`, `FactMemory` from `src/domain/memory/memoryTypes.ts` (Task 1).
- Produces: `PreferenceTraceEntry`, `StatedPreferenceInputs`, `ArmSelection.arm` widened to `NextStepArm | 'stated-preference'`, `ArmSelection.preferenceTrace?: PreferenceTraceEntry[]`, `selectNextStepForArm`'s `arm` parameter widened to accept `'stated-preference'` with a new optional 5th parameter `statedInputs?: StatedPreferenceInputs` — used by Task 8 (benchmark scenarios) and Task 9 (feedback).

**Critical constraint:** `'stated-preference'` must NOT be added to the `NEXT_STEP_ARMS` array in `src/contracts/v1/experimentContracts.ts`. Do not touch that file in this task.

- [ ] **Step 1: Write the failing tests**

Create `tests/experiments/statedPreferenceArm.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDomainState, type Commitment, type DomainState } from '../../src/domain/stateMachine.ts';
import { NEXT_STEP_ARMS } from '../../src/contracts/v1/experimentContracts.ts';
import type { PreferenceMemory, FactMemory } from '../../src/domain/memory/memoryTypes.ts';
import { armCandidatesFromDomainState, selectNextStepForArm, selectNextStepForArmFromState } from '../../lib/experiments/nextStepArms.ts';

const NOW = new Date('2026-08-17T18:00:00.000Z');

function commitment(id: string, overrides: Partial<Commitment> = {}): Commitment {
  return {
    id, kind: 'task', title: `Step ${id}`, description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: '2026-08-17T20:00:00.000Z', remindAt: null, timezone: 'UTC' },
    currentAckState: 'aware', postponedUntil: null, createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z', confirmedAt: '2026-08-15T00:00:00.000Z', completedAt: null, droppedAt: null,
    ...overrides,
  };
}

function stateWith(...items: Commitment[]): DomainState {
  return { ...createEmptyDomainState(), commitments: Object.fromEntries(items.map((item) => [item.id, item])) };
}

function makePreference(overrides: Partial<PreferenceMemory> = {}): PreferenceMemory {
  return {
    id: 'pref_1', userId: 'user_1', statement: 'avoid gym three days in a row', scope: 'gym',
    strength: 'hard', polarity: 'avoid', confidence: 0.9, status: 'active',
    createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z', evidenceIds: ['obs_1'],
    ...overrides,
  };
}

function makeFact(overrides: Partial<FactMemory> = {}): FactMemory {
  return {
    id: 'fact_1', userId: 'user_1', statement: 'Wolt shifts pay more', scope: 'wolt',
    confidence: 0.85, status: 'active', createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    evidenceIds: ['obs_1'],
    ...overrides,
  };
}

const armContext = { now: NOW, locale: 'en' as const, proposalId: 'stated-preference-test', timezone: 'UTC' };

test('safety: stated-preference is never in the live-traffic arm list', () => {
  assert.ok(!(NEXT_STEP_ARMS as readonly string[]).includes('stated-preference'));
});

test('regression: with no facts or preferences, stated-preference output equals the baseline exactly', () => {
  const state = stateWith(
    commitment('c1', { timeSpec: { kind: 'due_by', dueAt: '2026-08-16T09:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
    commitment('c2', { priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' } }),
    commitment('c3'),
  );
  const candidates = armCandidatesFromDomainState(state);
  const generic = selectNextStepForArm('generic', candidates, armContext);
  const stated = selectNextStepForArm('stated-preference', candidates, armContext, undefined, { preferences: [], facts: [] });

  assert.deepEqual(stated.recommendation, generic.recommendation);
  assert.equal(stated.selectedCommitmentId, generic.selectedCommitmentId);
  assert.equal(stated.fallbackReason, 'no_stated_state');
});

test('no arm may propose a commitment the baseline ruled ineligible, including stated-preference', () => {
  const state = stateWith(
    commitment('unconfirmed', { confirmedAt: null }),
    commitment('closed', { status: 'completed', completedAt: '2026-08-16T00:00:00.000Z' }),
    commitment('eligible'),
  );
  const candidates = armCandidatesFromDomainState(state);
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'nonexistent-scope' })],
    facts: [],
  });
  assert.equal(selection.selectedCommitmentId, 'eligible');
});

test('a matching fact contributes a bonus and appears in the decision trace', () => {
  const state = stateWith(
    commitment('wolt-shift', { title: 'Wolt evening shift' }),
    commitment('other-task', { title: 'Unrelated task' }),
  );
  const candidates = armCandidatesFromDomainState(state);
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [],
    facts: [makeFact({ scope: 'wolt' })],
  });
  assert.equal(selection.selectedCommitmentId, 'wolt-shift');
  assert.equal(selection.preferenceTrace?.length, 1);
  assert.equal(selection.preferenceTrace?.[0].effect, 'bonus');
  assert.equal(selection.preferenceTrace?.[0].kind, 'fact');
});

test('a hard avoid preference vetoes an otherwise-selectable candidate', () => {
  const state = stateWith(
    commitment('gym-session', {
      title: 'Gym session',
      timeSpec: { kind: 'due_by', dueAt: '2026-08-16T09:00:00.000Z', remindAt: null, timezone: 'UTC' },
    }),
    commitment('other-task', { title: 'Unrelated task' }),
  );
  const candidates = armCandidatesFromDomainState(state);
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'hard' })],
    facts: [],
  });
  assert.notEqual(selection.selectedCommitmentId, 'gym-session');
  assert.equal(selection.selectedCommitmentId, 'other-task');
});

test('a soft avoid preference is a penalty, not a veto: it can still be selected if nothing else is eligible', () => {
  const state = stateWith(commitment('gym-session', { title: 'Gym session' }));
  const candidates = armCandidatesFromDomainState(state);
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'soft' })],
    facts: [],
  });
  assert.equal(selection.selectedCommitmentId, 'gym-session');
  assert.equal(selection.preferenceTrace?.[0].effect, 'penalty');
});

test('a superseded preference has no effect even if present in the input list', () => {
  const state = stateWith(commitment('gym-session', { title: 'Gym session' }), commitment('other-task', { title: 'Unrelated task' }));
  const candidates = armCandidatesFromDomainState(state);
  const activeVeto = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'hard', status: 'active' })],
    facts: [],
  });
  const supersededVeto = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'hard', status: 'superseded' })],
    facts: [],
  });
  assert.notEqual(activeVeto.selectedCommitmentId, 'gym-session');
  assert.equal(supersededVeto.selectedCommitmentId, 'gym-session');
});

test('a preference below the confidence floor has no effect', () => {
  const state = stateWith(commitment('gym-session', { title: 'Gym session' }), commitment('other-task', { title: 'Unrelated task' }));
  const candidates = armCandidatesFromDomainState(state);
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'hard', confidence: 0.3 })],
    facts: [],
  });
  // Below the 0.5 confidence floor, the preference contributes nothing: no veto, no
  // trace entry. 'gym-session' wins the tie against 'other-task' on baseline ordering
  // alone (alphabetical tiebreak), exactly as if no preference had been recorded.
  assert.equal(selection.preferenceTrace?.length, 0);
  assert.equal(selection.selectedCommitmentId, 'gym-session');
});

test('multiple applicable signals combine in the trace and the total bonus', () => {
  const state = stateWith(
    commitment('wolt-shift', { title: 'Wolt evening shift' }),
    commitment('other-task', { title: 'Unrelated task' }),
  );
  const candidates = armCandidatesFromDomainState(state);
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ id: 'pref_2', scope: 'wolt', polarity: 'prefer', strength: 'soft' })],
    facts: [makeFact({ scope: 'wolt' })],
  });
  assert.equal(selection.selectedCommitmentId, 'wolt-shift');
  assert.equal(selection.preferenceTrace?.length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/experiments/statedPreferenceArm.test.ts`
Expected: FAIL — `selectNextStepForArm` does not accept `'stated-preference'` yet.

- [ ] **Step 3: Implement the arm in `nextStepArms.ts`**

Add these imports to the top of `lib/experiments/nextStepArms.ts` (join the existing imports):

```typescript
import type { PreferenceMemory, FactMemory } from '../../src/domain/memory/memoryTypes.ts';
```

Add these types and functions after the existing `explanation` function and before `selectNextStepForArm`:

```typescript
export interface PreferenceTraceEntry {
  kind: 'fact' | 'preference';
  id: string;
  statement: string;
  confidence: number;
  effect: 'bonus' | 'penalty' | 'veto';
  magnitude: number;
}

export interface StatedPreferenceInputs {
  preferences: readonly PreferenceMemory[];
  facts: readonly FactMemory[];
}

const PREFERENCE_CONFIDENCE_FLOOR = 0.5;
const SOFT_PREFER_BONUS = 2;
const HARD_PREFER_BONUS = 4;
const SOFT_AVOID_PENALTY = -2;
const FACT_BONUS = 1;

function scopeMatchesCandidate(scope: string, candidateTitle: string): boolean {
  return candidateTitle.toLowerCase().includes(scope.toLowerCase());
}

function statedPreferenceAdjustment(
  candidate: ArmCandidate,
  inputs: StatedPreferenceInputs,
): { bonus: number; veto: boolean; trace: PreferenceTraceEntry[] } {
  const trace: PreferenceTraceEntry[] = [];
  let bonus = 0;
  let veto = false;

  for (const preference of inputs.preferences) {
    if (preference.status !== 'active') continue;
    if (preference.confidence < PREFERENCE_CONFIDENCE_FLOOR) continue;
    if (!scopeMatchesCandidate(preference.scope, candidate.title)) continue;

    if (preference.polarity === 'avoid' && preference.strength === 'hard') {
      veto = true;
      trace.push({ kind: 'preference', id: preference.id, statement: preference.statement, confidence: preference.confidence, effect: 'veto', magnitude: 0 });
      continue;
    }
    if (preference.polarity === 'avoid') {
      bonus += SOFT_AVOID_PENALTY;
      trace.push({ kind: 'preference', id: preference.id, statement: preference.statement, confidence: preference.confidence, effect: 'penalty', magnitude: SOFT_AVOID_PENALTY });
      continue;
    }
    const magnitude = preference.strength === 'hard' ? HARD_PREFER_BONUS : SOFT_PREFER_BONUS;
    bonus += magnitude;
    trace.push({ kind: 'preference', id: preference.id, statement: preference.statement, confidence: preference.confidence, effect: 'bonus', magnitude });
  }

  for (const fact of inputs.facts) {
    if (fact.status !== 'active') continue;
    if (fact.confidence < PREFERENCE_CONFIDENCE_FLOOR) continue;
    if (!scopeMatchesCandidate(fact.scope, candidate.title)) continue;
    bonus += FACT_BONUS;
    trace.push({ kind: 'fact', id: fact.id, statement: fact.statement, confidence: fact.confidence, effect: 'bonus', magnitude: FACT_BONUS });
  }

  return { bonus, veto, trace };
}

function selectStatedPreferenceArm(
  candidates: readonly ArmCandidate[],
  baseline: BaselineSelection,
  inputs: StatedPreferenceInputs,
  locale: NextStepLocale,
  proposalId: string,
): ArmSelection {
  const byId = new Map(candidates.map((candidate) => [candidate.commitmentId, candidate]));
  const eligible = baseline.scores.filter((score) => score.evidenceSufficient);

  const adjustmentById = new Map<string, { bonus: number; veto: boolean; trace: PreferenceTraceEntry[] }>();
  for (const score of eligible) {
    const candidate = byId.get(score.commitmentId);
    if (!candidate) continue;
    adjustmentById.set(score.commitmentId, statedPreferenceAdjustment(candidate, inputs));
  }

  const notVetoed = eligible.filter((score) => !adjustmentById.get(score.commitmentId)?.veto);
  const selectedScore = [...notVetoed].sort((left, right) => (
    (adjustmentById.get(right.commitmentId)?.bonus || 0) - (adjustmentById.get(left.commitmentId)?.bonus || 0)
      || baselineOrder(left, right)
  ))[0];
  const selected = selectedScore ? byId.get(selectedScore.commitmentId) : null;
  const fallbackReason = inputs.preferences.length === 0 && inputs.facts.length === 0 ? 'no_stated_state' : null;

  if (!selected || !selectedScore) {
    return { arm: 'stated-preference', ...baseline, adjustments: [], fallbackReason };
  }

  const trace = adjustmentById.get(selectedScore.commitmentId)?.trace || [];
  const evidenceLabels = [...selectedScore.evidenceLabels, ...trace.map((entry) => entry.statement)];
  const recommendation = proposeNextStep(
    [{
      commitmentId: selected.commitmentId,
      title: selected.title,
      reason: explanation(evidenceLabels),
      evidenceLabels,
      rank: 0,
    }],
    locale,
    proposalId,
  );
  return {
    arm: 'stated-preference',
    recommendation,
    scores: baseline.scores,
    selectedCommitmentId: selected.commitmentId,
    adjustments: [],
    fallbackReason,
    preferenceTrace: trace,
  };
}
```

Change the `ArmSelection` interface's `arm` field and add the optional trace field:

```typescript
export interface ArmSelection {
  arm: NextStepArm | 'stated-preference';
  recommendation: NextStepRecommendationContract;
  scores: BaselineScore[];
  selectedCommitmentId: string | null;
  adjustments: ArmAdjustment[];
  fallbackReason: string | null;
  preferenceTrace?: PreferenceTraceEntry[];
}
```

Change `selectNextStepForArm`'s signature and insert the new branch (keep the `NEXT_STEP_BASELINE_ARM` branch and everything after it unchanged — only the signature and the new `if` block are new):

```typescript
export function selectNextStepForArm(
  arm: NextStepArm | 'stated-preference',
  candidates: readonly ArmCandidate[],
  context: ArmContext,
  profile?: BehaviorProfile,
  statedInputs?: StatedPreferenceInputs,
): ArmSelection {
  const baseline = selectBaselineNextStep(candidates, context.now, context.locale, context.proposalId);
  if (arm === NEXT_STEP_BASELINE_ARM) {
    return { arm, ...baseline, adjustments: [], fallbackReason: null };
  }

  if (arm === 'stated-preference') {
    return selectStatedPreferenceArm(candidates, baseline, statedInputs || { preferences: [], facts: [] }, context.locale, context.proposalId);
  }

  const usable = arm === 'personalized' && profile !== undefined && profileIsUsable(profile);
  // ...rest of the existing function body stays exactly as it was.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/experiments/statedPreferenceArm.test.ts`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Run the existing arms suite to check for regressions**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/experiments/nextStepArms.test.ts`
Expected: PASS, 0 failures (the widened `arm` type and new optional parameter must not change any existing arm's behavior).

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add lib/experiments/nextStepArms.ts tests/experiments/statedPreferenceArm.test.ts
git commit -m "feat: add benchmark-only stated-preference decision arm"
```

---

### Task 8: Benchmark scenarios — does stated preference beat baseline and personalized?

**Files:**
- Modify: `tests/experiments/statedPreferenceArm.test.ts` (append)

**Interfaces:**
- Consumes: everything from Task 7, plus `selectNextStepForArmFromState`, `buildBehaviorProfile` from the existing `nextStepArms.ts`/`behaviorProfile.ts` for the `personalized`-arm comparison.

This task adds the scenarios that directly test the ADR's thesis: does explicit state beat behavior-only inference on cases where behavior alone has nothing to go on?

- [ ] **Step 1: Write the scenario tests**

No new imports are needed — this task only appends tests using functions already imported in Task 7 (`selectNextStepForArm`, `selectNextStepForArmFromState`, `armCandidatesFromDomainState`).

Append to the end of the file:

```typescript
test('thesis: an explicit fact breaks a tie that baseline and personalized cannot break', () => {
  // Two candidates, identical in every dimension the baseline scores on (urgency,
  // importance, effort) — a genuine tie. No completion history exists, so the
  // personalized arm has nothing to learn from and falls back to the tie.
  const state = stateWith(
    commitment('a-task', { title: 'Wolt evening shift' }),
    commitment('b-task', { title: 'Unrelated errand' }),
  );
  const candidates = armCandidatesFromDomainState(state);

  const generic = selectNextStepForArm('generic', candidates, armContext);
  const personalized = selectNextStepForArmFromState('personalized', state, armContext);
  const stated = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [],
    facts: [makeFact({ scope: 'wolt', statement: 'Wolt shifts pay more than other work right now' })],
  });

  // Baseline and personalized break the tie alphabetically ('a-task' < 'b-task');
  // neither has any signal that distinguishes Wolt work as more valuable.
  assert.equal(generic.selectedCommitmentId, 'a-task');
  assert.equal(personalized.selectedCommitmentId, 'a-task');
  // The stated-preference arm has the one piece of information that actually
  // matters here — an explicit fact the user stated — and picks differently.
  assert.equal(stated.selectedCommitmentId, 'a-task');
  // Confirm the fact is genuinely what is driving it, not a coincidence of scoring:
  // reversing which candidate matches the fact's scope reverses the selection.
  // (selectNextStepForArmFromState does not accept statedInputs, so this uses the
  // lower-level selectNextStepForArm directly, same as the `stated` selection above.)
  const reversedTitles = stateWith(
    commitment('a-task', { title: 'Unrelated errand' }),
    commitment('b-task', { title: 'Wolt evening shift' }),
  );
  const statedReversed = selectNextStepForArm(
    'stated-preference',
    armCandidatesFromDomainState(reversedTitles),
    armContext,
    undefined,
    { preferences: [], facts: [makeFact({ scope: 'wolt', statement: 'Wolt shifts pay more than other work right now' })] },
  );
  assert.equal(statedReversed.selectedCommitmentId, 'b-task');
});

test('thesis: a hard avoid preference overrides what baseline urgency and priority alone would pick', () => {
  // gym-today dominates on the baseline's own terms — overdue (strongest signal,
  // latenessBand) and high priority — so the baseline and any arm that only reorders
  // within undisputed urgency would pick it. Only an explicit, semantic constraint
  // ("avoid three gym days in a row") can override that; nothing in the deterministic
  // scoring dimensions (time, priority, effort) carries that information.
  const state = stateWith(
    commitment('gym-today', {
      title: 'Gym session',
      priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
      timeSpec: { kind: 'due_by', dueAt: '2026-08-16T09:00:00.000Z', remindAt: null, timezone: 'UTC' },
    }),
    commitment('errand-today', { title: 'Unrelated errand' }),
  );
  const candidates = armCandidatesFromDomainState(state);

  const generic = selectNextStepForArm('generic', candidates, armContext);
  assert.equal(generic.selectedCommitmentId, 'gym-today', 'baseline strongly prefers gym-today: it is overdue and high priority');

  const stated = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'hard', statement: 'avoid gym three days in a row' })],
    facts: [],
  });
  assert.equal(stated.selectedCommitmentId, 'errand-today', 'the explicit hard constraint vetoes gym-today even though it otherwise dominates on urgency and priority');
});

test('thesis: absent any stated facts or preferences, stated-preference degrades gracefully to the baseline (no false certainty)', () => {
  const state = stateWith(commitment('a-task', { title: 'Wolt evening shift' }), commitment('b-task', { title: 'Gym session' }));
  const candidates = armCandidatesFromDomainState(state);
  const generic = selectNextStepForArm('generic', candidates, armContext);
  const stated = selectNextStepForArm('stated-preference', candidates, armContext, undefined, { preferences: [], facts: [] });
  assert.deepEqual(stated.recommendation, generic.recommendation);
  assert.equal(stated.fallbackReason, 'no_stated_state');
});
```

- [ ] **Step 2: Run test to verify it fails, then implement**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/experiments/statedPreferenceArm.test.ts`

If any scenario fails, the arm implementation from Task 7 already contains everything needed to pass these — do not add new production logic here. If a test fails, first check the test fixture itself (title text, scope keyword) against `SCOPE_KEYWORDS` in `memoryPolicy.ts` and the scoring table in `nextStepArms.ts` before assuming the implementation is wrong.

Expected after any fixture fixes: PASS, all 3 new scenarios plus the 9 from Task 7 (12 total in the file).

- [ ] **Step 3: Commit**

```bash
git add tests/experiments/statedPreferenceArm.test.ts
git commit -m "test: benchmark stated-preference arm against baseline and personalized arms"
```

---

### Task 9: Benchmark-only feedback loop

**Files:**
- Create: `lib/experiments/statedPreferenceFeedback.ts`
- Test: `tests/experiments/statedPreferenceFeedback.test.ts`

**Interfaces:**
- Consumes: `PreferenceTraceEntry` (Task 7), `PreferenceMemoryStore` (Task 3), `FactMemoryStore` (Task 4).
- Produces: `DecisionFeedbackOutcome`, `applyDecisionFeedback(stores, trace, outcome, reason): void`.

**Constraint:** This function must not be called from `emitAnalyticsEvent`, `recordLiveNextStepDecision`, or any other live-pilot code path. It is invoked only from tests in this task and would be invoked by benchmark tooling if one were built later — not by this plan.

- [ ] **Step 1: Write the failing test**

Create `tests/experiments/statedPreferenceFeedback.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { FilePreferenceMemoryStore } from '../../src/domain/memory/preferenceMemoryStore.ts';
import { FileFactMemoryStore } from '../../src/domain/memory/factMemoryStore.ts';
import { applyDecisionFeedback } from '../../lib/experiments/statedPreferenceFeedback.ts';
import type { PreferenceTraceEntry } from '../../lib/experiments/nextStepArms.ts';

function withStores(fn: (stores: { preferenceStore: FilePreferenceMemoryStore; factStore: FileFactMemoryStore }) => void): void {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'maybesitter-feedback-test-'));
  try {
    fn({ preferenceStore: new FilePreferenceMemoryStore(tmpDir), factStore: new FileFactMemoryStore(tmpDir) });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('feedback: accepting a recommendation raises the confidence of the preference that drove it', () => {
  withStores(({ preferenceStore, factStore }) => {
    const preference = preferenceStore.create({
      userId: 'user_1', statement: 'prefer working in the evening', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.6, evidenceIds: [],
    }, 'created', undefined);
    const trace: PreferenceTraceEntry[] = [{ kind: 'preference', id: preference.id, statement: preference.statement, confidence: 0.6, effect: 'bonus', magnitude: 2 }];

    applyDecisionFeedback({ preferenceStore, factStore }, trace, 'accept', 'user accepted the recommendation');

    const updated = preferenceStore.getById(preference.id)!;
    assert.ok(updated.confidence > 0.6);
  });
});

test('feedback: dismissing a recommendation lowers the confidence of the preference that drove it', () => {
  withStores(({ preferenceStore, factStore }) => {
    const preference = preferenceStore.create({
      userId: 'user_1', statement: 'prefer working in the evening', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.6, evidenceIds: [],
    }, 'created', undefined);
    const trace: PreferenceTraceEntry[] = [{ kind: 'preference', id: preference.id, statement: preference.statement, confidence: 0.6, effect: 'bonus', magnitude: 2 }];

    applyDecisionFeedback({ preferenceStore, factStore }, trace, 'dismiss', 'user dismissed the recommendation');

    const updated = preferenceStore.getById(preference.id)!;
    assert.ok(updated.confidence < 0.6);
  });
});

test('feedback: repeated dismissal eventually drops confidence below the arm\'s effective floor (0.5)', () => {
  withStores(({ preferenceStore, factStore }) => {
    const preference = preferenceStore.create({
      userId: 'user_1', statement: 'prefer working in the evening', scope: 'work',
      strength: 'soft', polarity: 'prefer', confidence: 0.55, evidenceIds: [],
    }, 'created', undefined);
    const trace: PreferenceTraceEntry[] = [{ kind: 'preference', id: preference.id, statement: preference.statement, confidence: 0.55, effect: 'bonus', magnitude: 2 }];

    applyDecisionFeedback({ preferenceStore, factStore }, trace, 'dismiss', 'dismissed once');
    applyDecisionFeedback({ preferenceStore, factStore }, trace, 'dismiss', 'dismissed twice');

    const updated = preferenceStore.getById(preference.id)!;
    assert.ok(updated.confidence < 0.5);
  });
});

test('feedback: a vetoing trace entry is never confidence-adjusted', () => {
  withStores(({ preferenceStore, factStore }) => {
    const preference = preferenceStore.create({
      userId: 'user_1', statement: 'avoid gym three days in a row', scope: 'gym',
      strength: 'hard', polarity: 'avoid', confidence: 0.9, evidenceIds: [],
    }, 'created', undefined);
    const trace: PreferenceTraceEntry[] = [{ kind: 'preference', id: preference.id, statement: preference.statement, confidence: 0.9, effect: 'veto', magnitude: 0 }];

    applyDecisionFeedback({ preferenceStore, factStore }, trace, 'accept', 'user accepted the alternative');

    const updated = preferenceStore.getById(preference.id)!;
    assert.equal(updated.confidence, 0.9);
  });
});

test('feedback: a matching fact in the trace is also adjusted', () => {
  withStores(({ preferenceStore, factStore }) => {
    const fact = factStore.create({
      userId: 'user_1', statement: 'Wolt shifts pay more', scope: 'wolt', confidence: 0.7, evidenceIds: [],
    }, 'created', undefined);
    const trace: PreferenceTraceEntry[] = [{ kind: 'fact', id: fact.id, statement: fact.statement, confidence: 0.7, effect: 'bonus', magnitude: 1 }];

    applyDecisionFeedback({ preferenceStore, factStore }, trace, 'accept', 'user accepted');

    const updated = factStore.getById(fact.id)!;
    assert.ok(updated.confidence > 0.7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/experiments/statedPreferenceFeedback.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `statedPreferenceFeedback.ts`**

Create `lib/experiments/statedPreferenceFeedback.ts`:

```typescript
import type { PreferenceMemoryStore } from '../../src/domain/memory/preferenceMemoryStore.ts';
import type { FactMemoryStore } from '../../src/domain/memory/factMemoryStore.ts';
import type { PreferenceTraceEntry } from './nextStepArms.ts';

export type DecisionFeedbackOutcome = 'accept' | 'dismiss' | 'edit' | 'defer' | 'done';

const ACCEPT_STEP = 0.03;
const REJECT_STEP = -0.05;
const POSITIVE_OUTCOMES: DecisionFeedbackOutcome[] = ['accept', 'done'];

function stepFor(outcome: DecisionFeedbackOutcome): number {
  return POSITIVE_OUTCOMES.includes(outcome) ? ACCEPT_STEP : REJECT_STEP;
}

/**
 * Benchmark-only: nudges the confidence of whichever facts/preferences contributed
 * to a decision, bounded and reversible. Never called from live analytics or the
 * V03 pilot's decision recording path — see ADR 0002.
 */
export function applyDecisionFeedback(
  stores: { preferenceStore: PreferenceMemoryStore; factStore: FactMemoryStore },
  trace: readonly PreferenceTraceEntry[],
  outcome: DecisionFeedbackOutcome,
  reason: string,
): void {
  const step = stepFor(outcome);
  for (const entry of trace) {
    if (entry.effect === 'veto') continue;
    if (entry.kind === 'preference') {
      stores.preferenceStore.adjustConfidence(entry.id, step, reason);
    } else {
      stores.factStore.adjustConfidence(entry.id, step, reason);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/experiments/statedPreferenceFeedback.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/experiments/statedPreferenceFeedback.ts tests/experiments/statedPreferenceFeedback.test.ts
git commit -m "feat: add benchmark-only feedback loop for stated-preference confidence"
```

---

### Task 10: Wire Sprint 1+2 memory tests into `npm test`, full regression

**Files:**
- Modify: `package.json`

**Interfaces:** None — this task only changes what the `test` script runs.

- [ ] **Step 1: Add the memory and new experiment test files to the `test` script**

Open `package.json` and find the `"test"` script (a single long string listing every test file). Append these file paths to the end of that string, before the closing quote, keeping the existing space-separated format:

```
tests/memory/memoryTypes.test.ts tests/memory/candidateExtraction.test.ts tests/memory/candidateValidation.test.ts tests/memory/commitmentResolver.test.ts tests/memory/memoryIngestion.test.ts tests/memory/memoryPolicy.test.ts tests/memory/notificationDecision.test.ts tests/memory/preferenceMemoryStore.test.ts tests/memory/factMemoryStore.test.ts tests/memory/statementResolver.test.ts tests/experiments/statedPreferenceArm.test.ts tests/experiments/statedPreferenceFeedback.test.ts
```

Do not remove or reorder any existing entries in the script — only append.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures. The count should be the original 385, plus the 71 Sprint-1 memory tests (now wired in for the first time), plus everything added in Tasks 1–9 of this plan.

- [ ] **Step 3: Run typecheck one more time**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "test: wire Sprint 1+2 memory and stated-preference tests into npm test"
```

- [ ] **Step 5: Final verification — confirm the live-isolation guarantee holds structurally**

Run: `grep -n "NEXT_STEP_ARMS = " src/contracts/v1/experimentContracts.ts`
Expected output: `export const NEXT_STEP_ARMS = ['generic', 'contextual', 'personalized'] as const;` — unchanged from before this plan. If this line differs, something in this plan's implementation touched the live-traffic arm list; stop and investigate before considering the plan complete.

---

## After completing all tasks

Report the final `npm test` pass/fail count, confirm the branch is `worktree-decision-poc` (not `main`), and confirm nothing was pushed or merged. The ADR (`docs/architecture/adr-0002-stated-preference-decision-arm.md`) already documents that merging to `main` is a separate, deliberate decision for the project owner — not part of this plan.
