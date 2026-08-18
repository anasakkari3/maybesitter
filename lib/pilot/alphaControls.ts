/**
 * Trusted-alpha participant controls.
 *
 * The V03 closed pilot is locked to 25–40 allowlisted participants
 * (CLOSED_PILOT_MINIMUM..MAXIMUM in closedPilotControls) — that contract is
 * deliberately NOT relaxed here. This module adds a separate, explicit,
 * internal-only alpha allowlist (1–10 pseudonymous IDs) that a development
 * environment may OR into membership checks so a small trusted-alpha run
 * (3–5 people) can exercise the product before the real pilot opens.
 *
 * Safety rules:
 * - The alpha allowlist is read from MAYBESITTER_ALPHA_IDS, never from the
 *   closed-pilot variable, so a pilot deployment that sets only
 *   MAYBESITTER_CLOSED_PILOT_IDS is unaffected.
 * - The closed-pilot validation (25–40) is untouched.
 * - The alpha allowlist must never be set in a real pilot deployment.
 */

const PARTICIPANT_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;

export const ALPHA_ALLOWLIST_MINIMUM = 1;
export const ALPHA_ALLOWLIST_MAXIMUM = 10;

export function parseAlphaAllowlist(raw: string | undefined): ReadonlySet<string> {
  const values = (raw || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length < ALPHA_ALLOWLIST_MINIMUM || values.length > ALPHA_ALLOWLIST_MAXIMUM) {
    throw new Error(`alpha allowlist must contain ${ALPHA_ALLOWLIST_MINIMUM}–${ALPHA_ALLOWLIST_MAXIMUM} participants`);
  }
  if (new Set(values).size !== values.length) throw new Error('alpha allowlist contains duplicates');
  if (values.some((value) => !PARTICIPANT_ID.test(value))) throw new Error('alpha participant IDs must be pseudonymous');
  return new Set(values);
}

/** True when the alpha allowlist is configured and contains the participant. */
export function isAlphaParticipant(
  participantId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.MAYBESITTER_ALPHA_IDS;
  if (!raw) return false;
  try {
    return parseAlphaAllowlist(raw).has(participantId);
  } catch {
    return false;
  }
}

/** True when an alpha allowlist is configured at all. */
export function alphaAllowlistConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.MAYBESITTER_ALPHA_IDS);
}
