/**
 * Cleanup other systems owe a deleted account (UC-1.5, #149).
 *
 * Deleting the account has to revoke what MaybeSitter was granted elsewhere —
 * a Google Calendar token today, whatever a later sprint connects tomorrow. If
 * the deletion engine named those systems directly, every new integration would
 * mean editing the engine, and the one that someone forgets to add is the one
 * that keeps a live grant after the user believes they are gone.
 *
 * So integrations register themselves here and the engine runs whatever is
 * registered. This issue ships the registry; the integrations register their
 * own hooks when they exist.
 *
 * ── A failing hook does not stop the deletion ────────────────────
 *
 * The user's data still goes. An external system that cannot be reached is
 * recorded as `failed` on the receipt and the deletion continues, because
 * leaving the account half-deleted while a third party is down would be worse
 * for the person than an honest note that one revocation did not land. The
 * receipt is where that shows up, so it is visible rather than swallowed.
 */

export interface DeletionHook {
  /** Short, stable, and safe to write on a receipt — never a user identifier. */
  name: string;
  run(uid: string): Promise<void>;
}

const hooks = new Map<string, DeletionHook>();

/**
 * Registers cleanup for one external system. Re-registering a name replaces it,
 * so a module that reloads does not run its hook twice.
 */
export function registerDeletionHook(name: string, run: (uid: string) => Promise<void>): void {
  if (!/^[a-z][A-Za-z0-9]{0,31}$/.test(name)) {
    throw new Error(`a deletion hook name must be a short identifier, not ${JSON.stringify(name)}`);
  }
  hooks.set(name, { name, run });
}

/** Every registered hook, in registration order. */
export function deletionHooks(): DeletionHook[] {
  return Array.from(hooks.values());
}

export function resetDeletionHooksForTests(): void {
  hooks.clear();
}
