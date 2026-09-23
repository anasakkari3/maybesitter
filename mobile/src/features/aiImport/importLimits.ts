/**
 * The paste cap, restated on the phone.
 *
 * The server derives 4,000 from what is left of its model input ceiling after
 * the rules and forty numbered records, and refuses anything longer with
 * `import_too_long`. This constant is what stops the user hitting that refusal:
 * the clipboard read truncates here and the screen says it did, which is a
 * better outcome than a round trip that ends in a red notice.
 *
 * It is duplicated rather than fetched because the server's value is a property
 * of a prompt, not of a session — and a screen that had to ask before it could
 * paste would be worse in every case where the answer is the same.
 */
export const MAX_IMPORT_LENGTH = 4_000;
