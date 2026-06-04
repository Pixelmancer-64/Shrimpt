import { ERROR_CODES, MESSAGE_TYPES } from "../lib/constants.js";
import { findEnvelopeMatches, unwrapEnvelopeString, wrapEnvelope } from "../lib/encoding.js";
import { MAX_SECRET_LENGTH, MIN_SECRET_LENGTH, normalizeSecret } from "../lib/pin.js";
import { applyTheme, bindThemeWatcher, normalizeThemeMode } from "../lib/theme.js";

applyTheme(document.documentElement, "system");

let profilesCache = [];
let contactsCache = [];
let unbindThemeWatcher = () => {};

const popupBoot = document.getElementById("popup-boot");
const pinGate = document.getElementById("pin-gate");
const mainShell = document.getElementById("main-shell");
const pinCreateBtn = document.getElementById("pinCreateBtn");
const pinUnlockBtn = document.getElementById("pinUnlockBtn");

const els = {
  tabs: document.querySelectorAll(".tab"),
  profileName: document.getElementById("profileName"),
  generateProfileBtn: document.getElementById("generateProfileBtn"),
  generateStatus: document.getElementById("generateStatus"),
  profileSelect: document.getElementById("profileSelect"),
  contactJson: document.getElementById("contactJson"),
  importContactBtn: document.getElementById("importContactBtn"),
  contactList: document.getElementById("contactList"),
  recipientSelect: document.getElementById("recipientSelect"),
  plaintext: document.getElementById("plaintext"),
  encryptBtn: document.getElementById("encryptBtn"),
  ciphertextOutput: document.getElementById("ciphertextOutput"),
  encryptStatus: document.getElementById("encryptStatus"),
  copyCipherBtn: document.getElementById("copyCipherBtn"),
  exportBtn: document.getElementById("exportBtn"),
  exportOutput: document.getElementById("exportOutput"),
  copyExportBtn: document.getElementById("copyExportBtn"),
  autoDecrypt: document.getElementById("autoDecrypt"),
  themeSelect: document.getElementById("themeSelect"),
  settingsStatus: document.getElementById("settingsStatus"),
  whoMeDetail: document.getElementById("whoMeDetail"),
  whoThemDetail: document.getElementById("whoThemDetail"),
  ciphertextInput: document.getElementById("ciphertextInput"),
  decryptBtn: document.getElementById("decryptBtn"),
  decryptOutput: document.getElementById("decryptOutput"),
  decryptStatus: document.getElementById("decryptStatus"),
  copyDecryptBtn: document.getElementById("copyDecryptBtn"),
  exportFullBackupBtn: document.getElementById("exportFullBackupBtn"),
  fullBackupFile: document.getElementById("fullBackupFile"),
  backupStatus: document.getElementById("backupStatus"),
  handshakeExportPass: document.getElementById("handshakeExportPass"),
  encryptHandshakeBtn: document.getElementById("encryptHandshakeBtn"),
  backupExportPass: document.getElementById("backupExportPass"),
  backupExportPassConfirm: document.getElementById("backupExportPassConfirm"),
  backupImportPass: document.getElementById("backupImportPass"),
  contactHandshakePass: document.getElementById("contactHandshakePass"),
  contactImportStatus: document.getElementById("contactImportStatus")
};

function loadingIndicatorHtml(label = "Working") {
  return `<span class="loading-indicator" role="status"><span class="loading-indicator-spinner" aria-hidden="true"></span><span class="loading-indicator-text">${label}<span class="loading-indicator-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></span></span>`;
}

function setStatusLoading(el, label = "Working") {
  if (!el) return;
  el.classList.remove("is-error");
  el.innerHTML = loadingIndicatorHtml(label);
}

const PASSWORD_TOGGLE_EYE_HTML = `
  <svg class="icon-eye-off" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
  <svg class="icon-eye-on" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>`;

function initPasswordToggleButtons() {
  document.querySelectorAll("[data-password-for]").forEach((btn) => {
    if (btn.querySelector(".icon-eye-off")) return;
    btn.classList.add("btn-toggle-password");
    btn.innerHTML = PASSWORD_TOGGLE_EYE_HTML;
    btn.setAttribute("aria-label", "Show passphrase");
    btn.setAttribute("aria-pressed", "false");
  });
}

