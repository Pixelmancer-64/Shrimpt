/**
 * Classic script (no import) — content scripts are not modules in all browsers.
 * Keep in sync with src/lib/constants.js and findEnvelopeMatches in src/lib/encoding.js.
 */
const MARKER_PREFIX = "!uwu!";
const MARKER_SUFFIX = "!uwu!";

const STORAGE_KEYS = {
  SETTINGS: "settings",
  ACTIVE_PROFILE_ID: "activeProfileId"
};

const DEFAULT_SETTINGS = {
  autoDecrypt: true,
  clickToReveal: true,
  observerDebounceMs: 250,
  scanTextLimit: 120000,
  selectedRecipientContactId: null,
  inputEncryptMode: "off",
  lastInputEncryptMode: "button_replace",
  uwuDockLeft: null,
  uwuDockTop: null,
  uwuHudLeft: null,
  uwuHudTop: null
};

const MESSAGE_TYPES = {
  GET_SETTINGS: "GET_SETTINGS",
  DECRYPT_ENVELOPE: "DECRYPT_ENVELOPE",
  ENCRYPT_TEXT: "ENCRYPT_TEXT",
  UPDATE_SETTINGS: "UPDATE_SETTINGS",
  LIST_PROFILES: "LIST_PROFILES",
  LIST_CONTACTS: "LIST_CONTACTS",
  SET_ACTIVE_PROFILE: "SET_ACTIVE_PROFILE"
};

function findEnvelopeMatches(text) {
  if (!text || typeof text !== "string") return [];
  const matches = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf(MARKER_PREFIX, cursor);
    if (start === -1) break;
    const payloadStart = start + MARKER_PREFIX.length;
    const end = text.indexOf(MARKER_SUFFIX, payloadStart);
    if (end === -1) break;

    matches.push({
      start,
      end: end + MARKER_SUFFIX.length,
      payload: text.slice(payloadStart, end)
    });

    cursor = end + MARKER_SUFFIX.length;
  }

  return matches;
}

function wrapEnvelopeCompact(compact) {
  return MARKER_PREFIX + compact + MARKER_SUFFIX;
}

const SCAN_HIGHLIGHT_NAME = "uwu-scanned-text";
const UWU_FIELD_CANDIDATE_CLASS = "uwu-field-candidate";
const CE_HOST_SELECTOR =
  '[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]';

const processedNodes = new WeakSet();
let observer = null;
let debounceTimer = null;
let settingsCache = null;
let scanGeneration = 0;
let hudRoot = null;
let lastFieldCandidateEls = new Set();
let fieldAutoBindTimer = null;
let fieldAutoBindGen = 0;

bootstrap().catch(console.error);

async function bootstrap() {
  settingsCache = await request(MESSAGE_TYPES.GET_SETTINGS);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const profileChanged = Boolean(changes[STORAGE_KEYS.ACTIVE_PROFILE_ID]);
    const settingsChanged = Boolean(changes[STORAGE_KEYS.SETTINGS]);
    if (!profileChanged && !settingsChanged) return;
    onIdentityOrConversationStorageChanged().catch(console.error);
  });
  ensureScanHud();
  syncFieldProtectionChrome();
  await rescanPage();
  startObserver();
  startFieldEncryptFocusCapture();
  if (getInputEncryptMode() !== "off") {
    scheduleFieldAutoBind();
  }
}

async function onIdentityOrConversationStorageChanged() {
  settingsCache = await request(MESSAGE_TYPES.GET_SETTINGS);
  applyHudLayoutPosition();
  applyDockLayoutPosition();
  syncFieldProtectionChrome();
  if (getInputEncryptMode() !== "off") {
    scheduleFieldAutoBind();
  }
  const wrappers = [...document.querySelectorAll(".uwu-envelope-wrapper[data-uwu-compact]")];
  for (const w of wrappers) {
    await rebuildEnvelopeWrapper(w);
  }
  scheduleRescan();
}

async function rebuildEnvelopeWrapper(wrapper) {
  const compact = wrapper.getAttribute("data-uwu-compact");
  if (!compact) return;
  const parent = wrapper.parentNode;
  if (!parent) return;
  const fresh = await buildDecryptedNode(compact);
  parent.replaceChild(fresh, wrapper);
}

function startObserver() {
  observer = new MutationObserver(() => scheduleRescan());

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function scheduleRescan() {
  if (debounceTimer) clearTimeout(debounceTimer);
  const ms = settingsCache?.observerDebounceMs ?? 250;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    rescanPage().catch(console.error);
  }, ms);
}

function scanTextLimit() {
  return settingsCache?.scanTextLimit ?? 120000;
}

function acceptEligibleTextNode(node) {
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  const text = node.nodeValue || "";
  if (text.length > scanTextLimit()) return false;
  if (!text.trim()) return false;
  const parent = node.parentElement;
  if (!parent) return false;
  if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(parent.tagName)) return false;
  if (parent.closest(".uwu-scan-hud, .uwu-chrome-dock")) return false;
  if (parent.closest(".uwu-envelope-wrapper")) return false;
  return true;
}

function collectEligibleTextNodes(root) {
  const out = [];
  if (!root) return out;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return acceptEligibleTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });

  let current;
  while ((current = walker.nextNode())) {
    out.push(current);
  }
  return out;
}

function clearScanHighlight() {
  try {
    if (typeof CSS !== "undefined" && CSS.highlights?.delete) {
      CSS.highlights.delete(SCAN_HIGHLIGHT_NAME);
    }
  } catch (_e) {
    /* ignore */
  }
}

