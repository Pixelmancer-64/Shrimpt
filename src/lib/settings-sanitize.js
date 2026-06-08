import { DEFAULT_SETTINGS } from "./constants.js";
import { normalizeThemeMode } from "./theme.js";

/**
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function sanitizeSettings(raw) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(raw && typeof raw === "object" ? raw : {})
  };

  const debounce = Number(merged.observerDebounceMs);
  const scanLimit = Number(merged.scanTextLimit);

  return {
    theme: normalizeThemeMode(/** @type {string} */ (merged.theme)),
    autoDecrypt: Boolean(merged.autoDecrypt),
    observerDebounceMs: Number.isFinite(debounce) && debounce >= 50 ? debounce : DEFAULT_SETTINGS.observerDebounceMs,
    scanTextLimit: Number.isFinite(scanLimit) && scanLimit > 0 ? scanLimit : DEFAULT_SETTINGS.scanTextLimit,
    selectedRecipientContactId:
      typeof merged.selectedRecipientContactId === "string" && merged.selectedRecipientContactId
        ? merged.selectedRecipientContactId
        : null
  };
}
