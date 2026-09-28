import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * "Export my data" (#174 step 7), checked at the envelope only.
 *
 * The collections are the user's own records in whatever shape each store
 * writes them, and the phone does not read them — it writes the JSON to a file
 * and hands it to the share sheet. So the schema proves it is an export of the
 * right version with the right parts, and leaves each document's fields to
 * the server (`lib/account/accountExport.ts`), which is what decides what is
 * in them and what is removed.
 */
export const ACCOUNT_EXPORT_SCHEMA_VERSION = 'account-export-v1';

export const accountExportSchema = z.object({
  exportedAt: isoDateTime,
  schemaVersion: z.literal(ACCOUNT_EXPORT_SCHEMA_VERSION),
  account: z.object({
    uid: z.string().min(1),
    profile: z.record(z.string(), z.unknown()).nullable(),
  }),
  collections: z.record(z.string(), z.array(z.object({
    id: z.string().min(1),
    data: z.record(z.string(), z.unknown()),
  }))),
  excluded: z.record(z.string(), z.string()),
});

export type AccountExport = z.infer<typeof accountExportSchema>;
