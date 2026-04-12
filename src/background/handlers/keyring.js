import { decryptCompactEnvelope, encryptTextForRecipient, exportKeyPair, generateProfileKeys } from "../../lib/crypto.js";
import { randomId } from "../../lib/utils.js";
import {
  getActiveProfileId,
  getKeyring,
  saveKeyring,
  setActiveProfileId
} from "../../lib/storage.js";
import { requireUnlock } from "../require-unlock.js";
import { getResolvedClientSettings } from "./settings.js";

export async function handleImportContact({ name, profileId, fingerprint, encryptionPublicJwk, signingPublicJwk }) {
  await requireUnlock();
  const keyring = await getKeyring();

  const contact = {
    id: randomId("contact"),
    name: name?.trim() || "Unnamed Contact",
    profileId,
    fingerprint,
    encryptionPublicJwk,
    signingPublicJwk,
    importedAt: new Date().toISOString()
  };

  const existingIndex = keyring.contacts.findIndex((c) => c.profileId === profileId);
  if (existingIndex >= 0) {
    keyring.contacts[existingIndex] = contact;
  } else {
    keyring.contacts.push(contact);
  }

  await saveKeyring(keyring);
  return contact;
}

export async function handleListContacts() {
  const keyring = await getKeyring();
  return keyring.contacts;
}

export async function handleEncryptText({ plaintext, recipientContactId }) {
  await requireUnlock();
  if (!plaintext?.trim()) throw new Error("Text is required.");

  const keyring = await getKeyring();
  const activeProfileId = await getActiveProfileId();
  if (!activeProfileId) throw new Error("No active profile set.");

  const sender = keyring.profiles.find((p) => p.id === activeProfileId);
  if (!sender) throw new Error("Active profile not found.");

  const recipient = keyring.contacts.find((c) => c.id === recipientContactId);
  if (!recipient) throw new Error("Recipient contact not found.");

  return encryptTextForRecipient({
    plaintext,
    recipientEncryptionPublicJwk: recipient.encryptionPublicJwk,
    senderSigningPrivateJwk: sender.signingPrivateJwk,
    senderProfileId: sender.id
  });
}

export async function handleDecryptEnvelope(payload = {}) {
  const { compactEnvelope, forPageScan } = payload;
  await requireUnlock();
  const keyring = await getKeyring();
  const activeProfileId = await getActiveProfileId();
  if (!activeProfileId) throw new Error("No active profile selected.");

  const recipient = keyring.profiles.find((p) => p.id === activeProfileId);
  if (!recipient) throw new Error("Active profile not found.");

  const clientSettings = await getResolvedClientSettings();

  const signingPublicKeyResolver = (profileId) => {
    const c = keyring.contacts.find((x) => x.profileId === profileId);
    return c?.signingPublicJwk || null;
  };

  const result = await decryptCompactEnvelope({
    compactEnvelope,
    recipientEncryptionPrivateJwk: recipient.encryptionPrivateJwk,
    signingPublicKeyResolver
  });

  const conversationMismatch = Boolean(
    clientSettings.expectedSenderProfileId &&
      result.senderProfileId &&
      result.senderProfileId !== clientSettings.expectedSenderProfileId
  );

  if (conversationMismatch && !forPageScan) {
    return {
      skipped: true,
      code: "WRONG_CONVERSATION",
      envelopeSenderProfileId: result.senderProfileId
    };
  }

  const senderContact = keyring.contacts.find((c) => c.profileId === result.senderProfileId);

  return {
    plaintext: result.plaintext,
    verified: result.verified,
    senderProfileId: result.senderProfileId,
    senderKnown: Boolean(senderContact),
    senderName: senderContact?.name || null,
    conversationMismatch: conversationMismatch && Boolean(forPageScan)
  };
}

export async function handleGenerateProfile({ name }) {
  await requireUnlock();
  const trimmed = name?.trim();
  if (!trimmed) throw new Error("Profile name is required.");

  const { encryptionKeyPair, signatureKeyPair } = await generateProfileKeys();
  const profile = await exportKeyPair(trimmed, encryptionKeyPair, signatureKeyPair);
  const keyring = await getKeyring();
  keyring.profiles.push(profile);
  await saveKeyring(keyring);
  await setActiveProfileId(profile.id);

  return {
    id: profile.id,
    name: profile.name,
    fingerprint: profile.fingerprint,
    createdAt: profile.createdAt,
    active: true
  };
}

export async function handleListProfiles() {
  const keyring = await getKeyring();
  const activeId = await getActiveProfileId();
  return keyring.profiles.map((p) => ({
    id: p.id,
    name: p.name,
    fingerprint: p.fingerprint,
    createdAt: p.createdAt,
    active: p.id === activeId
  }));
}

export async function handleSetActiveProfile({ profileId }) {
  await requireUnlock();
  const keyring = await getKeyring();
  if (!keyring.profiles.some((p) => p.id === profileId)) {
    throw new Error("Profile not found.");
  }
  await setActiveProfileId(profileId);
}

export async function handleGetActiveProfile() {
  const activeId = await getActiveProfileId();
  if (!activeId) return null;
  const keyring = await getKeyring();
  const profile = keyring.profiles.find((p) => p.id === activeId);
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    fingerprint: profile.fingerprint
  };
}

export async function handleExportPublicKey({ profileId }) {
  await requireUnlock();
  const keyring = await getKeyring();
  const profile = keyring.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error("Profile not found.");
  return {
    name: profile.name,
    profileId: profile.id,
    fingerprint: profile.fingerprint,
    encryptionPublicJwk: profile.encryptionPublicJwk,
    signingPublicJwk: profile.signingPublicJwk
  };
}
