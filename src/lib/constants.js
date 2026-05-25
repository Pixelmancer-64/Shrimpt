/** Inline ciphertext delimiters: !shpt!<base64-payload>!shpt! */
export const MARKER_PREFIX = "!shpt!";
export const MARKER_SUFFIX = "!shpt!";

export const STORAGE_KEYS = {
  KEYRING: "keyring",
  ACTIVE_PROFILE_ID: "activeProfileId",
  SETTINGS: "settings",
  /** PBKDF2 salt + hash (Base64); never store plaintext unlock secret */
  PIN_RECORD: "pinRecord"
};

export const DEFAULT_SETTINGS = {
  autoDecrypt: true,
  /** When true, page inline decrypt hides plaintext until the chip is clicked (privacy). */
  clickToReveal: false,
  observerDebounceMs: 250,
  scanTextLimit: 120000,
  /** Contact row id from keyring; limits page scan/decrypt to ciphertext from that contact's profileId */
  selectedRecipientContactId: null
};

/** Service worker → content scripts: session unlocked (pin verified). */
export const MESSAGE_SESSION_UNLOCKED = "SHRIMPT_SESSION_UNLOCKED";

/** Service worker `sendResponse` error codes the UI can branch on (see `throwCoded` in background). */
export const ERROR_CODES = {
  LOCKED: "LOCKED"
};

export const MESSAGE_TYPES = {
  GENERATE_PROFILE: "GENERATE_PROFILE",
  LIST_PROFILES: "LIST_PROFILES",
  SET_ACTIVE_PROFILE: "SET_ACTIVE_PROFILE",
  GET_ACTIVE_PROFILE: "GET_ACTIVE_PROFILE",
  EXPORT_PUBLIC_KEY: "EXPORT_PUBLIC_KEY",
  IMPORT_CONTACT_PUBLIC_KEY: "IMPORT_CONTACT_PUBLIC_KEY",
  LIST_CONTACTS: "LIST_CONTACTS",
  ENCRYPT_TEXT: "ENCRYPT_TEXT",
  DECRYPT_ENVELOPE: "DECRYPT_ENVELOPE",
  GET_SETTINGS: "GET_SETTINGS",
  UPDATE_SETTINGS: "UPDATE_SETTINGS",
  PIN_STATUS: "PIN_STATUS",
  SET_PIN: "SET_PIN",
  UNLOCK_PIN: "UNLOCK_PIN",
  EXPORT_FULL_BACKUP: "EXPORT_FULL_BACKUP",
  IMPORT_FULL_BACKUP: "IMPORT_FULL_BACKUP",
  ENCRYPT_HANDSHAKE_EXPORT: "ENCRYPT_HANDSHAKE_EXPORT",
  IMPORT_ENCRYPTED_HANDSHAKE: "IMPORT_ENCRYPTED_HANDSHAKE"
};
