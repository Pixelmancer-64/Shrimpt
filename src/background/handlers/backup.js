import { validateFullBackup } from "../../lib/backup.js";
import { DEFAULT_SETTINGS, STORAGE_KEYS } from "../../lib/constants.js";
import {
  decryptPayloadWithPassphrase,
  encryptPayloadWithPassphrase,
  isEncryptedPayload,
  MAX_PASSPHRASE_LENGTH,
  MIN_BACKUP_PASSPHRASE_LENGTH,
  MIN_HANDSHAKE_PASSPHRASE_LENGTH
} from "../../lib/payload-crypto.js";
import {
  clearSessionUnlocked,
  getPinRecord,
  normalizeSecret,
  savePinRecord,
  setSessionUnlocked
} from "../../lib/pin.js";
import {
  getActiveProfileId,
  getKeyring,
  getSettings,
  removeLocal,
  saveKeyring,
  setActiveProfileId,
  setLocal
} from "../../lib/storage.js";
import { requireUnlock } from "../require-unlock.js";
import { handleImportContact } from "./keyring.js";

async function buildPlainBackupObject() {
  const keyring = await getKeyring();
  return {
    uwuBackupVersion: 1,
    exportedAt: new Date().toISOString(),
    keyring,
    activeProfileId: await getActiveProfileId(),
    settings: await getSettings(),
    pinRecord: await getPinRecord()
  };
}

export async function handleExportFullBackup({ passphrase, passphraseConfirm }) {
  await requireUnlock();
  const a = normalizeSecret(passphrase);
  const b = normalizeSecret(passphraseConfirm);
  if (a.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    throw new Error(`Backup password must be at least ${MIN_BACKUP_PASSPHRASE_LENGTH} characters.`);
  }
  if (a !== b) {
    throw new Error("Backup passwords do not match.");
  }
  const inner = await buildPlainBackupObject();
  return encryptPayloadWithPassphrase(JSON.stringify(inner), a, MIN_BACKUP_PASSPHRASE_LENGTH);
}

export async function handleImportFullBackup({ rawText, passphrase, confirmToken }) {
  await requireUnlock();
  if (confirmToken !== "REPLACE") {
    throw new Error("Restore was not confirmed.");
  }

  let parsed = JSON.parse(String(rawText ?? "").trim());
  if (isEncryptedPayload(parsed)) {
    const pass = normalizeSecret(passphrase);
    if (pass.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
      throw new Error("Enter the backup password (at least 12 characters, same as when you exported).");
    }
    const json = await decryptPayloadWithPassphrase(parsed, pass);
    parsed = JSON.parse(json);
  }

  validateFullBackup(parsed);
  const backup = parsed;
  const { keyring, activeProfileId, settings, pinRecord } = backup;

  await saveKeyring({
    profiles: [...keyring.profiles],
    contacts: [...keyring.contacts]
  });

  const profiles = keyring.profiles;
  let nextActive = typeof activeProfileId === "string" ? activeProfileId : null;
  if (!nextActive || !profiles.some((p) => p.id === nextActive)) {
    nextActive = profiles.length ? profiles[0].id : null;
  }
  await setActiveProfileId(nextActive);

  const mergedSettings =
    settings && typeof settings === "object" ? { ...DEFAULT_SETTINGS, ...settings } : { ...DEFAULT_SETTINGS };
  await setLocal(STORAGE_KEYS.SETTINGS, mergedSettings);

  if (pinRecord?.hashB64 && pinRecord?.saltB64) {
    await savePinRecord(pinRecord);
    await setSessionUnlocked();
  } else {
    await removeLocal(STORAGE_KEYS.PIN_RECORD);
    await clearSessionUnlocked();
  }

  return { ok: true, activeProfileId: nextActive };
}

export async function handleEncryptHandshakeExport({ profileId, passphrase }) {
  await requireUnlock();
  const p = normalizeSecret(passphrase);
  if (p.length < MIN_HANDSHAKE_PASSPHRASE_LENGTH) {
    throw new Error(`Handshake confirmation code must be at least ${MIN_HANDSHAKE_PASSPHRASE_LENGTH} characters.`);
  }
  if (p.length > MAX_PASSPHRASE_LENGTH) {
    throw new Error("Passphrase is too long.");
  }
  const keyring = await getKeyring();
  const profile = keyring.profiles.find((x) => x.id === profileId);
  if (!profile) throw new Error("Profile not found.");
  const bundle = {
    name: profile.name,
    profileId: profile.id,
    fingerprint: profile.fingerprint,
    encryptionPublicJwk: profile.encryptionPublicJwk,
    signingPublicJwk: profile.signingPublicJwk
  };
  const inner = JSON.stringify(bundle);
  return encryptPayloadWithPassphrase(inner, p, MIN_HANDSHAKE_PASSPHRASE_LENGTH);
}

export async function handleImportEncryptedHandshake({ blobText, passphrase }) {
  await requireUnlock();
  const p = normalizeSecret(passphrase);
  if (p.length < MIN_HANDSHAKE_PASSPHRASE_LENGTH) {
    throw new Error(`Enter the handshake confirmation code (at least ${MIN_HANDSHAKE_PASSPHRASE_LENGTH} characters).`);
  }
  const wrap = JSON.parse(String(blobText ?? "").trim());
  const json = await decryptPayloadWithPassphrase(wrap, p);
  const data = JSON.parse(json);
  validateContactImport(data);
  return handleImportContact({
    name: data.name,
    profileId: data.profileId,
    fingerprint: data.fingerprint,
    encryptionPublicJwk: data.encryptionPublicJwk,
    signingPublicJwk: data.signingPublicJwk
  });
}

export function validateContactImport(payload) {
  if (!payload?.profileId) throw new Error("Missing profileId.");
  if (!payload?.encryptionPublicJwk) throw new Error("Missing encryption public key.");
  if (!payload?.signingPublicJwk) throw new Error("Missing signing public key.");
}