function wrapPasswordInputs() {
  document.querySelectorAll("[data-password-for]").forEach((btn) => {
    const id = btn.dataset.passwordFor;
    const input = id && document.getElementById(id);
    if (!input || input.closest(".input-password-wrap")) return;

    const wrap = document.createElement("div");
    wrap.className = "input-password-wrap";
    input.classList.add("input-with-password-toggle");
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    wrap.appendChild(btn);

    const labelRow = wrap.previousElementSibling;
    if (labelRow?.classList.contains("label-row") && labelRow.querySelector("[data-password-for]") === null) {
      labelRow.classList.add("label-row-compact");
    }
  });
}

function setPasswordToggleRevealed(btn, revealed) {
  btn.classList.toggle("is-revealed", revealed);
  btn.setAttribute("aria-pressed", revealed ? "true" : "false");
  btn.setAttribute("aria-label", revealed ? "Hide passphrase" : "Show passphrase");
}

function wirePasswordToggles() {
  initPasswordToggleButtons();
  wrapPasswordInputs();

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-password-for]");
    if (!btn) return;
    const id = btn.dataset.passwordFor;
    const input = id && document.getElementById(id);
    if (!input || (input.type !== "password" && input.type !== "text")) return;
    const revealing = input.type === "password";
    input.type = revealing ? "text" : "password";
    setPasswordToggleRevealed(btn, revealing);
  });
}

function setShellBusy(on) {
  if (mainShell) mainShell.dataset.busy = on ? "1" : "";
}

function setPinBusy(on) {
  pinGate.dataset.busy = on ? "1" : "";
  if (pinCreateBtn) pinCreateBtn.disabled = on;
  if (pinUnlockBtn) pinUnlockBtn.disabled = on;
}

function showInitFailure(message) {
  if (popupBoot) popupBoot.hidden = true;
  pinGate.hidden = false;
  mainShell.hidden = true;
  setPinGateView("error");
  document.getElementById("pin-gate-title").textContent = "Can’t connect";
  const desc = document.getElementById("pin-gate-desc");
  desc.hidden = false;
  desc.textContent = "Close this popup and try the toolbar icon again.";
  const st = document.getElementById("pinGateStatus");
  st.textContent = message;
  st.classList.add("is-error");
}

async function init() {
  try {
    wirePasswordToggles();
    bindTabs();
    bindPinEvents();
  } catch (e) {
    console.error(e);
    showInitFailure(e?.message || String(e));
    return;
  }

  let status;
  try {
    status = await request(MESSAGE_TYPES.PIN_STATUS);
  } catch (e) {
    console.error(e);
    showInitFailure(e?.message || String(e));
    return;
  }

  try {
    applyThemeFromSettings(await request(MESSAGE_TYPES.GET_SETTINGS));
  } catch (_e) {
    applyTheme(document.documentElement, "system");
  }

  if (popupBoot) popupBoot.hidden = true;
  if (!status.hasSecret) {
    showPinCreate();
    return;
  }
  if (!status.unlocked) {
    showPinUnlock();
    return;
  }
  showMainApp();
}

function bindPinEvents() {
  document.getElementById("pinCreateBtn")?.addEventListener("click", onCreatePin);
  document.getElementById("pinUnlockBtn")?.addEventListener("click", onUnlockPin);
  for (const id of ["pinCreatePin", "pinCreateConfirm", "pinUnlockInput"]) {
    const el = document.getElementById(id);
    el?.addEventListener("input", () => {
      if (el.value.length > 256) el.value = el.value.slice(0, 256);
      if (id === "pinCreatePin" || id === "pinCreateConfirm") updatePinCreateValidation();
    });
  }
  document.getElementById("pinUnlockInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onUnlockPin();
  });
  document.getElementById("pinForgotBtn")?.addEventListener("click", showPinForgotScreen);
  document.getElementById("pinForgotBackBtn")?.addEventListener("click", showPinUnlock);
  document.getElementById("pin-forgot-screen")?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") showPinUnlock();
  });
  document.getElementById("pinCreatePin")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const confirmEl = document.getElementById("pinCreateConfirm");
    if (confirmEl && !confirmEl.value.trim()) {
      confirmEl.focus();
    } else {
      onCreatePin();
    }
  });
  document.getElementById("pinCreateConfirm")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onCreatePin();
  });
  els.backupExportPassConfirm?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onExportFullBackup();
  });
}

