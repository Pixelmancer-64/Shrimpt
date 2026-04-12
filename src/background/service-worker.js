import { MESSAGE_TYPES } from "../lib/constants.js";
import {
  handleEncryptHandshakeExport,
  handleImportEncryptedHandshake,
  handleImportFullBackup,
  handleExportFullBackup,
  validateContactImport
} from "./handlers/backup.js";
import {
  handleDecryptEnvelope,
  handleEncryptText,
  handleExportPublicKey,
  handleGenerateProfile,
  handleGetActiveProfile,
  handleImportContact,
  handleListContacts,
  handleListProfiles,
  handleSetActiveProfile
} from "./handlers/keyring.js";
import { handleSetPin, handleUnlockPin, handleUnlockStatus } from "./handlers/pin.js";
import { handleGetSettings, handleUpdateSettings } from "./handlers/settings.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      const { type, payload } = message;

      switch (type) {
        case MESSAGE_TYPES.PIN_STATUS: {
          sendResponse({ ok: true, result: await handleUnlockStatus() });
          break;
        }
        case MESSAGE_TYPES.SET_PIN: {
          const result = await handleSetPin(payload);
          sendResponse({ ok: true, result });
          break;
        }
        case MESSAGE_TYPES.UNLOCK_PIN: {
          const result = await handleUnlockPin(payload);
          sendResponse({ ok: true, result });
          break;
        }
        case MESSAGE_TYPES.GENERATE_PROFILE: {
          const result = await handleGenerateProfile(payload);
          sendResponse({ ok: true, result });
          break;
        }
        case MESSAGE_TYPES.LIST_PROFILES: {
          sendResponse({ ok: true, result: await handleListProfiles() });
          break;
        }
        case MESSAGE_TYPES.SET_ACTIVE_PROFILE: {
          await handleSetActiveProfile(payload);
          sendResponse({ ok: true, result: null });
          break;
        }
        case MESSAGE_TYPES.GET_ACTIVE_PROFILE: {
          sendResponse({ ok: true, result: await handleGetActiveProfile() });
          break;
        }
        case MESSAGE_TYPES.EXPORT_PUBLIC_KEY: {
          sendResponse({ ok: true, result: await handleExportPublicKey(payload) });
          break;
        }
        case MESSAGE_TYPES.IMPORT_CONTACT_PUBLIC_KEY: {
          validateContactImport(payload);
          const result = await handleImportContact(payload);
          sendResponse({ ok: true, result });
          break;
        }
        case MESSAGE_TYPES.LIST_CONTACTS: {
          sendResponse({ ok: true, result: await handleListContacts() });
          break;
        }
        case MESSAGE_TYPES.ENCRYPT_TEXT: {
          const result = await handleEncryptText(payload);
          sendResponse({ ok: true, result });
          break;
        }
        case MESSAGE_TYPES.DECRYPT_ENVELOPE: {
          const result = await handleDecryptEnvelope(payload);
          sendResponse({ ok: true, result });
          break;
        }
        case MESSAGE_TYPES.GET_SETTINGS: {
          sendResponse({ ok: true, result: await handleGetSettings() });
          break;
        }
        case MESSAGE_TYPES.UPDATE_SETTINGS: {
          const result = await handleUpdateSettings(payload);
          sendResponse({ ok: true, result });
          break;
        }
        case MESSAGE_TYPES.EXPORT_FULL_BACKUP: {
          const result = await handleExportFullBackup(payload);
          sendResponse({ ok: true, result });
          break;
        }
        case MESSAGE_TYPES.IMPORT_FULL_BACKUP: {
          const result = await handleImportFullBackup(payload);
          sendResponse({ ok: true, result });
          break;
        }
        case MESSAGE_TYPES.ENCRYPT_HANDSHAKE_EXPORT: {
          const result = await handleEncryptHandshakeExport(payload);
          sendResponse({ ok: true, result });
          break;
        }
        case MESSAGE_TYPES.IMPORT_ENCRYPTED_HANDSHAKE: {
          const result = await handleImportEncryptedHandshake(payload);
          sendResponse({ ok: true, result });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message type." });
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error?.message || String(error),
        code: error?.code
      });
    }
  })();

  return true;
});
