/**
 * The pack architectural rule, enforced where it is actually true (#528).
 *
 * The issue's "a Pack may not" list is a statement about the import graph:
 * a pack module that *cannot import* the planner cannot call it, and a
 * behavioural test can only sample that. Same reasoning as
 * `tests/watchers/watcherSafety.test.ts`, whose allowlist pattern this file
 * follows — the list is short on purpose, because an architecture whose
 * modules may import anything has its rules as promises rather than facts.
 *
 * What lib/packs may reach: the contracts its manifest is made of, the
 * watcher store it instantiates through, and the RevenueCat entitlement
 * projection it gates on. Everything else the issue forbids — the canonical
 * planner, a commitment writer, an OAuth store, a job scheduler, a
 * notification engine, a UserState construction — is absent from the list,
 * which is the whole mechanism.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKS_LIB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'packs');

/**
 * Imports pack modules are allowed to have. Adding to this list is the
 * architectural decision; the list existing is what makes the rule checkable.
 */
const ALLOWED_IMPORTS = [
  // Contracts: closed vocabularies and interfaces, importing nothing live.
  '../../src/contracts/v1/verticalPackContracts',
  '../../src/contracts/v1/watcherContracts',
  '../../src/contracts/v1/integrationConnectionContracts',
  // The shared doors a pack's configuration passes through.
  '../watchers/watcherStore',
  '../integrations/revenuecat/entitlements',
  // Persistence, for the one thing a pack owns per account: whether it is on,
  // and which watchers its templates produced (#528 rollout). The shared
  // adapter and the shared path builder — a pack gets no store of its own,
  // which is the same rule that denies it an OAuth store or a scheduler.
  '../storage',
  '../storage/paths',
  './packEntitlement',
  './instantiate',
  './catalog',
  './packLifecycle',
  './packWatcherGuard',
] as const;

/**
 * The forbidden half, named so a failure says *what* rule broke rather than
 * merely that an import was unlisted. Matched against the import specifier.
 */
const FORBIDDEN_IMPORTS: readonly { readonly pattern: RegExp; readonly rule: string }[] = [
  { pattern: /planning\/scheduler/, rule: 'a pack may not call the canonical planner' },
  { pattern: /commandService|stateMachine|deterministicStateGateway/, rule: 'a pack may not write Commitments directly' },
  { pattern: /oauth|tokenStore|credentialStore/i, rule: 'a pack may not invent its own OAuth store' },
  { pattern: /\/jobs\/|internalJobs/, rule: 'a pack may not invent its own job scheduler' },
  { pattern: /\/push\/|pushService|notificationEngine/, rule: 'a pack may not invent its own notification engine' },
  { pattern: /userState\/|composeUserState/, rule: 'a pack may not create its own UserState' },
  { pattern: /actionPolicy(?!Contracts)/, rule: 'a pack may not bypass (or reimplement) the Action Policy' },
];

function packSources(): Array<{ file: string; text: string }> {
  return readdirSync(PACKS_LIB)
    .filter((entry) => entry.endsWith('.ts') && statSync(join(PACKS_LIB, entry)).isFile())
    .map((entry) => ({ file: entry, text: readFileSync(join(PACKS_LIB, entry), 'utf8') }));
}

test('lib/packs exists and contains the pack runtime helpers, so the guards below are not vacuous', () => {
  const files = packSources().map((entry) => entry.file);
  assert.ok(files.includes('packEntitlement.ts'), `lib/packs lost packEntitlement.ts (found: ${files.join(', ')})`);
  assert.ok(files.includes('instantiate.ts'), `lib/packs lost instantiate.ts`);
  assert.ok(files.includes('packLifecycle.ts'), `lib/packs lost packLifecycle.ts`);
  assert.ok(files.includes('catalog.ts'), `lib/packs lost catalog.ts`);
  assert.ok(files.includes('packWatcherGuard.ts'), `lib/packs lost packWatcherGuard.ts`);
});

test('no pack module imports outside the allowed list', () => {
  for (const { file, text } of packSources()) {
    for (const match of Array.from(text.matchAll(/from '([^']+)'/g))) {
      assert.ok(
        (ALLOWED_IMPORTS as readonly string[]).includes(match[1]!),
        `lib/packs/${file} imports '${match[1]}', which no pack module may reach`,
      );
    }
  }
});