function applyScanHighlight(textNodes) {
  clearScanHighlight();
  if (!textNodes.length || typeof Highlight === "undefined" || !CSS.highlights?.set) return;

  const highlight = new Highlight();
  for (const node of textNodes) {
    if (!node.parentNode || !acceptEligibleTextNode(node)) continue;
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      highlight.add(range);
    } catch (_e) {
      /* detached or invalid */
    }
  }
  try {
    CSS.highlights.set(SCAN_HIGHLIGHT_NAME, highlight);
  } catch (_e) {
    /* unsupported */
  }
}

function ensureScanHud() {
  if (hudRoot?.isConnected && hudRoot.querySelector(".uwu-scan-hud-drag")) {
    applyHudLayoutPosition();
    return;
  }
  if (hudRoot?.isConnected) hudRoot.remove();

  hudRoot = document.createElement("div");
  hudRoot.className = "uwu-scan-hud";
  hudRoot.setAttribute("role", "status");
  hudRoot.setAttribute("aria-live", "polite");
  hudRoot.innerHTML = `
    <button type="button" class="uwu-scan-hud-drag" aria-label="Drag to move scan summary">⣿</button>
    <div class="uwu-scan-hud-inner">
      <div class="uwu-scan-hud-top">
        <div class="uwu-scan-hud-headline">
          <span class="uwu-scan-hud-title">UWU layer</span>
          <span class="uwu-scan-hud-pill" aria-hidden="true"></span>
        </div>
        <button type="button" class="uwu-scan-hud-toggle" aria-expanded="true" aria-label="Collapse scan summary">▾</button>
      </div>
      <div class="uwu-scan-hud-details">
        <p class="uwu-scan-hud-stats"><strong class="uwu-scan-hud-count">—</strong></p>
        <p class="uwu-scan-hud-meta muted"></p>
      </div>
    </div>
  `;

  const toggle = hudRoot.querySelector(".uwu-scan-hud-toggle");
  toggle?.addEventListener("click", () => {
    const collapsed = hudRoot.classList.toggle("is-collapsed");
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.textContent = collapsed ? "▸" : "▾";
    requestAnimationFrame(() => applyHudLayoutPosition());
  });

  (document.body || document.documentElement).appendChild(hudRoot);
  applyHudLayoutPosition();
  const dragEl = hudRoot.querySelector(".uwu-scan-hud-drag");
  attachOverlayDrag(hudRoot, dragEl, "uwuHudLeft", "uwuHudTop");
}

function updateScanHud({ textNodeCount, ciphertextBlocks, highlightSupported }) {
  ensureScanHud();
  const statsEl = hudRoot.querySelector(".uwu-scan-hud-stats");
  const metaEl = hudRoot.querySelector(".uwu-scan-hud-meta");
  const pillEl = hudRoot.querySelector(".uwu-scan-hud-pill");
  if (!statsEl || !metaEl) return;

  if (pillEl) {
    pillEl.textContent = `${textNodeCount} regions · ${ciphertextBlocks} enc`;
  }

  const hl = highlightSupported ? "" : " Highlights unavailable in this browser.";
  statsEl.innerHTML = `<strong class="uwu-scan-hud-count">${textNodeCount}</strong> text region${textNodeCount === 1 ? "" : "s"} scanned · <strong>${ciphertextBlocks}</strong> encrypted block${ciphertextBlocks === 1 ? "" : "s"}${hl}`;

  const time = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  metaEl.textContent = `Scan updated ${time}`;
}

async function rescanPage() {
  const gen = ++scanGeneration;
  const root = document.body;
  if (!root) return;

  const snapshot = collectEligibleTextNodes(root);
  const markerNodes = snapshot.filter((n) => {
    const t = n.nodeValue || "";
    return t.includes(MARKER_PREFIX) && findEnvelopeMatches(t).length > 0;
  });

  for (const node of markerNodes) {
    if (gen !== scanGeneration) return;
    await processTextNode(node);
  }

  if (gen !== scanGeneration) return;

  const afterNodes = collectEligibleTextNodes(document.body);
  applyScanHighlight(afterNodes);

  const ciphertextBlocks = document.querySelectorAll(".uwu-envelope-wrapper").length;
  const highlightSupported = typeof Highlight !== "undefined" && Boolean(CSS.highlights?.set);

  updateScanHud({
    textNodeCount: afterNodes.length,
    ciphertextBlocks,
    highlightSupported
  });

  syncFieldCandidateMarks();
}

/**
 * Yellow tint on inputs/textareas and outermost contenteditable hosts so you can
 * see which controls the extension treats as user-input surfaces.
 */
function syncFieldCandidateMarks() {
  const root = document.body;
  if (!root) return;

  const next = new Set();

  const allCe = [];
  for (const el of root.querySelectorAll(CE_HOST_SELECTOR)) {
    if (isUwuChromeTree(el)) continue;
    if (el.closest(".uwu-envelope-wrapper")) continue;
    const v = el.getAttribute("contenteditable");
    if (v !== "true" && v !== "" && v !== "plaintext-only") continue;
    allCe.push(el);
  }

  const ceSet = new Set(allCe);
  for (const el of allCe) {
    let p = el.parentElement;
    let hasCeAncestor = false;
    while (p) {
      if (ceSet.has(p)) {
        hasCeAncestor = true;
        break;
      }
      p = p.parentElement;
    }
    if (!hasCeAncestor) next.add(el);
  }

  for (const el of root.querySelectorAll("textarea, input")) {
    if (isUwuChromeTree(el)) continue;
    if (el.closest(".uwu-envelope-wrapper")) continue;
    if (el.tagName === "TEXTAREA") {
      if (!el.disabled && !el.readOnly) next.add(el);
      continue;
    }
    if (el.tagName !== "INPUT") continue;
    const t = (el.type || "text").toLowerCase();
    if (!["text", "search", "email", "url", "tel"].includes(t) || el.disabled || el.readOnly) continue;
    if (el.closest(CE_HOST_SELECTOR)) continue;
    next.add(el);
  }

  for (const oldEl of lastFieldCandidateEls) {
    if (!next.has(oldEl) && oldEl.isConnected) {
      oldEl.classList.remove(UWU_FIELD_CANDIDATE_CLASS);
    }
  }
  for (const newEl of next) {
    newEl.classList.add(UWU_FIELD_CANDIDATE_CLASS);
  }
  lastFieldCandidateEls = next;
}

