/** Inline ciphertext wire format (unchanged for compatibility): !uwu!<payload>!uwu! */
export const MARKER_PREFIX = "!uwu!";
export const MARKER_SUFFIX = "!uwu!";

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
  selectedRecipientContactId: null,
  /**
   * Page form fields: live_overlay | button_replace (field tools always active; mode chosen in popup).
   */
  inputEncryptMode: "button_replace",
  lastInputEncryptMode: "button_replace",
  /** Saved pixel positions for draggable page overlays (null = use default corner). */
  uwuDockLeft: null,
  uwuDockTop: null,
  uwuHudLeft: null,
  uwuHudTop: null,
  /** Blue/red Custom Highlight overlays for text nodes the scanner considers (page HUD can toggle). */
  showScanReadIndicators: true
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