test('no pack module reaches anything the issue forbids, by name', () => {
  for (const { file, text } of packSources()) {
    for (const match of Array.from(text.matchAll(/from '([^']+)'/g))) {
      for (const { pattern, rule } of FORBIDDEN_IMPORTS) {
        assert.ok(!pattern.test(match[1]!), `lib/packs/${file} imports '${match[1]}': ${rule}`);
      }
    }
  }
});

/**
 * The storage imports, narrowed to identifiers.
 *
 * A pack needs the shared adapter and the shared path builder — it may not
 * have a store of its own, which is the same rule that denies it an OAuth
 * store. But `../storage` exports `getStorage()` and `../storage/paths`
 * exports `COMMITMENTS`, `PROVIDER_CREDENTIALS` and `PROVIDER_OAUTH_STATES`,
 * so allowing the two *specifiers* wholesale would let a pack module write the
 * canonical commitments collection and the OAuth credential store without
 * tripping a single `FORBIDDEN_IMPORTS` pattern — those patterns match import
 * specifiers, and `userSubDoc(uid, PROVIDER_CREDENTIALS, id)` names no module
 * at all. `packsWriteCommitmentsDirectly` and `packsOwnOAuthStore` are exactly
 * the two flags this file exists to enforce, so the rule is restated at the
 * level where it is actually true: which *names* a pack may pull out of
 * storage.
 */
const ALLOWED_STORAGE_BINDINGS: Readonly<Record<string, readonly string[]>> = {
  '../storage': ['getStorage', 'StorageAdapter'],
  // `PACK_INSTALLATIONS` and nothing else: the one collection a pack owns.
  '../storage/paths': ['PACK_INSTALLATIONS', 'userCol', 'userSubDoc'],
};

/** Named bindings of one import statement, with `type` markers and aliases stripped. */
function bindingsOf(clause: string): string[] {
  return clause
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim());
}

test('a pack module pulls only its own names out of shared storage', () => {
  let checked = 0;
  for (const { file, text } of packSources()) {
    for (const match of Array.from(text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g))) {
      const allowed = ALLOWED_STORAGE_BINDINGS[match[2]!];
      if (!allowed) continue;
      for (const binding of bindingsOf(match[1]!)) {
        checked += 1;
        assert.ok(
          allowed.includes(binding),
          `lib/packs/${file} imports '${binding}' from '${match[2]}': a pack may reach only `
            + `${allowed.join(', ')} there — every other collection and helper belongs to somebody else`,
        );
      }
    }
  }
  assert.ok(checked > 0, 'no pack module imports from storage at all; this check would be vacuous');
});

test('no pack module names a collection it does not own', () => {
  // The other half of the same rule, for a name that arrives some way the
  // import check above cannot see (a re-export, a string literal, a namespace
  // import). A pack writes `packInstallations` and reads `watchers` through
  // the store; nothing else in a user's tree is its business to name.
  const FORBIDDEN_COLLECTIONS = [
    'COMMITMENTS', 'PROVIDER_CREDENTIALS', 'PROVIDER_OAUTH_STATES', 'PROVIDER_CONNECTIONS',
    'EVENTS', 'PLANS', 'MEMORY', 'CONSENTS', 'WATCHER_PROPOSALS', 'WATCHER_NOTIFICATIONS',
    "'commitments'", "'providerCredentials'", "'providerOAuthStates'", "'providerConnections'",
  ];
  for (const { file, text } of packSources()) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const name of FORBIDDEN_COLLECTIONS) {
      assert.ok(
        !new RegExp(`(^|[^A-Za-z_])${name.replace(/'/g, "'")}([^A-Za-z_]|$)`).test(code),
        `lib/packs/${file} names ${name}: a pack owns packInstallations and reaches watchers `
          + 'through the store; every other collection belongs to somebody else',
      );
    }
  }
});

test('the pack policy states the rule as data, and is frozen against the judged editing it', async () => {
  const { VERTICAL_PACK_POLICY } = await import('../../src/contracts/v1/verticalPackContracts.ts');
  assert.deepEqual({ ...VERTICAL_PACK_POLICY }, {
    packsCallPlannerDirectly: false,
    packsWriteCommitmentsDirectly: false,
    packsOwnOAuthStore: false,
    packsOwnJobScheduler: false,
    packsOwnNotificationEngine: false,
    packsBypassActionPolicy: false,
    packsOwnUserState: false,
  });
  assert.throws(() => {
    (VERTICAL_PACK_POLICY as unknown as Record<string, boolean>).packsCallPlannerDirectly = true;
  });
});
