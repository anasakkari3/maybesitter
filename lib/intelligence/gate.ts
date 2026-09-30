/** The expanded decision loop is explicitly limited to staging. */
export function intelligenceEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.MAYBESITTER_ENV === 'staging'
    && env.MAYBESITTER_FEATURE_PROACTIVE_LOOP === 'true'
    && env.MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP !== 'true';
}

export function intelligenceDisabledResponse(): Response | null {
  return intelligenceEnabled()
    ? null
    : Response.json({ success: false, error: 'not found', reason: 'feature_unavailable' }, { status: 404 });
}