async function processTextNode(textNode) {
  if (!textNode || processedNodes.has(textNode)) return;

  const text = textNode.nodeValue || "";
  if (text.length > scanTextLimit()) return;
  if (!text.includes(MARKER_PREFIX)) return;

  const matches = findEnvelopeMatches(text);
  if (!matches.length) return;

  processedNodes.add(textNode);

  const fragment = document.createDocumentFragment();
  let cursor = 0;

  for (const match of matches) {
    if (match.start > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
    }

    const placeholder = await buildDecryptedNode(match.payload);
    fragment.appendChild(placeholder);

    cursor = match.end;
  }

  if (cursor < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(cursor)));
  }

  textNode.parentNode?.replaceChild(fragment, textNode);
}

/** Cached CSS for closed shadow (chip + plaintext live inside shadow; page JS cannot read tree) */
let envelopeShadowCssCache = null;

async function getEnvelopeShadowCss() {
  if (envelopeShadowCssCache) return envelopeShadowCssCache;
  const url = chrome.runtime.getURL("src/content/envelope-shadow.css");
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not load envelope styles.");
  envelopeShadowCssCache = await res.text();
  return envelopeShadowCssCache;
}

async function buildDecryptedNode(compactEnvelope) {
  const wrapper = document.createElement("span");
  wrapper.className = "uwu-envelope-wrapper uwu-scanned-ciphertext";
  wrapper.dataset.uwuCompact = compactEnvelope;

  const shadowHost = document.createElement("span");
  shadowHost.className = "uwu-envelope-shadow-host";
  const shadow = shadowHost.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = await getEnvelopeShadowCss();
  shadow.appendChild(style);

  const inner = document.createElement("span");
  inner.className = "uwu-envelope-inner";

  const badge = document.createElement("button");
  badge.type = "button";
  applyUwuBadgeVisual(badge, "pending");

  const reveal = document.createElement("span");
  reveal.className = "uwu-envelope-reveal";
  reveal.hidden = true;
  reveal.textContent = "Decrypting...";

  inner.appendChild(badge);
  inner.appendChild(reveal);
  shadow.appendChild(inner);
  wrapper.appendChild(shadowHost);

  if (!settingsCache?.autoDecrypt) {
    badge.addEventListener("click", async () => {
      await revealMessage(compactEnvelope, reveal, badge);
    });
    return wrapper;
  }

  if (settingsCache?.clickToReveal) {
    try {
      const result = await request(MESSAGE_TYPES.DECRYPT_ENVELOPE, { compactEnvelope });
      const ok = applyDecryptResultToUi(result, reveal, badge, { keepPlaintextHidden: true });
      if (ok) {
        badge.addEventListener("click", () => {
          reveal.hidden = !reveal.hidden;
        });
      }
      return wrapper;
    } catch (error) {
      const locked = error?.message === "LOCKED";
      if (locked) {
        applyUwuBadgeVisual(badge, "locked");
        reveal.textContent = "Extension locked — open the UWU popup and enter your unlock secret.";
        reveal.hidden = false;
      } else {
        applyUwuBadgeVisual(badge, "noKey");
        reveal.textContent =
          "Your active identity can’t open this UWU message — it may be for someone else. Hover the chip for details.";
        reveal.hidden = false;
      }
      return wrapper;
    }
  }

  await revealMessage(compactEnvelope, reveal, badge);
  return wrapper;
}

function applyDecryptResultToUi(result, reveal, badge, options = {}) {
  const keepPlaintextHidden = Boolean(options.keepPlaintextHidden);
  if (result?.skipped && result.code === "WRONG_CONVERSATION") {
    reveal.textContent =
      "This message was not sent by the contact selected as Them in UWU. Pick Anyone or the right person in the popup.";
    reveal.hidden = false;
    applyUwuBadgeVisual(badge, "wrongChat");
    return false;
  }
  reveal.textContent = result.plaintext;
  reveal.dataset.verified = String(result.verified);
  applyUwuBadgeVisual(badge, result.verified ? "verified" : "open");
  reveal.hidden = keepPlaintextHidden;
  return true;
}

async function revealMessage(compactEnvelope, reveal, badge) {
  try {
    const result = await request(MESSAGE_TYPES.DECRYPT_ENVELOPE, { compactEnvelope });
    applyDecryptResultToUi(result, reveal, badge);
  } catch (error) {
    const locked = error?.message === "LOCKED";
    if (locked) {
      applyUwuBadgeVisual(badge, "locked");
      reveal.textContent = "Extension locked — open the UWU popup and enter your unlock secret.";
    } else {
      applyUwuBadgeVisual(badge, "noKey");
      reveal.textContent =
        "Your active identity can’t open this UWU message — it may be for someone else. Hover the chip for details.";
    }
    reveal.hidden = false;
  }
}

/* --- Page field encryption (settings: inputEncryptMode) --- */

