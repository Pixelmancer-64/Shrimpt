import { arrayBufferToBase64, base64ToArrayBuffer } from "./utils.js";
import { STORAGE_KEYS } from "./constants.js";
import { PBKDF2_ITERATIONS } from "./kdf.js";
import { getLocal, setLocal } from "./storage.js";

/**
 * Memorized secret: passphrase or password-manager value.
 * NIST SP 800-63B-style minimum length; no forced character classes (passphrases encouraged).
 */
export const MIN_SECRET_LENGTH = 12;
export const MAX_SECRET_LENGTH = 256;

/** Session flag; cleared when the browser session ends. */
export const SESSION_UNLOCK_KEY = "uwuUnlocked";

/** Trim surrounding whitespace only; preserves spaces inside (passphrases). */
export function normalizeSecret(secret) {
  return String(secret ?? "").trim();
}

export function isValidNewSecret(secret) {
  const n = normalizeSecret(secret);
  return n.length >= MIN_SECRET_LENGTH && n.length <= MAX_SECRET_LENGTH;
}

export function assertUnlockInputLimit(raw) {
  if (String(raw ?? "").length > MAX_SECRET_LENGTH) {
    throw new Error(`Secret must be at most ${MAX_SECRET_LENGTH} characters.`);
  }
}

async function deriveSecretBits(normalizedUtf8Password, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(normalizedUtf8Password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );
}

export async function hashSecretForStorage(secret) {
  const normalized = normalizeSecret(secret);
  if (!isValidNewSecret(normalized)) {
    throw new Error(`Secret must be ${MIN_SECRET_LENGTH}–${MAX_SECRET_LENGTH} characters.`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveSecretBits(normalized, salt);
  const hash = new Uint8Array(bits);
  return {
    saltB64: arrayBufferToBase64(salt.buffer),
    hashB64: arrayBufferToBase64(hash.buffer)
  };
}

export async function verifySecretAgainstStored(rawInput, saltB64, hashB64) {
  assertUnlockInputLimit(rawInput);
  const normalized = normalizeSecret(rawInput);
  const salt = new Uint8Array(base64ToArrayBuffer(saltB64));
  const expected = new Uint8Array(base64ToArrayBuffer(hashB64));
  const bits = await deriveSecretBits(normalized, salt);
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

export async function getPinRecord() {
  return (await getLocal(STORAGE_KEYS.PIN_RECORD)) || null;
}

export async function savePinRecord(record) {
  await setLocal(STORAGE_KEYS.PIN_RECORD, record);
}

export async function setSessionUnlocked() {
  await chrome.storage.session.set({ [SESSION_UNLOCK_KEY]: true });
}

export async function clearSessionUnlocked() {
  await chrome.storage.session.remove(SESSION_UNLOCK_KEY);
}

export async function isSessionUnlocked() {
  const s = await chrome.storage.session.get(SESSION_UNLOCK_KEY);
  return Boolean(s?.[SESSION_UNLOCK_KEY]);
}

export async function getUnlockStatus() {
  const record = await getPinRecord();
  const unlocked = await isSessionUnlocked();
  return {
    hasSecret: Boolean(record?.hashB64 && record?.saltB64),
    unlocked
  };
}
