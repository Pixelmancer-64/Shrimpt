/**
 * Single source of truth for PBKDF2-HMAC-SHA256 iteration count.
 * Used by unlock PIN storage ({@link ./pin.js}) and passphrase-wrapped payloads ({@link ./payload-crypto.js}).
 * Changing this affects new hashes only; encrypted backups record `i` in the blob for decrypt.
 */
export const PBKDF2_ITERATIONS = 310000;