let fieldBinding = null;
let chromeDockHost = null;

function getInputEncryptMode() {
  return settingsCache?.inputEncryptMode || "off";
}

function isUwuChromeTree(node) {
  return Boolean(
    node?.closest?.(
      ".uwu-scan-hud, .uwu-chrome-dock, .uwu-field-overlay-host, .uwu-field-encrypt-tooltip-host"
    )
  );
}

/**
 * Nearest contenteditable editing host for a node (element or #text).
 * Walks ancestors from the node that contains the caret or focus, so nested
 * markup under div[contenteditable] (e.g. div > span) still resolves to the host.
 */
function getContentEditableHost(fromEl) {
  if (!fromEl) return null;
  let n = fromEl;
  if (n.nodeType === Node.TEXT_NODE) n = n.parentElement;
  if (!n || n.nodeType !== Node.ELEMENT_NODE) return null;
  while (n && n !== document.documentElement) {
    if (isUwuChromeTree(n)) return null;
    const v = n.getAttribute("contenteditable");
    if (v === "true" || v === "" || v === "plaintext-only") {
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(n.tagName)) return null;
      return n;
    }
    if (v === "false") {
      n = n.parentElement;
      continue;
    }
    n = n.parentElement;
  }
  return null;
}

/** When activeElement is not the host (e.g. body) but the selection is inside a CE region. */
function getContentEditableHostFromSelection() {
  const sel = document.getSelection?.();
  if (!sel?.rangeCount) return null;
  const r = sel.getRangeAt(0);
  let node = r.commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
  return getContentEditableHost(node);
}

function fieldKind(el) {
  if (!el) return "value";
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return "value";
  return "contenteditable";
}

function getFieldPlain(el, kind) {
  if (kind === "value") return el.value || "";
  return (el.innerText ?? el.textContent ?? "").replace(/\r\n/g, "\n");
}

/**
 * Set INPUT/TEXTAREA value in a way frameworks (React/Vue controlled fields) observe.
 * Plain assignment often gets overwritten on the next render without input/change events.
 */
