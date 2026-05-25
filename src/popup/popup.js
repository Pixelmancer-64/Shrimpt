import { ERROR_CODES, MESSAGE_TYPES } from "../lib/constants.js";
import { findEnvelopeMatches, unwrapEnvelopeString, wrapEnvelope } from "../lib/encoding.js";
import { MAX_SECRET_LENGTH, MIN_SECRET_LENGTH, normalizeSecret } from "../lib/pin.js";

let profilesCache = [];
let contactsCache = [];

const popupBoot = document.getElementById("popup-boot");
const pinGate = document.getElementById("pin-gate");
const mainShell = document.getElementById("main-shell");
const pinCreateBtn = document.getElementById("pinCreateBtn");
const pinUnlockBtn = document.getElementById("pinUnlockBtn");

const els = {
  tabs: document.querySelectorAll(".tab"),
  contextBarHint: document.getElementById("contextBarHint"),
  contextBarHintWrap: document.getElementById("contextBarHintWrap"),
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
  clickToReveal: document.getElementById("clickToReveal"),
  clickToRevealRow: document.getElementById("clickToRevealRow"),
  observerDebounceMs: document.getElementById("observerDebounceMs"),
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

init().catch(console.error);

/** Debounce for scan interval numeric field — avoids spamming the background worker. */
let settingsPersistTimer = null;

function wirePasswordToggles() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-password-for]");
    if (!btn) return;
    const id = btn.dataset.passwordFor;
    const input = id && document.getElementById(id);
    if (!input || (input.type !== "password" && input.type !== "text")) return;
    const revealing = input.type === "password";
    input.type = revealing ? "text" : "password";
    btn.textContent = revealing ? "Hide" : "Show";
    btn.setAttribute("aria-pressed", revealing ? "true" : "false");
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

async function init() {
  wirePasswordToggles();
  bindTabs();
  bindPinEvents();
  let status;
  try {
    status = await request(MESSAGE_TYPES.PIN_STATUS);
  } catch (e) {
    console.error(e);
    if (popupBoot) popupBoot.hidden = true;
    pinGate.hidden = false;
    mainShell.hidden = true;
    document.getElementById("pin-create-fields").hidden = true;
    document.getElementById("pin-unlock-fields").hidden = true;
    document.getElementById("pin-gate-title").textContent = "Can’t connect";
    document.getElementById("pin-gate-desc").textContent =
      "The extension didn’t respond. Close this popup and try the toolbar icon again.";
    const st = document.getElementById("pinGateStatus");
    st.textContent = e?.message || String(e);
    st.classList.add("is-error");
    return;
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
  statusEl.textContent = "Working…";
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
  statusEl.textContent = "Working…";
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

function showPinCreate() {
  pinGate.hidden = false;
  mainShell.hidden = true;
  document.getElementById("pin-create-fields").hidden = false;
  document.getElementById("pin-unlock-fields").hidden = true;
  document.getElementById("pin-gate-title").textContent = "Welcome";
  document.getElementById("pin-gate-desc").textContent =
    "This passphrase unlocks Shrimpt and protects your keys on this device. It never leaves your browser.";
  document.getElementById("pinCreatePin").value = "";
  document.getElementById("pinCreateConfirm").value = "";
  updatePinCreateValidation();
  document.getElementById("pinCreatePin")?.focus();
}

function showPinUnlock() {
  pinGate.hidden = false;
  mainShell.hidden = true;
  document.getElementById("pin-create-fields").hidden = true;
  document.getElementById("pin-unlock-fields").hidden = false;
  document.getElementById("pin-gate-title").textContent = "Unlock Shrimpt";
  document.getElementById("pin-gate-desc").textContent =
    "Enter your passphrase to use your keys in this browser session. If you just restarted the browser, this is normal.";
  document.getElementById("pinUnlockInput")?.focus();
}

function showMainApp() {
  pinGate.hidden = true;
  mainShell.hidden = false;
  bindEvents();
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
  els.generateProfileBtn.addEventListener("click", onGenerateProfile);
  els.profileSelect.addEventListener("change", onChangeProfile);
  els.recipientSelect.addEventListener("change", onRecipientChange);
  els.importContactBtn.addEventListener("click", onImportContact);
  els.encryptBtn.addEventListener("click", onEncryptText);
  els.exportBtn.addEventListener("click", onExportPublicBundle);
  els.copyCipherBtn.addEventListener("click", () => copyField(els.ciphertextOutput, els.encryptStatus));
  els.decryptBtn.addEventListener("click", onDecryptFromPopup);
  els.copyDecryptBtn.addEventListener("click", () => copyField(els.decryptOutput, els.decryptStatus));
  els.copyExportBtn.addEventListener("click", () => copyField(els.exportOutput, els.generateStatus));
  els.autoDecrypt.addEventListener("change", () => {
    updateClickToRevealRowVisibility();
    persistSettings();
  });
  els.clickToReveal.addEventListener("change", () => persistSettings());
  els.observerDebounceMs.addEventListener("input", schedulePersistSettings);
  els.observerDebounceMs.addEventListener("change", () => persistSettings());
  els.exportFullBackupBtn?.addEventListener("click", onExportFullBackup);
  els.fullBackupFile?.addEventListener("change", onFullBackupFileSelected);
  els.encryptHandshakeBtn?.addEventListener("click", onEncryptHandshakeExport);
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
      els.whoMeDetail.textContent = "No profile — add one on Identities.";
      els.whoMeDetail.classList.add("muted");
    } else {
      els.whoMeDetail.textContent = meFp ? meFp : "No fingerprint.";
      els.whoMeDetail.classList.toggle("muted", false);
    }
  }

  if (els.whoThemDetail) {
    if (!recipientId) {
      els.whoThemDetail.textContent = "Anyone — any sender on pages.";
      els.whoThemDetail.classList.add("muted");
    } else if (!themName) {
      els.whoThemDetail.textContent = "Unknown — import on Contacts.";
      els.whoThemDetail.classList.add("muted");
    } else {
      els.whoThemDetail.textContent = themFp ? themFp : "No fingerprint.";
      els.whoThemDetail.classList.toggle("muted", false);
    }
  }

  updateContextBarHint(meName, recipientId, themName);
}