function updatePinCreateValidation() {
  const pinEl = document.getElementById("pinCreatePin");
  const confirmEl = document.getElementById("pinCreateConfirm");
  const fill = document.getElementById("pinStrengthFill");
  const text = document.getElementById("pinStrengthText");
  const matchEl = document.getElementById("pinMatchText");
  const btn = document.getElementById("pinCreateBtn");
  if (!pinEl || !fill || !text) return;

  const a = normalizeSecret(pinEl.value);
  const b = normalizeSecret(confirmEl?.value ?? "");
  const len = a.length;

  let pct = 0;
  let label = "";
  let strengthClass = "";

  if (len > MAX_SECRET_LENGTH) {
    label = `Too long (max ${MAX_SECRET_LENGTH})`;
    pct = 100;
    strengthClass = "is-error";
  } else if (len === 0) {
    label = `At least ${MIN_SECRET_LENGTH} characters`;
    pct = 0;
    strengthClass = "";
  } else if (len < MIN_SECRET_LENGTH) {
    const need = MIN_SECRET_LENGTH - len;
    label = `${need} more character${need === 1 ? "" : "s"} needed`;
    pct = Math.min(88, (len / MIN_SECRET_LENGTH) * 50);
    strengthClass = "is-weak";
  } else if (len < 20) {
    label = "Good";
    pct = 72;
    strengthClass = "is-ok";
  } else {
    label = "Strong";
    pct = 100;
    strengthClass = "is-strong";
  }

  fill.style.width = `${pct}%`;
  fill.className = strengthClass ? `pin-strength-fill ${strengthClass}` : "pin-strength-fill";
  text.textContent = label;
  text.className = strengthClass ? `pin-strength-label ${strengthClass}` : "pin-strength-label";

  if (matchEl) {
    if (!b.length) {
      matchEl.textContent = "";
      matchEl.className = "pin-match-label";
    } else if (a !== b) {
      matchEl.textContent = "Doesn’t match";
      matchEl.className = "pin-match-label is-error";
    } else {
      matchEl.textContent = "Matches";
      matchEl.className = "pin-match-label is-ok";
    }
  }

  const valid =
    len >= MIN_SECRET_LENGTH &&
    len <= MAX_SECRET_LENGTH &&
    b.length > 0 &&
    a === b;
  if (btn) btn.disabled = !valid;
}

async function onCreatePin() {
  const statusEl = document.getElementById("pinGateStatus");
  statusEl.textContent = "";
  statusEl.classList.remove("is-error");
  const pin = document.getElementById("pinCreatePin").value;
  const pinConfirm = document.getElementById("pinCreateConfirm").value;
  setPinBusy(true);
  setStatusLoading(statusEl, "Working");
  try {
    await request(MESSAGE_TYPES.SET_PIN, { pin, pinConfirm });
    showMainApp();
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.classList.add("is-error");
  } finally {
    setPinBusy(false);
    if (!statusEl.classList.contains("is-error")) statusEl.textContent = "";
  }
}

async function onUnlockPin() {
  const statusEl = document.getElementById("pinGateStatus");
  statusEl.textContent = "";
  statusEl.classList.remove("is-error");
  const pin = document.getElementById("pinUnlockInput").value;
  setPinBusy(true);
  setStatusLoading(statusEl, "Working");
  try {
    await request(MESSAGE_TYPES.UNLOCK_PIN, { pin });
    document.getElementById("pinUnlockInput").value = "";
    showMainApp();
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.classList.add("is-error");
  } finally {
    setPinBusy(false);
    if (!statusEl.classList.contains("is-error")) statusEl.textContent = "";
  }
}

function setPinGateView(view) {
  const header = document.querySelector(".pin-gate-header");
  const body = document.querySelector(".pin-gate-body");
  const create = document.getElementById("pin-create-fields");
  const unlock = document.getElementById("pin-unlock-fields");
  const forgot = document.getElementById("pin-forgot-screen");

  if (header) header.hidden = view === "forgot";
  if (body) body.hidden = view === "forgot" || view === "error";
  if (create) create.hidden = view !== "create";
  if (unlock) unlock.hidden = view !== "unlock";
  if (forgot) forgot.hidden = view !== "forgot";
}