function setNativeFormControlValue(el, text) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) {
    desc.set.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function setFieldPlain(el, kind, text) {
  if (kind === "value") {
    setNativeFormControlValue(el, text);
    return;
  }
  el.textContent = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function setFieldWrappedCipher(el, kind, wrapped) {
  setFieldPlain(el, kind, wrapped);
}

function resolveProtectableField(focusEl) {
  let el = focusEl != null ? focusEl : document.activeElement;
  if (el?.nodeType === Node.TEXT_NODE) {
    const ce = getContentEditableHost(el);
    if (ce) return ce;
    el = el.parentElement;
  }
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return getContentEditableHostFromSelection();
  }
  if (isUwuChromeTree(el)) return null;

  const tag = el.tagName;
  if (tag === "TEXTAREA") {
    return !el.disabled && !el.readOnly ? el : null;
  }
  if (tag === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    if (!["text", "search", "email", "url", "tel"].includes(t) || el.disabled || el.readOnly) return null;
    return el;
  }
  const ce = getContentEditableHost(el);
  if (ce) return ce;
  return getContentEditableHostFromSelection();
}

function isProtectableField(el) {
  return resolveProtectableField(el) !== null;
}

function detachFieldBinding() {
  if (!fieldBinding) return;

  if (fieldBinding.overlayHost?.isConnected) {
    fieldBinding.overlayHost.remove();
  }
  if (fieldBinding.encryptTooltipHost?.isConnected) {
    fieldBinding.encryptTooltipHost.remove();
  }

  const el = fieldBinding.target;
  if (el?.isConnected && fieldBinding.mode === "live_overlay") {
    if (fieldBinding.priorStyleAttr === null || fieldBinding.priorStyleAttr === "") {
      el.removeAttribute("style");
    } else {
      el.setAttribute("style", fieldBinding.priorStyleAttr);
    }
    if (fieldBinding.priorTabindex === null) {
      el.removeAttribute("tabindex");
    } else {
      el.setAttribute("tabindex", fieldBinding.priorTabindex);
    }
    if (fieldBinding.fieldKind === "contenteditable" && fieldBinding.priorContentEditable != null) {
      el.setAttribute("contenteditable", fieldBinding.priorContentEditable);
    }
  }

  if (fieldBinding.onScroll) {
    window.removeEventListener("scroll", fieldBinding.onScroll, true);
  }
  if (fieldBinding.onResize) {
    window.removeEventListener("resize", fieldBinding.onResize);
  }
  if (fieldBinding.onEscape) {
    document.removeEventListener("keydown", fieldBinding.onEscape, true);
  }

  fieldBinding = null;
}

function syncFieldProtectionChrome() {
  const mode = getInputEncryptMode();
  if (fieldBinding && fieldBinding.mode !== mode) {
    detachFieldBinding();
  }
  if (mode === "off") {
    detachFieldBinding();
  }
  ensureChromeDock();
  updateChromeDockEncryptToggle();
  applyDockLayoutPosition();
  refreshChromeDockSelectors().catch(console.error);
}

function ensureChromeDock() {
  if (chromeDockHost?.isConnected) return;
  chromeDockHost = document.createElement("div");
  chromeDockHost.className = "uwu-chrome-dock";
  chromeDockHost.setAttribute("data-uwu-chrome", "1");
  const shadow = chromeDockHost.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; font-family: system-ui, sans-serif; font-size: 12px; }
      .dock {
        border-radius: 10px;
        background: rgba(26, 31, 43, 0.98); color: #e8ecf4;
        border: 1px solid #3d4a60; box-shadow: 0 8px 24px rgba(0,0,0,.4);
        max-width: min(360px, calc(100vw - 20px));
        overflow: hidden;
      }
      .drag {
        cursor: grab; user-select: none; padding: 8px 10px; background: #1a2230;
        display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #3d4a60;
      }
      .drag:active { cursor: grabbing; }
      .drag-mark { opacity: 0.55; letter-spacing: -2px; }
      .drag-title { font-weight: 800; letter-spacing: 0.06em; color: #9ec5ff; font-size: 11px; }
      .body { padding: 10px 10px 12px; }
      .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
      .row:last-of-type { margin-bottom: 0; }
      label.lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #8b98ad; min-width: 5.5em; }
      select.sel {
        flex: 1; min-width: 0; padding: 6px 8px; border-radius: 6px; background: #2a3344; color: #e8ecf4;
        border: 1px solid #3d4a60; font: inherit;
      }
      button {
        margin: 0; padding: 6px 10px; border-radius: 6px; border: 1px solid #3d4a60;
        background: #2a3344; color: #e8ecf4; font: inherit; font-weight: 600; cursor: pointer;
      }
      button:hover { background: #343b4d; }
      button:disabled { opacity: 0.45; cursor: not-allowed; }
      button.primary { background: #175ddc; border-color: #175ddc; color: #fff; }
      button.enc-on { background: #14532d; border-color: #22c55e; color: #ecfdf5; }
      .status { display: block; font-size: 11px; color: #8b98ad; margin-top: 8px; min-height: 1.2em; }
    </style>
    <div class="dock">
      <div class="drag" data-uwu-dock-drag>
        <span class="drag-mark" aria-hidden="true">⣿⣿</span>
        <span class="drag-title">UWU — page tools</span>
      </div>
      <div class="body">
        <div class="row">
          <label class="lbl" for="uwu-enc-t">Fields</label>
          <button type="button" id="uwu-enc-t" data-a="enc-toggle" aria-pressed="false">Off</button>
        </div>
        <div class="row">
          <label class="lbl" for="uwu-prof">You</label>
          <select class="sel" id="uwu-prof" data-a="profiles" aria-label="Decrypt as profile"></select>
        </div>
        <div class="row">
          <label class="lbl" for="uwu-con">Them</label>
          <select class="sel" id="uwu-con" data-a="contacts" aria-label="Encrypt for contact"></select>
        </div>
        <span class="status" data-a="status"></span>
      </div>
    </div>
  `;
  shadow.querySelector('[data-a="enc-toggle"]').addEventListener("click", onDockEncryptToggle);
  shadow.querySelector('[data-a="profiles"]').addEventListener("change", onDockProfileChange);
  shadow.querySelector('[data-a="contacts"]').addEventListener("change", onDockContactChange);
  document.documentElement.appendChild(chromeDockHost);
  applyDockLayoutPosition();
  const dragHandle = shadow.querySelector("[data-uwu-dock-drag]");
  attachOverlayDrag(chromeDockHost, dragHandle, "uwuDockLeft", "uwuDockTop");
  requestAnimationFrame(() => applyDockLayoutPosition());
}

function getToolbarShadow() {
  return chromeDockHost?.shadowRoot || null;
}

async function onDockEncryptToggle() {
  const cur = getInputEncryptMode();
  try {
    if (cur === "off") {
      const next =
        settingsCache.lastInputEncryptMode && settingsCache.lastInputEncryptMode !== "off"
          ? settingsCache.lastInputEncryptMode
          : "button_replace";
      settingsCache = await request(MESSAGE_TYPES.UPDATE_SETTINGS, { inputEncryptMode: next });
    } else {
      settingsCache = await request(MESSAGE_TYPES.UPDATE_SETTINGS, {
        lastInputEncryptMode: cur,
        inputEncryptMode: "off"
      });
      detachFieldBinding();
    }
    syncFieldProtectionChrome();
    if (getInputEncryptMode() !== "off") {
      scheduleFieldAutoBind();
    }
  } catch (e) {
    setFieldToolbarStatus(e.message || String(e));
  }
}

async function onDockProfileChange(ev) {
  const id = ev.target.value;
  if (!id) return;
  try {
    await request(MESSAGE_TYPES.SET_ACTIVE_PROFILE, { profileId: id });
  } catch (e) {
    setFieldToolbarStatus(e?.message === "LOCKED" ? "Locked — open the UWU popup and enter your unlock secret." : e.message || String(e));
  }
}

async function onDockContactChange(ev) {
  const id = ev.target.value || null;
  try {
    settingsCache = await request(MESSAGE_TYPES.UPDATE_SETTINGS, {
      selectedRecipientContactId: id
    });
    setFieldToolbarStatus(id ? "Them updated for page encrypt & filter." : "Them set to Anyone.");
  } catch (e) {
    setFieldToolbarStatus(e.message || String(e));
  }
}

function updateChromeDockEncryptToggle() {
  const root = getToolbarShadow();
  const btn = root?.querySelector('[data-a="enc-toggle"]');
  if (!btn) return;
  const on = getInputEncryptMode() !== "off";
  btn.textContent = on ? "On" : "Off";
  btn.classList.toggle("enc-on", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

async function refreshChromeDockSelectors() {
  const root = getToolbarShadow();
  if (!root) return;
  const prof = root.querySelector('[data-a="profiles"]');
  const con = root.querySelector('[data-a="contacts"]');
  if (!prof || !con) return;

  const profiles = await request(MESSAGE_TYPES.LIST_PROFILES);
  prof.innerHTML = "";
  for (const p of profiles) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = `${p.name}${p.active ? " (active)" : ""}`;
    if (p.active) o.selected = true;
    prof.appendChild(o);
  }

  const contacts = await request(MESSAGE_TYPES.LIST_CONTACTS);
  const savedC = settingsCache?.selectedRecipientContactId || "";
  con.innerHTML = "";
  const o0 = document.createElement("option");
  o0.value = "";
  o0.textContent = "Anyone";
  o0.selected = !savedC;
  con.appendChild(o0);
  for (const c of contacts) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name;
    if (c.id === savedC) {
      o.selected = true;
      o0.selected = false;
    }
    con.appendChild(o);
  }
}

function setFieldToolbarStatus(msg) {
  const root = getToolbarShadow();
  const el = root?.querySelector('[data-a="status"]');
  if (el) el.textContent = msg || "";
}

function scheduleFieldAutoBind() {
  clearTimeout(fieldAutoBindTimer);
  const gen = ++fieldAutoBindGen;
  fieldAutoBindTimer = setTimeout(() => {
    fieldAutoBindTimer = null;
    if (gen !== fieldAutoBindGen) return;
    tryBindFocusedProtectableField();
  }, 120);
}

function tryBindFocusedProtectableField() {
  if (getInputEncryptMode() === "off") return;
  const cur = document.activeElement;
  if (!cur || cur.nodeType !== Node.ELEMENT_NODE || isUwuChromeTree(cur)) return;
  const el = resolveProtectableField(cur);
  if (!el) return;
  if (fieldBinding?.target === el) return;
  bindFieldEncryptToElement(el);
}

function bindFieldEncryptToElement(el) {
  const mode = getInputEncryptMode();
  if (mode === "off") return;
  if (!el) {
    setFieldToolbarStatus("Focus a text field or contenteditable region.");
    return;
  }
  detachFieldBinding();
  const fk = fieldKind(el);
  if (mode === "live_overlay") {
    startLiveFieldBinding(el, fk);
  } else if (mode === "button_replace") {
    startButtonReplaceBinding(el, fk);
  }
  setFieldToolbarStatus(
    mode === "live_overlay"
      ? "Type in the overlay, then click the tooltip to encrypt."
      : "Type here, then click the tooltip to encrypt."
  );
}

function startFieldEncryptFocusCapture() {
  document.addEventListener(
    "focusin",
    (ev) => {
      if (getInputEncryptMode() === "off") return;
      const t = ev.target;
      if (!t || t.nodeType !== Node.ELEMENT_NODE) return;
      if (isUwuChromeTree(t)) return;
      const el = resolveProtectableField(t);
      if (!el) return;
      if (fieldBinding?.target === el) return;
      scheduleFieldAutoBind();
    },
    true
  );
}

function setEncryptTooltipBusy(busy) {
  const root = fieldBinding?.encryptTooltipHost?.shadowRoot;
  const btn = root?.querySelector('[data-a="encrypt-tip"]');
  if (btn) btn.disabled = busy;
}

function positionEncryptTooltip(host, el) {
  if (!el.isConnected) return;
  const r = el.getBoundingClientRect();
  const br = host.getBoundingClientRect();
  const tw = Math.max(br.width || host.offsetWidth || 0, 180);
  const th = Math.max(br.height || host.offsetHeight || 0, 32);
  const pad = 8;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.min(Math.max(pad, left), window.innerWidth - tw - pad);
  let top = r.top - th - pad;
  if (top < pad) {
    top = r.bottom + pad;
  }
  top = Math.min(Math.max(pad, top), window.innerHeight - th - pad);
  host.style.left = `${left}px`;
  host.style.top = `${top}px`;
}

function createEncryptTooltipHost(targetEl, onEncryptClick) {
  const host = document.createElement("div");
  host.className = "uwu-field-encrypt-tooltip-host";
  host.setAttribute("data-uwu-chrome", "1");
  host.style.cssText =
    "position:fixed;left:0;top:0;z-index:2147483647;margin:0;padding:0;border:none;background:transparent;pointer-events:auto;box-sizing:border-box;display:block;visibility:visible;opacity:1;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        display: inline-block;
        vertical-align: top;
        line-height: normal;
      }
      button.tip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin: 0;
        padding: 7px 14px;
        border-radius: 8px;
        border: 1px solid #60a5fa;
        background: linear-gradient(180deg, #2563eb 0%, #1d4ed8 100%);
        color: #f8fafc;
        font: 600 12px system-ui, -apple-system, sans-serif;
        cursor: pointer;
        white-space: nowrap;
        user-select: none;
        box-shadow: 0 4px 14px rgba(15, 23, 42, 0.35);
      }
      button.tip:hover:not(:disabled) {
        filter: brightness(1.07);
      }
      button.tip:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
    </style>
    <button type="button" class="tip" data-a="encrypt-tip">Click to encrypt</button>
  `;
  shadow.querySelector('[data-a="encrypt-tip"]').addEventListener("click", (e) => {
    e.stopPropagation();
    onEncryptClick();
  });
  const rootEl = document.body || document.documentElement;
  rootEl.appendChild(host);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => positionEncryptTooltip(host, targetEl));
  });
  return host;
}

async function onFieldToolbarEncryptNow() {
  if (!fieldBinding || fieldBinding.mode !== "button_replace") return;
  const el = fieldBinding.target;
  if (!el?.isConnected) {
    detachFieldBinding();
    return;
  }
  const fk = fieldBinding.fieldKind || fieldKind(el);
  const plain = getFieldPlain(el, fk);
  if (!plain.trim()) {
    setFieldToolbarStatus("Nothing to encrypt.");
    return;
  }
  const rid = settingsCache?.selectedRecipientContactId;
  if (!rid) {
    setFieldToolbarStatus("Choose a specific contact on Them (not Anyone) in the UWU popup.");
    return;
  }
  try {
    setFieldToolbarStatus("Encrypting…");
    setEncryptTooltipBusy(true);
    const { compact } = await request(MESSAGE_TYPES.ENCRYPT_TEXT, {
      plaintext: plain,
      recipientContactId: rid
    });
    setFieldWrappedCipher(el, fk, wrapEnvelopeCompact(compact));
    setFieldToolbarStatus("Replaced with ciphertext.");
  } catch (e) {
    setFieldToolbarStatus(e?.message === "LOCKED" ? "Locked — open the UWU popup and enter your unlock secret." : e.message || String(e));
  } finally {
    setEncryptTooltipBusy(false);
  }
}

async function onLiveEncryptTooltipClick() {
  if (!fieldBinding || fieldBinding.mode !== "live_overlay") return;
  const el = fieldBinding.target;
  const mirror = fieldBinding.mirror;
  if (!el?.isConnected) {
    detachFieldBinding();
    return;
  }
  const kind = fieldBinding.fieldKind || fieldKind(el);
  const plaintext = mirror?.value ?? "";
  setEncryptTooltipBusy(true);
  try {
    await runLiveFieldEncrypt(el, kind, plaintext);
  } catch (e) {
    setFieldToolbarStatus(e?.message === "LOCKED" ? "Locked — open the UWU popup and enter your unlock secret." : e.message || String(e));
  } finally {
    setEncryptTooltipBusy(false);
  }
}

function startButtonReplaceBinding(el, fk) {
  const kind = fk || fieldKind(el);
  const encryptTooltipHost = createEncryptTooltipHost(el, () => {
    onFieldToolbarEncryptNow();
  });

  const reposition = () => {
    if (!el.isConnected) return;
    positionEncryptTooltip(encryptTooltipHost, el);
  };
  reposition();

  const onScroll = () => reposition();
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", reposition, { passive: true });

  const onEscape = (ev) => {
    if (ev.key === "Escape" && fieldBinding) {
      ev.stopPropagation();
      detachFieldBinding();
      setFieldToolbarStatus("Released (Esc).");
    }
  };
  document.addEventListener("keydown", onEscape, true);

  fieldBinding = {
    target: el,
    mode: "button_replace",
    fieldKind: kind,
    encryptTooltipHost,
    onScroll,
    onResize: reposition,
    onEscape
  };
}

function startLiveFieldBinding(el, fk) {
  const kind = fk || fieldKind(el);
  const priorStyleAttr = el.getAttribute("style");
  const priorTabindex = el.hasAttribute("tabindex") ? el.getAttribute("tabindex") : null;
  let priorContentEditable = null;
  if (kind === "contenteditable") {
    priorContentEditable = el.getAttribute("contenteditable");
    el.setAttribute("contenteditable", "false");
  }

  el.style.setProperty("color", "transparent", "important");
  el.style.setProperty("caret-color", "transparent", "important");
  el.style.setProperty("-webkit-text-fill-color", "transparent", "important");
  el.tabIndex = -1;

  const overlayHost = document.createElement("div");
  overlayHost.className = "uwu-field-overlay-host";
  overlayHost.setAttribute("data-uwu-chrome", "1");
  overlayHost.style.cssText =
    "position:fixed;z-index:2147483644;pointer-events:auto;box-sizing:border-box;";
  const shadow = overlayHost.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      textarea {
        width: 100%; height: 100%; box-sizing: border-box; margin: 0; resize: none;
        font: inherit; border: 2px solid #175ddc; border-radius: 6px;
        background: #1a1f2b; color: #e8ecf4; line-height: 1.4;
      }
    </style>
    <textarea spellcheck="true" autocomplete="off" aria-label="UWU plaintext (not sent as plain text)"></textarea>
  `;
  const mirror = shadow.querySelector("textarea");

  const cs = window.getComputedStyle(el);
  mirror.style.fontFamily = cs.fontFamily;
  mirror.style.fontSize = cs.fontSize;
  mirror.style.fontWeight = cs.fontWeight;
  mirror.style.lineHeight = cs.lineHeight;
  mirror.style.padding = cs.padding;
  mirror.style.textAlign = cs.textAlign;
  if (el.tagName === "INPUT") {
    mirror.style.whiteSpace = "pre";
    mirror.style.overflowX = "auto";
    mirror.rows = 1;
  } else if (kind === "contenteditable") {
    mirror.style.minHeight = "3em";
  }

  const existingPlain = getFieldPlain(el, kind);
  if (existingPlain && !existingPlain.includes(MARKER_PREFIX)) {
    mirror.value = existingPlain;
  } else {
    mirror.value = "";
  }

  document.documentElement.appendChild(overlayHost);

  const encryptTooltipHost = createEncryptTooltipHost(el, () => {
    onLiveEncryptTooltipClick();
  });

  const reposition = () => {
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    overlayHost.style.top = `${r.top}px`;
    overlayHost.style.left = `${r.left}px`;
    overlayHost.style.width = `${Math.max(r.width, 40)}px`;
    overlayHost.style.height = `${Math.max(r.height, 36)}px`;
    positionEncryptTooltip(encryptTooltipHost, el);
  };
  reposition();

  const onScroll = () => reposition();
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", reposition, { passive: true });

  const onEscape = (ev) => {
    if (ev.key === "Escape" && fieldBinding) {
      ev.stopPropagation();
      detachFieldBinding();
      setFieldToolbarStatus("Released (Esc).");
    }
  };
  document.addEventListener("keydown", onEscape, true);

  const liveSessionId = Symbol("uwuLiveField");
  fieldBinding = {
    target: el,
    mode: "live_overlay",
    fieldKind: kind,
    liveSessionId,
    overlayHost,
    encryptTooltipHost,
    mirror,
    priorStyleAttr,
    priorTabindex,
    priorContentEditable,
    onScroll,
    onResize: reposition,
    onEscape,
    reposition
  };

  try {
    mirror.focus({ preventScroll: true });
  } catch (_e) {
    mirror.focus();
  }
}

async function runLiveFieldEncrypt(targetEl, kind, plaintext) {
  if (!targetEl?.isConnected) return;
  const session = fieldBinding?.liveSessionId;
  if (!fieldBinding || fieldBinding.target !== targetEl || fieldBinding.mode !== "live_overlay" || !session) return;

  const fk = kind || fieldBinding.fieldKind || fieldKind(targetEl);
  if (!plaintext.trim()) {
    setFieldPlain(targetEl, fk, "");
    setFieldToolbarStatus("");
    fieldBinding?.reposition?.();
    return;
  }
  const rid = settingsCache?.selectedRecipientContactId;
  if (!rid) {
    setFieldToolbarStatus("Choose Them (not Anyone) to encrypt live into the field.");
    fieldBinding?.reposition?.();
    return;
  }

  const plainForRequest = plaintext;
  const { compact } = await request(MESSAGE_TYPES.ENCRYPT_TEXT, {
    plaintext: plainForRequest,
    recipientContactId: rid
  });

  if (!fieldBinding || fieldBinding.liveSessionId !== session) return;
  const currentMirror = fieldBinding.mirror?.value ?? "";
  if (currentMirror !== plainForRequest) {
    return;
  }

  setFieldWrappedCipher(targetEl, fk, wrapEnvelopeCompact(compact));
  setFieldToolbarStatus("Underlying field updated (ciphertext).");
  fieldBinding?.reposition?.();
}

function clampLayout(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function applyHudLayoutPosition() {
  if (!hudRoot?.isConnected) return;
  const l = settingsCache?.uwuHudLeft;
  const t = settingsCache?.uwuHudTop;
  hudRoot.style.position = "fixed";
  hudRoot.style.zIndex = "2147483646";
  hudRoot.style.pointerEvents = "auto";
  if (typeof l === "number" && typeof t === "number") {
    const w = hudRoot.offsetWidth || 120;
    const h = hudRoot.offsetHeight || 48;
    hudRoot.style.left = `${clampLayout(l, 0, window.innerWidth - w)}px`;
    hudRoot.style.top = `${clampLayout(t, 0, window.innerHeight - h)}px`;
    hudRoot.style.right = "auto";
    hudRoot.style.bottom = "auto";
  } else {
    hudRoot.style.right = "12px";
    hudRoot.style.bottom = "12px";
    hudRoot.style.left = "auto";
    hudRoot.style.top = "auto";
  }
}

function applyDockLayoutPosition() {
  if (!chromeDockHost?.isConnected) return;
  const l = settingsCache?.uwuDockLeft;
  const t = settingsCache?.uwuDockTop;
  chromeDockHost.style.position = "fixed";
  chromeDockHost.style.zIndex = "2147483645";
  chromeDockHost.style.pointerEvents = "auto";
  if (typeof l === "number" && typeof t === "number") {
    const w = chromeDockHost.offsetWidth || 200;
    const h = chromeDockHost.offsetHeight || 120;
    chromeDockHost.style.left = `${clampLayout(l, 0, window.innerWidth - w)}px`;
    chromeDockHost.style.top = `${clampLayout(t, 0, window.innerHeight - h)}px`;
    chromeDockHost.style.right = "auto";
    chromeDockHost.style.bottom = "auto";
  } else {
    chromeDockHost.style.left = "12px";
    chromeDockHost.style.bottom = "100px";
    chromeDockHost.style.top = "auto";
    chromeDockHost.style.right = "auto";
  }
}

async function persistOverlayPosition(host, leftKey, topKey) {
  const r = host.getBoundingClientRect();
  const w = host.offsetWidth || 1;
  const h = host.offsetHeight || 1;
  const nx = clampLayout(Math.round(r.left), 0, Math.max(0, window.innerWidth - w));
  const ny = clampLayout(Math.round(r.top), 0, Math.max(0, window.innerHeight - h));
  settingsCache = await request(MESSAGE_TYPES.UPDATE_SETTINGS, {
    [leftKey]: nx,
    [topKey]: ny
  });
}

function attachOverlayDrag(host, handle, leftKey, topKey) {
  if (!host || !handle || handle.dataset.uwuDragInit) return;
  handle.dataset.uwuDragInit = "1";
  handle.addEventListener("mousedown", (downEv) => {
    if (downEv.button !== 0) return;
    downEv.preventDefault();
    const rect = host.getBoundingClientRect();
    const ox = downEv.clientX - rect.left;
    const oy = downEv.clientY - rect.top;
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.style.position = "fixed";
    const onMove = (ev) => {
      const w = host.offsetWidth || 1;
      const h = host.offsetHeight || 1;
      let nx = ev.clientX - ox;
      let ny = ev.clientY - oy;
      nx = clampLayout(nx, 0, window.innerWidth - w);
      ny = clampLayout(ny, 0, window.innerHeight - h);
      host.style.left = `${nx}px`;
      host.style.top = `${ny}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      persistOverlayPosition(host, leftKey, topKey).catch(console.error);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function request(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error || "Unknown extension error."));
        return;
      }

      resolve(response.result);
    });
  });
}
