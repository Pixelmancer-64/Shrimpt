import { ERROR_CODES, MESSAGE_TYPES } from "../lib/constants.js";
import { applyTheme, bindThemeWatcher, normalizeThemeMode } from "../lib/theme.js";

applyTheme(document.documentElement, "system");

const autoDecrypt = document.getElementById("autoDecrypt");
const themeSelect = document.getElementById("themeSelect");
const observerDebounceMs = document.getElementById("observerDebounceMs");
const status = document.getElementById("status");
const pinGate = document.getElementById("pin-gate");
const mainOptions = document.getElementById("main-options");
const pinUnlockBtn = document.getElementById("pinUnlockBtn");

let unbindThemeWatcher = () => {};
let saveTimer = null;

function applyThemeFromSettings(settings) {
  unbindThemeWatcher();
  const mode = normalizeThemeMode(settings?.theme);
  applyTheme(document.documentElement, mode);
  unbindThemeWatcher = bindThemeWatcher(mode, document.documentElement);
}

function setStatusSuccess(message) {
  if (!status) return;
  status.textContent = message;
  status.classList.remove("is-error");
  status.classList.add("is-success");
}

function updatePinUnlockValidation() {
  const pin = document.getElementById("pinUnlockInput")?.value?.trim() ?? "";
  if (pinUnlockBtn) pinUnlockBtn.disabled = !pin.length;
}

init().catch(console.error);

async function init() {
  bindPinEvents();
  try {
    applyThemeFromSettings(await request(MESSAGE_TYPES.GET_SETTINGS));
  } catch (_e) {
    applyTheme(document.documentElement, "system");
  }

  const pinStatus = await request(MESSAGE_TYPES.PIN_STATUS);
  if (!pinStatus.hasSecret) {
    showPinCreate();
    return;
  }
  if (!pinStatus.unlocked) {
    showPinUnlock();
    return;
  }
  await showMainOptions();
}

function bindPinEvents() {
  document.getElementById("pinCreateBtn")?.addEventListener("click", onCreatePin);
  document.getElementById("pinUnlockBtn")?.addEventListener("click", onUnlockPin);
  for (const id of ["pinCreatePin", "pinCreateConfirm", "pinUnlockInput"]) {
    const el = document.getElementById(id);
    el?.addEventListener("input", () => {
      if (el.value.length > 256) el.value = el.value.slice(0, 256);
      if (id === "pinUnlockInput") updatePinUnlockValidation();
    });
  }
  document.getElementById("pinUnlockInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onUnlockPin();
  });
  document.getElementById("pinCreateConfirm")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onCreatePin();
  });
}

async function onCreatePin() {
  const pinGateStatus = document.getElementById("pinGateStatus");
  pinGateStatus.textContent = "";
  pinGateStatus.classList.remove("is-error");
  const pin = document.getElementById("pinCreatePin").value;
  const pinConfirm = document.getElementById("pinCreateConfirm").value;
  try {
    await request(MESSAGE_TYPES.SET_PIN, { pin, pinConfirm });
    await showMainOptions();
  } catch (error) {
    pinGateStatus.textContent = error.message;
    pinGateStatus.classList.add("is-error");
  }
}

async function onUnlockPin() {
  const pinGateStatus = document.getElementById("pinGateStatus");
  pinGateStatus.textContent = "";
  pinGateStatus.classList.remove("is-error");
  const pin = document.getElementById("pinUnlockInput").value;
  try {
    await request(MESSAGE_TYPES.UNLOCK_PIN, { pin });
    document.getElementById("pinUnlockInput").value = "";
    await showMainOptions();
  } catch (error) {
    pinGateStatus.textContent = error.message;
    pinGateStatus.classList.add("is-error");
  }
}

function showPinCreate() {
  pinGate.hidden = false;
  mainOptions.hidden = true;
  document.getElementById("pin-create-fields").hidden = false;
  document.getElementById("pin-unlock-fields").hidden = true;
  document.getElementById("pin-gate-title").textContent = "Create unlock secret";
  document.getElementById("pin-gate-desc").textContent =
    "Use at least 12 characters — a passphrase or a password manager is best.";
  document.getElementById("pinCreatePin")?.focus();
}

function showPinUnlock() {
  pinGate.hidden = false;
  mainOptions.hidden = true;
  document.getElementById("pin-create-fields").hidden = true;
  document.getElementById("pin-unlock-fields").hidden = false;
  document.getElementById("pin-gate-title").textContent = "Unlock";
  document.getElementById("pin-gate-desc").textContent = "Enter your secret to change settings.";
  updatePinUnlockValidation();
  document.getElementById("pinUnlockInput")?.focus();
}

async function showMainOptions() {
  pinGate.hidden = true;
  mainOptions.hidden = false;
  const settings = await request(MESSAGE_TYPES.GET_SETTINGS);
  applyThemeFromSettings(settings);
  autoDecrypt.checked = Boolean(settings.autoDecrypt);
  themeSelect.value = normalizeThemeMode(settings.theme);
  observerDebounceMs.value = settings.observerDebounceMs;
  themeSelect.focus();
}

function scheduleAutosave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistSettings(), 400);
}

async function persistSettings() {
  if (!status) return;
  status.textContent = "";
  status.classList.remove("is-error", "is-success");
  try {
    const updated = await request(MESSAGE_TYPES.UPDATE_SETTINGS, {
      autoDecrypt: autoDecrypt.checked,
      theme: normalizeThemeMode(themeSelect.value),
      observerDebounceMs: Number(observerDebounceMs.value) || 250
    });
    applyThemeFromSettings(updated);
    setStatusSuccess("Saved.");
    setTimeout(() => {
      if (status.textContent === "Saved.") status.textContent = "";
    }, 1400);
  } catch (error) {
    status.textContent =
      error?.code === ERROR_CODES.LOCKED || error?.message === "LOCKED"
        ? "Locked — unlock from the toolbar popup first."
        : error.message;
    status.classList.add("is-error");
  }
}

autoDecrypt.addEventListener("change", scheduleAutosave);
themeSelect.addEventListener("change", scheduleAutosave);
observerDebounceMs.addEventListener("change", scheduleAutosave);
observerDebounceMs.addEventListener("input", scheduleAutosave);

function request(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response?.ok) {
        const err = new Error(response?.error || "Unknown extension error.");
        if (response?.code) err.code = response.code;
        reject(err);
        return;
      }

      resolve(response.result);
    });
  });
}
