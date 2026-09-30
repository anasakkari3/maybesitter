/** The expanded decision loop is explicitly limited to staging. */
export function intelligenceEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  // Staging-only until 2026-10-01, when the owner released the loop to
  // production for everyone ("Owner decision 2026-10-01" in
  // docs/architecture/adr-stage-b-engineering-unlock.md). The flag and the
  // kill switch still decide; any other environment stays off.
  return (env.MAYBESITTER_ENV === 'staging' || env.MAYBESITTER_ENV === 'production')
    && env.MAYBESITTER_FEATURE_PROACTIVE_LOOP === 'true'
    && env.MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP !== 'true';
}

export function intelligenceDisabledResponse(): Response | null {
  return intelligenceEnabled()
    ? null
    : Response.json({ success: false, error: 'not found', reason: 'feature_unavailable' }, { status: 404 });
}
