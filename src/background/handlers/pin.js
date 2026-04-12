import {
  getPinRecord,
  getUnlockStatus,
  hashSecretForStorage,
  isValidNewSecret,
  MAX_SECRET_LENGTH,
  MIN_SECRET_LENGTH,
  normalizeSecret,
  savePinRecord,
  setSessionUnlocked,
  verifySecretAgainstStored
} from "../../lib/pin.js";

export async function handleUnlockStatus() {
  return getUnlockStatus();
}

export async function handleSetPin({ pin, pinConfirm }) {
  const existing = await getPinRecord();
  if (existing?.hashB64) {
    throw new Error("An unlock secret is already set.");
  }
  const a = normalizeSecret(pin);
  const b = normalizeSecret(pinConfirm);
  if (!isValidNewSecret(a)) {
    throw new Error(
      `Secret must be ${MIN_SECRET_LENGTH}–${MAX_SECRET_LENGTH} characters. Use a passphrase or a password manager.`
    );
  }
  if (a !== b) {
    throw new Error("Secrets do not match.");
  }
  const record = await hashSecretForStorage(pin);
  await savePinRecord(record);
  await setSessionUnlocked();
  return { ok: true };
}

export async function handleUnlockPin({ pin }) {
  const record = await getPinRecord();
  if (!record?.hashB64 || !record?.saltB64) {
    throw new Error("No unlock secret configured.");
  }
  const ok = await verifySecretAgainstStored(pin, record.saltB64, record.hashB64);
  if (!ok) {
    throw new Error("Wrong secret.");
  }
  await setSessionUnlocked();
  return { ok: true };
}