function showPinForgotScreen() {
  if (popupBoot) popupBoot.hidden = true;
  pinGate.hidden = false;
  mainShell.hidden = true;
  setPinGateView("forgot");
  document.getElementById("pinGateStatus").textContent = "";
  document.getElementById("pinGateStatus").classList.remove("is-error");
  document.getElementById("pinForgotBackBtn")?.focus();
}

function showPinCreate() {
  if (popupBoot) popupBoot.hidden = true;
  pinGate.hidden = false;
  mainShell.hidden = true;
  setPinGateView("create");
  document.getElementById("pin-gate-title").textContent = "Welcome";
  const desc = document.getElementById("pin-gate-desc");
  desc.hidden = false;
  desc.textContent = "Protects your keys on this device.";
  document.getElementById("pinCreatePin").value = "";
  document.getElementById("pinCreateConfirm").value = "";
  updatePinCreateValidation();
  document.getElementById("pinCreatePin")?.focus();
}

function showPinUnlock() {
  if (popupBoot) popupBoot.hidden = true;
  pinGate.hidden = false;
  mainShell.hidden = true;
  setPinGateView("unlock");
  document.getElementById("pin-gate-title").textContent = "Unlock Shrimpt";
  const desc = document.getElementById("pin-gate-desc");
  desc.textContent = "";
  desc.hidden = true;
  document.getElementById("pinUnlockInput")?.focus();
}

function showMainApp() {
  if (popupBoot) popupBoot.hidden = true;
  pinGate.hidden = true;
  mainShell.hidden = false;
  try {
    bindEvents();
  } catch (e) {
    console.error(e);
    showInitFailure(e?.message || String(e));
    return;
  }
  refreshAll().catch(console.error);
  loadSettingsUi().catch(console.error);
}

function bindTabs() {
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const panel = tab.dataset.panel;
      if (!panel) return;
      setActiveTab(panel);
    });
  });
}

function setActiveTab(panel) {
  els.tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.panel === panel));
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("is-active", p.id === `panel-${panel}`);
  });
  if (mainShell) {
    mainShell.dataset.activePanel = panel;
  }
}

