import { DEFAULT_SETTINGS, STORAGE_KEYS } from "./constants.js";
import { sanitizeSettings } from "./settings-sanitize.js";

export async function getLocal(key) {
  const result = await chrome.storage.local.get([key]);
  return result[key];
}

export async function setLocal(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function removeLocal(key) {
  await chrome.storage.local.remove(key);
}

/**
 * @typedef {object} ShrimptKeyring
 * @property {object[]} profiles
 * @property {object[]} contacts
 */

/** @returns {Promise<ShrimptKeyring>} */
export async function getKeyring() {
  return (await getLocal(STORAGE_KEYS.KEYRING)) || { profiles: [], contacts: [] };
}

/** @param {ShrimptKeyring} keyring */
export async function saveKeyring(keyring) {
  await setLocal(STORAGE_KEYS.KEYRING, keyring);
}

export async function getActiveProfileId() {
  return (await getLocal(STORAGE_KEYS.ACTIVE_PROFILE_ID)) || null;
}

export async function setActiveProfileId(profileId) {
  await setLocal(STORAGE_KEYS.ACTIVE_PROFILE_ID, profileId);
}

export async function getSettings() {
  const raw = (await getLocal(STORAGE_KEYS.SETTINGS)) || {};
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...raw });
}

export async function saveSettings(settings) {
  const current = await getSettings();
  await setLocal(STORAGE_KEYS.SETTINGS, sanitizeSettings({ ...current, ...settings }));
}