function updateContextBarHint(meName, recipientId, themName) {
  if (!els.contextBarHint) return;
  let msg = "";
  if (meName && !recipientId) {
    msg = "Them is Anyone — pages accept any sender.";
  } else if (meName && recipientId && !themName) {
    msg = "Pick a valid Them contact (Contacts tab).";
  } else if (meName && recipientId && themName) {
    msg = `Pages: only from ${themName}.`;
  }
  els.contextBarHint.textContent = msg;
  if (els.contextBarHintWrap) {
    els.contextBarHintWrap.hidden = !msg.trim();
  }
}

function updateClickToRevealRowVisibility() {
  if (!els.clickToRevealRow || !els.autoDecrypt) return;
  els.clickToRevealRow.hidden = els.autoDecrypt.checked;
}

async function loadSettingsUi() {
  const settings = await request(MESSAGE_TYPES.GET_SETTINGS);
  els.autoDecrypt.checked = Boolean(settings.autoDecrypt);
  els.clickToReveal.checked = Boolean(settings.clickToReveal);
  els.observerDebounceMs.value = settings.observerDebounceMs;
  updateClickToRevealRowVisibility();
}

function schedulePersistSettings() {
  if (settingsPersistTimer) clearTimeout(settingsPersistTimer);
  settingsPersistTimer = setTimeout(() => {
    settingsPersistTimer = null;
    persistSettings();
  }, 400);
}