function bindEvents() {
  els.generateProfileBtn?.addEventListener("click", onGenerateProfile);
  els.profileSelect?.addEventListener("change", onChangeProfile);
  els.recipientSelect?.addEventListener("change", onRecipientChange);
  els.importContactBtn?.addEventListener("click", onImportContact);
  els.encryptBtn?.addEventListener("click", onEncryptText);
  els.exportBtn?.addEventListener("click", onExportPublicBundle);
  els.copyCipherBtn?.addEventListener("click", () =>
    copyField(els.ciphertextOutput, els.encryptStatus, els.copyCipherBtn)
  );
  els.decryptBtn?.addEventListener("click", onDecryptFromPopup);
  els.copyDecryptBtn?.addEventListener("click", () =>
    copyField(els.decryptOutput, els.decryptStatus, els.copyDecryptBtn)
  );
  els.copyExportBtn?.addEventListener("click", () =>
    copyField(els.exportOutput, els.generateStatus, els.copyExportBtn)
  );
  els.autoDecrypt?.addEventListener("change", () => persistSettings());
  els.themeSelect?.addEventListener("change", () => persistSettings());
  els.exportFullBackupBtn?.addEventListener("click", onExportFullBackup);
  els.fullBackupFile?.addEventListener("change", onFullBackupFileSelected);
  els.encryptHandshakeBtn?.addEventListener("click", onEncryptHandshakeExport);
  document.getElementById("openOptionsBtn")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

async function refreshAll() {
  await refreshProfiles();
  await refreshContacts();
}

function fingerprintSnippet(fp) {
  if (!fp || typeof fp !== "string") return null;
  const short = fp.slice(0, 16);
  return short.length ? `${short}…` : null;
}

function updatePeopleSummary() {
  const profileId = els.profileSelect.value;
  const recipientId = els.recipientSelect.value;

  const profile = profilesCache.find((p) => p.id === profileId);
  const contact = contactsCache.find((c) => c.id === recipientId);

  const meName = profile?.name || null;
  const meFp = fingerprintSnippet(profile?.fingerprint);
  const themName = contact?.name || null;
  const themFp = fingerprintSnippet(contact?.fingerprint);

  if (els.whoMeDetail) {
    if (!profileId || !meName) {
      els.whoMeDetail.textContent = "No profile";
      els.whoMeDetail.classList.add("muted");
    } else {
      els.whoMeDetail.textContent = meFp ? meFp : "No fingerprint.";
      els.whoMeDetail.classList.toggle("muted", false);
    }
  }

  if (els.whoThemDetail) {
    if (!recipientId) {
      els.whoThemDetail.textContent = "";
      els.whoThemDetail.classList.remove("muted");
    } else if (!themName) {
      els.whoThemDetail.textContent = "Unknown contact";
      els.whoThemDetail.classList.add("muted");
    } else {
      els.whoThemDetail.textContent = themFp ? themFp : "";
      els.whoThemDetail.classList.toggle("muted", false);
    }
  }

}

function applyThemeFromSettings(settings) {
  unbindThemeWatcher();
  const mode = normalizeThemeMode(settings?.theme);
  applyTheme(document.documentElement, mode);
  unbindThemeWatcher = bindThemeWatcher(mode, document.documentElement);
}

async function loadSettingsUi() {
  const settings = await request(MESSAGE_TYPES.GET_SETTINGS);
  applyThemeFromSettings(settings);
  els.autoDecrypt.checked = Boolean(settings.autoDecrypt);
  if (els.themeSelect) {
    els.themeSelect.value = normalizeThemeMode(settings.theme);
  }
}

async function persistSettings() {
  if (!els.settingsStatus) return;
  try {
    const payload = {
      autoDecrypt: els.autoDecrypt.checked,
      theme: normalizeThemeMode(els.themeSelect?.value)
    };
    const updated = await request(MESSAGE_TYPES.UPDATE_SETTINGS, payload);
    applyThemeFromSettings(updated);
    els.settingsStatus.textContent = "Saved.";
    els.settingsStatus.classList.remove("is-error");
    setTimeout(() => {
      if (els.settingsStatus.textContent === "Saved.") els.settingsStatus.textContent = "";
    }, 1400);
  } catch (error) {
    els.settingsStatus.textContent = formatLockedError(error);
    els.settingsStatus.classList.add("is-error");
  }
}

async function copyField(textarea, statusEl, buttonEl) {
  const text = textarea.value?.trim();
  if (!text) return;

  const showButtonCopied = () => {
    if (!buttonEl) return;
    if (!buttonEl.dataset.copyLabel) {
      buttonEl.dataset.copyLabel = buttonEl.textContent.trim();
    }
    buttonEl.textContent = "Copied";
    buttonEl.classList.add("is-copied");
    setTimeout(() => {
      buttonEl.textContent = buttonEl.dataset.copyLabel;
      buttonEl.classList.remove("is-copied");
    }, 1400);
  };

  try {
    await navigator.clipboard.writeText(text);
    showButtonCopied();
    if (statusEl) {
      statusEl.textContent = "Copied.";
      statusEl.classList.remove("is-error");
    }
  } catch (_err) {
    textarea.select();
    document.execCommand("copy");
    showButtonCopied();
    if (statusEl) statusEl.textContent = "Copied.";
  }
}

function appendEmptyContactState(listEl) {
  const li = document.createElement("li");
  li.className = "empty-state";
  li.innerHTML = `
    <span class="empty-state-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path
          d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </span>
    <p class="empty-state-title">No contacts yet</p>
    <p class="empty-state-hint">Import a handshake or JSON above</p>
  `;
  listEl.appendChild(li);
}

async function refreshProfiles() {
  profilesCache = await request(MESSAGE_TYPES.LIST_PROFILES);
  els.profileSelect.innerHTML = "";

  if (!profilesCache.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No identities yet";
    els.profileSelect.appendChild(opt);
    updatePeopleSummary();
    return;
  }

  for (const profile of profilesCache) {
    const opt = document.createElement("option");
    opt.value = profile.id;
    opt.textContent = `${profile.name}${profile.active ? " (active)" : ""}`;
    opt.selected = profile.active;
    els.profileSelect.appendChild(opt);
  }
  updatePeopleSummary();
}

async function refreshContacts() {
  contactsCache = await request(MESSAGE_TYPES.LIST_CONTACTS);
  const settings = await request(MESSAGE_TYPES.GET_SETTINGS);
  const savedRecipientId = settings.selectedRecipientContactId || "";

  els.contactList.innerHTML = "";
  els.recipientSelect.innerHTML = "";

  if (!contactsCache.length) {
    appendEmptyContactState(els.contactList);

    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No contacts yet";
    els.recipientSelect.appendChild(opt);
    if (savedRecipientId) {
      await persistSelectedRecipientId(null);
    }
    updatePeopleSummary();
    return;
  }

  const optAnyone = document.createElement("option");
  optAnyone.value = "";
  optAnyone.textContent = "Anyone";
  els.recipientSelect.appendChild(optAnyone);

  let matchedSaved = false;
  for (const contact of contactsCache) {
    const li = document.createElement("li");
    const fp = contact.fingerprint?.slice(0, 16) || "—";
    li.textContent = `${contact.name} · ${fp}…`;
    els.contactList.appendChild(li);

    const opt = document.createElement("option");
    opt.value = contact.id;
    opt.textContent = contact.name;
    if (savedRecipientId && contact.id === savedRecipientId) {
      opt.selected = true;
      matchedSaved = true;
    }
    els.recipientSelect.appendChild(opt);
  }

  if (!matchedSaved) {
    els.recipientSelect.options[0].selected = true;
    await persistSelectedRecipientId(null);
  }

  updatePeopleSummary();
}

async function persistSelectedRecipientId(contactId) {
  await request(MESSAGE_TYPES.UPDATE_SETTINGS, {
    selectedRecipientContactId: contactId || null
  });
}

async function onRecipientChange() {
  const id = els.recipientSelect.value || null;
  await persistSelectedRecipientId(id);
  updatePeopleSummary();
}

async function onGenerateProfile() {
  els.generateStatus.textContent = "";
  els.generateStatus.classList.remove("is-error");
  const name = els.profileName.value.trim();
  if (!name) {
    els.generateStatus.textContent = "Enter an identity name first.";
    els.generateStatus.classList.add("is-error");
    return;
  }

  setShellBusy(true);
  setStatusLoading(els.generateStatus, "Working");
  try {
    const profile = await request(MESSAGE_TYPES.GENERATE_PROFILE, { name });
    els.generateStatus.textContent = `Created “${profile.name}”.`;
    els.profileName.value = "";
    await refreshProfiles();
  } catch (error) {
    els.generateStatus.textContent = formatLockedError(error);
    els.generateStatus.classList.add("is-error");
  } finally {
    setShellBusy(false);
  }
}

async function onChangeProfile() {
  const profileId = els.profileSelect.value;
  if (!profileId) return;
  await request(MESSAGE_TYPES.SET_ACTIVE_PROFILE, { profileId });
  await refreshProfiles();
}

async function onImportContact() {
  if (els.contactImportStatus) {
    els.contactImportStatus.textContent = "";
    els.contactImportStatus.classList.remove("is-error");
  }
  const raw = els.contactJson.value.trim();
  if (!raw) return;

  setShellBusy(true);
  if (els.contactImportStatus) setStatusLoading(els.contactImportStatus, "Working");
  try {
    const parsed = JSON.parse(raw);

    if (parsed.uwuEncrypted === 1) {
      await request(MESSAGE_TYPES.IMPORT_ENCRYPTED_HANDSHAKE, {
        blobText: raw,
        passphrase: els.contactHandshakePass?.value ?? ""
      });
    } else {
      await request(MESSAGE_TYPES.IMPORT_CONTACT_PUBLIC_KEY, {
        name: parsed.name,
        profileId: parsed.profileId,
        fingerprint: parsed.fingerprint,
        encryptionPublicJwk: parsed.encryptionPublicJwk,
        signingPublicJwk: parsed.signingPublicJwk
      });
    }

    els.contactJson.value = "";
    if (els.contactHandshakePass) els.contactHandshakePass.value = "";
    await refreshContacts();
    if (els.contactImportStatus) {
      els.contactImportStatus.textContent = "Contact imported.";
      els.contactImportStatus.classList.remove("is-error");
    }
  } catch (error) {
    if (els.contactImportStatus) {
      els.contactImportStatus.textContent = `Import failed: ${formatLockedError(error)}`;
      els.contactImportStatus.classList.add("is-error");
    }
  } finally {
    setShellBusy(false);
  }
}

async function onEncryptHandshakeExport() {
  els.generateStatus.textContent = "";
  els.generateStatus.classList.remove("is-error");
  try {
    const active = await request(MESSAGE_TYPES.GET_ACTIVE_PROFILE);
    if (!active?.id) {
      els.generateStatus.textContent = "Choose You above.";
      els.generateStatus.classList.add("is-error");
      return;
    }

    const passphrase = els.handshakeExportPass?.value ?? "";
    setShellBusy(true);
    setStatusLoading(els.generateStatus, "Working");
    const wrap = await request(MESSAGE_TYPES.ENCRYPT_HANDSHAKE_EXPORT, {
      profileId: active.id,
      passphrase
    });
    els.exportOutput.value = JSON.stringify(wrap, null, 2);
    els.generateStatus.textContent = "Handshake ready.";
  } catch (error) {
    els.generateStatus.textContent = formatLockedError(error);
    els.generateStatus.classList.add("is-error");
  } finally {
    setShellBusy(false);
  }
}

async function onEncryptText() {
  els.encryptStatus.textContent = "";
  els.encryptStatus.classList.remove("is-error");
  const recipientContactId = els.recipientSelect.value;
  const plaintext = els.plaintext.value;
  if (!recipientContactId) {
    els.encryptStatus.textContent = "Choose Them above to encrypt for a contact.";
    els.encryptStatus.classList.add("is-error");
    els.recipientSelect?.focus();
    return;
  }
  if (!plaintext.trim()) {
    els.encryptStatus.textContent = "Enter a message to encrypt.";
    els.encryptStatus.classList.add("is-error");
    return;
  }

  setShellBusy(true);
  setStatusLoading(els.encryptStatus, "Working");
  try {
    const { compact } = await request(MESSAGE_TYPES.ENCRYPT_TEXT, {
      plaintext,
      recipientContactId
    });

    els.ciphertextOutput.value = wrapEnvelope(compact);
    els.encryptStatus.textContent = `Encrypted for ${contactsCache.find((c) => c.id === recipientContactId)?.name || "recipient"}.`;
  } catch (error) {
    els.encryptStatus.textContent = formatLockedError(error);
    els.encryptStatus.classList.add("is-error");
  } finally {
    setShellBusy(false);
  }
}

async function onExportPublicBundle() {
  els.generateStatus.textContent = "";
  els.generateStatus.classList.remove("is-error");
  try {
    const active = await request(MESSAGE_TYPES.GET_ACTIVE_PROFILE);
    if (!active?.id) {
      els.generateStatus.textContent = "Choose You above.";
      els.generateStatus.classList.add("is-error");
      return;
    }

    setShellBusy(true);
    setStatusLoading(els.generateStatus, "Working");
    const bundle = await request(MESSAGE_TYPES.EXPORT_PUBLIC_KEY, { profileId: active.id });
    els.exportOutput.value = JSON.stringify(bundle, null, 2);
    els.generateStatus.textContent = "Exported.";
  } catch (error) {
    els.generateStatus.textContent = formatLockedError(error);
    els.generateStatus.classList.add("is-error");
  } finally {
    setShellBusy(false);
  }
}

function extractCompactPayload(text) {
  if (!text || typeof text !== "string") return { payload: null, note: null };
  const trimmed = text.trim();
  if (!trimmed) return { payload: null, note: null };

  const wrapped = unwrapEnvelopeString(trimmed);
  if (wrapped) return { payload: wrapped.payload, note: null };

  const matches = findEnvelopeMatches(trimmed);
  if (matches.length > 1) {
    return {
      payload: matches[0].payload,
      note: "Multiple Shrimpt blocks in the paste — only the first was decrypted."
    };
  }
  if (matches.length === 1) {
    return { payload: matches[0].payload, note: null };
  }

  try {
    JSON.parse(atob(trimmed));
    return { payload: trimmed, note: null };
  } catch {
    return { payload: null, note: null };
  }
}

async function onDecryptFromPopup() {
  els.decryptStatus.textContent = "";
  els.decryptStatus.classList.remove("is-error");
  els.decryptOutput.value = "";

  const { payload, note } = extractCompactPayload(els.ciphertextInput.value);
  if (!payload) {
    els.decryptStatus.textContent = "No valid payload.";
    els.decryptStatus.classList.add("is-error");
    return;
  }

  setShellBusy(true);
  setStatusLoading(els.decryptStatus, "Working");
  try {
    const result = await request(MESSAGE_TYPES.DECRYPT_ENVELOPE, { compactEnvelope: payload });

    if (result?.skipped && result.code === "WRONG_CONVERSATION") {
      els.decryptStatus.textContent = "Wrong sender for current Them.";
      els.decryptStatus.classList.add("is-error");
      return;
    }

    els.decryptOutput.value = result.plaintext ?? "";

    const sender = result.senderName || result.senderProfileId || "unknown";
    const bits = [];
    if (note) bits.push(note);
    if (result.verified) {
      bits.push(`Verified · ${sender}`);
    } else {
      bits.push(`From ${sender}${result.senderKnown ? "" : " (unknown signer)"}`);
    }
    els.decryptStatus.textContent = bits.join(" — ");
  } catch (error) {
    els.decryptStatus.textContent = formatLockedError(error);
    els.decryptStatus.classList.add("is-error");
  } finally {
    setShellBusy(false);
  }
}

function formatLockedError(error) {
  if (error?.code === ERROR_CODES.LOCKED || error?.message === "LOCKED") {
    return "Locked — open this popup and enter your unlock secret.";
  }
  return error?.message || String(error);
}

function downloadJsonFile(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function onExportFullBackup() {
  if (els.backupStatus) {
    els.backupStatus.textContent = "";
    els.backupStatus.classList.remove("is-error");
  }
  setShellBusy(true);
  if (els.backupStatus) setStatusLoading(els.backupStatus, "Working");
  try {
    const passphrase = els.backupExportPass?.value ?? "";
    const passphraseConfirm = els.backupExportPassConfirm?.value ?? "";
    const wrap = await request(MESSAGE_TYPES.EXPORT_FULL_BACKUP, {
      passphrase,
      passphraseConfirm
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadJsonFile(`shrimpt-backup-${stamp}.json`, wrap);
    if (els.backupStatus) {
      els.backupStatus.textContent = "Downloaded.";
    }
  } catch (error) {
    if (els.backupStatus) {
      els.backupStatus.textContent = formatLockedError(error);
      els.backupStatus.classList.add("is-error");
    }
  } finally {
    setShellBusy(false);
  }
}

async function onFullBackupFileSelected(ev) {
  const input = ev.target;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !els.backupStatus) return;

  els.backupStatus.textContent = "";
  els.backupStatus.classList.remove("is-error");

  try {
    const text = await file.text();
    const head = JSON.parse(text.trim());
    const isEnc = head && head.uwuEncrypted === 1;
    const backupPass = els.backupImportPass?.value ?? "";
    if (isEnc && !backupPass.trim()) {
      els.backupStatus.textContent = "This backup is encrypted — enter the backup password above.";
      els.backupStatus.classList.add("is-error");
      return;
    }

    const ok = confirm(
      "Replace all keys, contacts, and settings on this device with this backup? This cannot be undone."
    );
    if (!ok) return;

    const token = prompt("To continue, type REPLACE in capital letters:");
    if (token !== "REPLACE") {
      els.backupStatus.textContent = "Restore cancelled.";
      return;
    }

    setShellBusy(true);
    setStatusLoading(els.backupStatus, "Working");
    await request(MESSAGE_TYPES.IMPORT_FULL_BACKUP, {
      rawText: text,
      passphrase: backupPass,
      confirmToken: "REPLACE"
    });
    location.reload();
  } catch (error) {
    els.backupStatus.textContent = formatLockedError(error);
    els.backupStatus.classList.add("is-error");
  } finally {
    setShellBusy(false);
  }
}

function request(type, payload = {}, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            finish(reject, new Error("Extension did not respond in time."));
          }, timeoutMs)
        : null;

    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        finish(reject, new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response?.ok) {
        const err = new Error(response?.error || "Unknown extension error.");
        if (response?.code) err.code = response.code;
        finish(reject, err);
        return;
      }

      finish(resolve, response.result);
    });
  });
}

init().catch((e) => {
  console.error(e);
  showInitFailure(e?.message || String(e));
});
