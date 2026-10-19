/** Stage ownership is fixed in B1; implementations land with the B2/B3 workers. */
export const GMAIL_JOB_CLASSES = Object.freeze({
  live: Object.freeze(['live', 'proposals'] as const),
  sweep: Object.freeze(['continuation', 'sweep', 'calendar_maintenance'] as const),
});

export async function runGmailJobTickForTests(
  route: keyof typeof GMAIL_JOB_CLASSES,
  _options: { now?: Date } = {},
): Promise<{ success: true; route: typeof route; classes: readonly string[]; processed: number }> {
  return { success: true, route, classes: GMAIL_JOB_CLASSES[route], processed: 0 };
}
