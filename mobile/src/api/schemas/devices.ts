import { z } from 'zod';

/**
 * `/api/mobile/devices` (UC-3.0b, #184).
 *
 * Both routes answer an acknowledgement and nothing else: the server has
 * nothing to tell the phone about its own device that the phone did not just
 * send it. `existed` is on the delete because a sign-out that reports whether
 * there was a row is cheaper to read in a log than one that always says `ok`,
 * and it costs a boolean.
 */
export const deviceRegisteredSchema = z.object({
  success: z.literal(true),
  ok: z.literal(true),
});

export const deviceForgottenSchema = z.object({
  success: z.literal(true),
  ok: z.literal(true),
  existed: z.boolean(),
});

export type DeviceRegistered = z.infer<typeof deviceRegisteredSchema>;
export type DeviceForgotten = z.infer<typeof deviceForgottenSchema>;
