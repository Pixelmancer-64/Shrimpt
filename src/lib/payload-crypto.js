import { arrayBufferToBase64, base64ToArrayBuffer, fromUtf8Bytes } from "./utils.js";
import { PBKDF2_ITERATIONS } from "./kdf.js";
const SALT_BYTES = 16;
const IV_BYTES = 12;

export const MIN_BACKUP_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 256;
/** Short codes OK when shared out-of-band separately from the blob. */
export const MIN_HANDSHAKE_PASSPHRASE_LENGTH = 4;

export function isEncryptedPayload(obj) {
  return Boolean(obj && typeof obj === "object" && obj.uwuEncrypted === 1 && obj.d && obj.s && obj.iv);
}

function assertPassphraseLength(pass, minLen, label) {
  const p = String(pass ?? "");
  if (p.length > MAX_PASSPHRASE_LENGTH) {
    throw new Error(`${label} is too long.`);
  }
  if (p.length < minLen) {
    throw new Error(`${label} must be at least ${minLen} character${minLen === 1 ? "" : "s"}.`);
  }
}

/**
 * @param {string} plaintextUtf8
 * @param {string} passphrase
 * @param {number} minPassLen
 */
export async function encryptPayloadWithPassphrase(plaintextUtf8, passphrase, minPassLen) {
  assertPassphraseLength(passphrase, minPassLen, "Passphrase");

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const keyBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );
  const aesKey = await crypto.subtle.importKey("raw", keyBits, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);

  const pt = enc.encode(plaintextUtf8);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, pt);

  return {
    uwuEncrypted: 1,
    v: 1,
    i: PBKDF2_ITERATIONS,
    s: arrayBufferToBase64(salt.buffer),
    iv: arrayBufferToBase64(iv.buffer),
    d: arrayBufferToBase64(ct)
  };
}

/**
 * @param {object} wrap
 * @param {string} passphrase
 */
export async function decryptPayloadWithPassphrase(wrap, passphrase) {
  if (!isEncryptedPayload(wrap)) {
    throw new Error("Not an encrypted UWU payload.");
  }
  const pass = String(passphrase ?? "");
  if (!pass.length || pass.length > MAX_PASSPHRASE_LENGTH) {
    throw new Error("Passphrase required.");
  }

  const salt = new Uint8Array(base64ToArrayBuffer(wrap.s));
  const iv = new Uint8Array(base64ToArrayBuffer(wrap.iv));
  const ct = base64ToArrayBuffer(wrap.d);

  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  const iterations = typeof wrap.i === "number" && wrap.i > 0 ? wrap.i : PBKDF2_ITERATIONS;
  const keyBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );
  const aesKey = await crypto.subtle.importKey("raw", keyBits, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);

  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, aesKey, ct);
    return fromUtf8Bytes(new Uint8Array(pt));
  } catch {
    throw new Error("Wrong passphrase or damaged payload.");
  }
}