async function persistSettings() {
  if (!els.settingsStatus) return;
  try {
    const payload = {
      autoDecrypt: els.autoDecrypt.checked,
      clickToReveal: els.clickToReveal.checked,
      observerDebounceMs: Number(els.observerDebounceMs.value) || 250
    };
    await request(MESSAGE_TYPES.UPDATE_SETTINGS, payload);
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

async function copyField(textarea, statusEl) {
  const text = textarea.value?.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (statusEl) {
      statusEl.textContent = "Copied to clipboard.";
      statusEl.classList.remove("is-error");
    }
  } catch (_err) {
    textarea.select();
    document.execCommand("copy");
    if (statusEl) statusEl.textContent = "Copied (fallback).";
  }
}

async function refreshProfiles() {
  profilesCache = await request(MESSAGE_TYPES.LIST_PROFILES);
  els.profileSelect.innerHTML = "";

  if (!profilesCache.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No identities yet — create one on Identities";
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
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No contacts — import a handshake or JSON above.";
    els.contactList.appendChild(li);

    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No contacts yet — import on this tab";
    els.recipientSelect.appendChild(opt);
    if (savedRecipientId) {
      await persistSelectedRecipientId(null);
    }
    updatePeopleSummary();
    return;
  }

  const optAnyone = document.createElement("option");
  optAnyone.value = "";
  optAnyone.textContent = "Anyone — all ciphertext on pages";
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
  els.generateStatus.textContent = "Working…";
  try {
    const profile = await request(MESSAGE_TYPES.GENERATE_PROFILE, { name });
    els.generateStatus.textContent = `Created “${profile.name}”. It is now selected as You above.`;
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
  if (els.contactImportStatus) els.contactImportStatus.textContent = "Working…";
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
      els.generateStatus.textContent = "No active profile. Choose You on the Who tab.";
      els.generateStatus.classList.add("is-error");
      return;
    }

    const passphrase = els.handshakeExportPass?.value ?? "";
    setShellBusy(true);
    els.generateStatus.textContent = "Working…";
    const wrap = await request(MESSAGE_TYPES.ENCRYPT_HANDSHAKE_EXPORT, {
      profileId: active.id,
      passphrase
    });
    els.exportOutput.value = JSON.stringify(wrap, null, 2);
    els.generateStatus.textContent = `Encrypted handshake for “${active.name}”. Share the blob + confirmation code separately.`;
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
  els.encryptStatus.textContent = "Working…";
  try {
    const { compact } = await request(MESSAGE_TYPES.ENCRYPT_TEXT, {
      plaintext,
      recipientContactId
    });

    els.ciphertextOutput.value = wrapEnvelope(compact);
    els.encryptStatus.textContent = `Encrypted for ${contactsCache.find((c) => c.id === recipientContactId)?.name || "recipient"}. Paste into any page.`;
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
      els.generateStatus.textContent = "No active profile. Choose You on the Who tab.";
      els.generateStatus.classList.add("is-error");
      return;
    }

    setShellBusy(true);
    els.generateStatus.textContent = "Working…";
    const bundle = await request(MESSAGE_TYPES.EXPORT_PUBLIC_KEY, { profileId: active.id });
    els.exportOutput.value = JSON.stringify(bundle, null, 2);
    els.generateStatus.textContent = `Plain JSON for “${active.name}” — for local use only.`;
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
    els.decryptStatus.textContent =
      "No valid payload. Paste wrapped !shpt!…!shpt! text, or a single base64 envelope string.";
    els.decryptStatus.classList.add("is-error");
    return;
  }

  setShellBusy(true);
  els.decryptStatus.textContent = "Working…";
  try {
    const result = await request(MESSAGE_TYPES.DECRYPT_ENVELOPE, { compactEnvelope: payload });

    if (result?.skipped && result.code === "WRONG_CONVERSATION") {
      els.decryptStatus.textContent =
        "Not decrypted: sender does not match Them. Choose Anyone or the correct contact above.";
      els.decryptStatus.classList.add("is-error");
      return;
    }

    els.decryptOutput.value = result.plaintext ?? "";

    const sender = result.senderName || result.senderProfileId || "unknown";
    const bits = [];
    if (note) bits.push(note);
    if (result.verified) {
      bits.push(`Signature verified · from ${sender}`);
    } else {
      bits.push(
        `Decrypted · from ${sender}${result.senderKnown ? "" : " (signing key not in your contacts)"}`
      );
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
  if (els.backupStatus) els.backupStatus.textContent = "Working…";
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
      els.backupStatus.textContent = "Encrypted backup downloaded. Store the password separately.";
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
    els.backupStatus.textContent = "Working…";
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
