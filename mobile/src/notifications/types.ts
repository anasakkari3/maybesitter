/** One pending notification, as the engine needs to see it (UC-3.11, #196). */
export interface ScheduledNotificationRequest {
  readonly identifier: string;
  /** Epoch milliseconds, or null when the trigger's instant could not be read. */
  readonly at: number | null;
}
