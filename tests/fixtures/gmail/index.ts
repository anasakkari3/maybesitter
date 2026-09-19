/**
 * Gmail API offline fixtures (Phase B).
 *
 * Built 2026-09-19 from Google's current REST v1 reference documentation.
 * Every shape carries its source URL in the file that defines it; see
 * evidence/gmail-phase-b/CONTRACT.md for the full citation list and for the
 * points the documentation leaves ambiguous.
 *
 * These are WIRE shapes (what gmail.googleapis.com returns). They sit below
 * `GmailApiPort` in lib/integrations/gmail/adapter.ts, which already takes a
 * normalized `GmailHistoryPage`. Nothing here is evidence that the product
 * talks to Gmail; no live call was made to produce any of it.
 */
export * from './wireTypes';
export * from './profile';
export * from './history';
export * from './messages';
export * from './errors';
export * from './malformed';
