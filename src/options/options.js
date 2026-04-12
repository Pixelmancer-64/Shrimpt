import { ERROR_CODES, MESSAGE_TYPES } from "../lib/constants.js";

const autoDecrypt = document.getElementById("autoDecrypt");
const clickToReveal = document.getElementById("clickToReveal");
const clickToRevealRow = document.getElementById("clickToRevealRow");
const showScanReadIndicators = document.getElementById("showScanReadIndicators");
const observerDebounceMs = document.getElementById("observerDebounceMs");
const saveBtn = document.getElementById("saveBtn");
const status = document.getElementById("status");
const pinGate = document.getElementById("pin-gate");
const mainOptions = document.getElementById("main-options");

function updateClickToRevealRowVisibility() {
  if (!clickToRevealRow) return;
  clickToRevealRow.hidden = autoDecrypt.checked;
}

autoDecrypt?.addEventListener("change", updateClickToRevealRowVisibility);

init().catch(console.error);

async function init() {
  bindPinEvents();
  const pinStatus = await request(MESSAGE_TYPES.PIN_STATUS);
  if (!pinStatus.hasSecret) {
    showPinCreate();
    return;
  }
  if (!pinStatus.unlocked) {
    showPinUnlock();
    return;
  }
  showMainOptions();
}

function bindPinEvents() {
  document.getElementById("pinCreateBtn")?.addEventListener("click", onCreatePin);
  document.getElementById("pinUnlockBtn")?.addEventListener("click", onUnlockPin);
  for (const id of ["pinCreatePin", "pinCreateConfirm", "pinUnlockInput"]) {
    const el = document.getElementById(id);
    el?.addEventListener("input", () => {
      if (el.value.length > 256) el.value = el.value.slice(0, 256);
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
    showMainOptions();
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
    showMainOptions();
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
  document.getElementById("pinUnlockInput")?.focus();
}

async function showMainOptions() {
  pinGate.hidden = true;
  mainOptions.hidden = false;
  const settings = await request(MESSAGE_TYPES.GET_SETTINGS);
  autoDecrypt.checked = Boolean(settings.autoDecrypt);
  clickToReveal.checked = Boolean(settings.clickToReveal);
  if (showScanReadIndicators) {
    showScanReadIndicators.checked = settings.showScanReadIndicators !== false;
  }
  observerDebounceMs.value = settings.observerDebounceMs;
  updateClickToRevealRowVisibility();
}

saveBtn.addEventListener("click", async () => {
  status.textContent = "";
  try {
    await request(MESSAGE_TYPES.UPDATE_SETTINGS, {
      autoDecrypt: autoDecrypt.checked,
      clickToReveal: clickToReveal.checked,
      showScanReadIndicators: showScanReadIndicators ? showScanReadIndicators.checked : true,
      observerDebounceMs: Number(observerDebounceMs.value) || 250
    });
    status.textContent = "Saved.";
  } catch (error) {
    status.textContent =
      error?.code === ERROR_CODES.LOCKED || error?.message === "LOCKED"
        ? "Locked — unlock from the toolbar popup first."
        : error.message;
  }
});

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
