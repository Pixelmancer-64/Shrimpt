/** @typedef {"system" | "light" | "dark"} ThemeMode */

export const THEME_MODES = /** @type {const} */ (["system", "light", "dark"]);

/**
 * @param {string | null | undefined} mode
 * @returns {"light" | "dark"}
 */
export function resolveTheme(mode) {
  if (mode === "dark") return "dark";
  if (mode === "light") return "light";
  if (typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

/**
 * @param {HTMLElement} root
 * @param {string | null | undefined} mode
 */
export function applyTheme(root, mode) {
  if (resolveTheme(mode) === "dark") {
    root.dataset.theme = "dark";
  } else {
    delete root.dataset.theme;
  }
}

/**
 * Re-apply when OS theme changes (system mode only).
 * @param {string | null | undefined} mode
 * @param {HTMLElement} root
 * @returns {() => void}
 */
export function bindThemeWatcher(mode, root) {
  if (mode !== "system" || typeof matchMedia === "undefined") {
    return () => {};
  }
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const handler = () => applyTheme(root, mode);
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

/**
 * @param {string | null | undefined} mode
 * @returns {ThemeMode}
 */
export function normalizeThemeMode(mode) {
  return THEME_MODES.includes(/** @type {ThemeMode} */ (mode)) ? /** @type {ThemeMode} */ (mode) : "system";
}
