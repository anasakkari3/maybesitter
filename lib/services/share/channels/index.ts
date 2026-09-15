/**
 * Every share channel this build carries (UC-3.0, #183).
 *
 * ══ THE ONE LINE A CHANNEL ADDS ══════════════════════════════════
 *
 * UC-3.5 (#189, WhatsApp), UC-3.6 (#190, images), UC-3.7 (#191, PDF) and
 * UC-3.8 (#192, email) each add **one file** under this directory and **one
 * import** below. Nothing else in `lib/services/share/` changes.
 *
 *   import './whatsapp';
 *   import './image';
 *   import './pdf';
 *   import './email';
 *
 * Importing for the side effect is deliberate. A channel registers itself in
 * its own module body, so there is no list of channels anywhere that could
 * disagree with the set of files that exist — and four lanes adding four
 * separate import lines to the end of one list is the smallest merge conflict
 * available.
 *
 * Alphabetical, because resolution order is decided by `priority` and `id` in
 * `shareRegistry.ts` and never by import order. If moving a line here changes
 * behaviour, the registry has a bug.
 */
import './plainText';

/**
 * The built-ins, by value.
 *
 * A test that empties the registry to assert resolution order puts these back
 * rather than re-importing this module, which an ESM cache would make a no-op.
 */
export { plainTextPreprocessor } from './plainText';
