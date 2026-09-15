/**
 * Which channel reads a share (UC-3.0, #183).
 *
 * ── Why a registry and not a switch ──────────────────────────────
 *
 * Four issues are adding a channel at once (#189–#192). A `switch (kind)` here
 * would be four agents editing the same six lines, and the merge would be
 * decided by whoever landed last. A registry makes each channel one new file
 * plus one import, which are the two things that never conflict.
 *
 * ── Resolution is deterministic ──────────────────────────────────
 *
 * Kind first, then `matches`, then `priority` descending, then `id`
 * ascending. The `id` tiebreak matters: without it the winner would depend on
 * the order `channels/index.ts` happens to import, which is exactly the kind of
 * thing that behaves differently in a test than in production.
 *
 * ── A channel cannot break another channel ───────────────────────
 *
 * `matches` is documented as pure and non-throwing, and a throw is caught here
 * and treated as "does not match". A predicate that throws on an empty file
 * would otherwise take down every share, including the ones meant for a channel
 * that works.
 */
import type { SharePreprocessor, SharePreprocessorInput } from './shareTypes';

const preprocessors = new Map<string, SharePreprocessor>();

/**
 * Adds a channel. Called at module load from `channels/<name>.ts`.
 *
 * Re-registering the same id replaces it rather than throwing, so a test that
 * installs a stand-in channel does not have to unwind the real one — and so
 * a double import under a bundler is not a crash on startup.
 */
export function registerSharePreprocessor(preprocessor: SharePreprocessor): void {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(preprocessor.id)) {
    throw new Error(`a share channel id must be lowercase and hyphenated: ${preprocessor.id}`);
  }
  if (preprocessor.kinds.length === 0) {
    throw new Error(`share channel ${preprocessor.id} claims no kinds`);
  }
  preprocessors.set(preprocessor.id, preprocessor);
}

/** Every registered channel, in resolution order. For tests and diagnostics. */
export function registeredSharePreprocessors(): readonly SharePreprocessor[] {
  return Array.from(preprocessors.values()).sort(byPriorityThenId);
}

function byPriorityThenId(a: SharePreprocessor, b: SharePreprocessor): number {
  const difference = (b.priority ?? 0) - (a.priority ?? 0);
  return difference !== 0 ? difference : a.id.localeCompare(b.id);
}

/**
 * The channel that will read this share, or null when nothing claims it.
 *
 * Null is a real answer and not an error: a shared `.ics` has no channel yet,
 * and the service turns that into a 415 naming the kind rather than pretending
 * a channel ran and found nothing.
 */
export function resolveSharePreprocessor(input: SharePreprocessorInput): SharePreprocessor | null {
  for (const candidate of registeredSharePreprocessors()) {
    if (!candidate.kinds.includes(input.kind)) continue;
    if (!candidate.matches) return candidate;
    let matched = false;
    try {
      matched = candidate.matches(input) === true;
    } catch {
      // Named, never quoted: a predicate's error message can contain the text
      // it was inspecting.
      console.warn(JSON.stringify({ event: 'share_matcher_threw', channel: candidate.id }));
      matched = false;
    }
    if (matched) return candidate;
  }
  return null;
}

/** Empties the registry. Tests only; `channels/index.ts` refills it on import. */
export function resetSharePreprocessorsForTests(): void {
  preprocessors.clear();
}
