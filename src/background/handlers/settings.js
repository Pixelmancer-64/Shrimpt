import { getKeyring, getSettings, saveSettings } from "../../lib/storage.js";

export async function getResolvedClientSettings() {
  const base = await getSettings();
  const keyring = await getKeyring();
  let expectedSenderProfileId = null;
  if (base.selectedRecipientContactId) {
    const contact = keyring.contacts.find((c) => c.id === base.selectedRecipientContactId);
    expectedSenderProfileId = contact?.profileId ?? null;
  }
  return {
    ...base,
    expectedSenderProfileId
  };
}

export async function handleGetSettings() {
  return getResolvedClientSettings();
}

export async function handleUpdateSettings(payload) {
  await saveSettings(payload);
  return getResolvedClientSettings();
}
