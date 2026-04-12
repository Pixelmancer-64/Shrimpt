/**
 * Shrimpt — page overlay (classic script; content scripts are not modules in all browsers).
 * Keep in sync with src/lib/constants.js and findEnvelopeMatches in src/lib/encoding.js.
 */
const MARKER_PREFIX = "!uwu!";
const MARKER_SUFFIX = "!uwu!";

const STORAGE_KEYS = {
  SETTINGS: "settings",
  ACTIVE_PROFILE_ID: "activeProfileId"
};

/** Must match SESSION_UNLOCK_KEY in src/lib/pin.js */
const SESSION_UNLOCK_KEY = "shrimptUnlocked";

const DEFAULT_SETTINGS = {
  autoDecrypt: true,
  clickToReveal: false,
  observerDebounceMs: 250,
  scanTextLimit: 120000,
  selectedRecipientContactId: null,
  inputEncryptMode: "button_replace",
  lastInputEncryptMode: "button_replace",
  uwuDockLeft: null,
  uwuDockTop: null,
  uwuHudLeft: null,
  uwuHudTop: null,
  showScanReadIndicators: true
};

/** Must match MESSAGE_SESSION_UNLOCKED in src/lib/constants.js */
const MESSAGE_SESSION_UNLOCKED = "SHRIMPT_SESSION_UNLOCKED";

const MESSAGE_TYPES = {
  GET_SETTINGS: "GET_SETTINGS",
  DECRYPT_ENVELOPE: "DECRYPT_ENVELOPE",
  ENCRYPT_TEXT: "ENCRYPT_TEXT",
  UPDATE_SETTINGS: "UPDATE_SETTINGS",
  LIST_PROFILES: "LIST_PROFILES",
  LIST_CONTACTS: "LIST_CONTACTS",
  SET_ACTIVE_PROFILE: "SET_ACTIVE_PROFILE"
};

/**
 * Content-script debug logs (page DevTools console). Silence with:
 *   window.__SHRIMPT_DEBUG__ = false
 * (set before navigation, or run and reload the tab).
 */
function shrimptDebugEnabled() {
  try {
    if (typeof window !== "undefined" && window.__SHRIMPT_DEBUG__ === false) return false;
  } catch (_e) {
    /* cross-origin isolated or no window */
  }
  return true;
}

function shrimptLog(scope, ...args) {
  if (!shrimptDebugEnabled()) return;
  console.log(`[Shrimpt:${scope}]`, ...args);
}

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

/** Strip whitespace / invisible chars editors insert so base64 decodes reliably. */
function normalizeCompactPayload(raw) {
  return String(raw ?? "").replace(/[\s\u00a0\u200b\uFEFF]+/g, "");
}

function wrapEnvelopeCompact(compact) {
  return MARKER_PREFIX + compact + MARKER_SUFFIX;
}

const SCAN_HIGHLIGHT_NAME = "shrimpt-scanned-text";
const FRAGMENT_HIGHLIGHT_NAME = "shrimpt-marker-fragment";
const SHRIMPT_FIELD_CANDIDATE_CLASS = "shrimpt-field-candidate";
const CE_HOST_SELECTOR =
  '[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]';

const processedNodes = new WeakSet();
let observer = null;
let debounceTimer = null;
let settingsCache = null;
/** True if bootstrap fell back to DEFAULT_SETTINGS (retry when background is up). */
let settingsFallback = false;
let scanGeneration = 0;
let hudRoot = null;
let lastFieldCandidateEls = new Set();
let fieldAutoBindTimer = null;
let fieldAutoBindGen = 0;

bootstrap().catch(console.error);

async function bootstrap() {
  try {
    settingsCache = await request(MESSAGE_TYPES.GET_SETTINGS);
    settingsFallback = false;
  } catch (err) {
    console.warn("[Shrimpt] GET_SETTINGS failed; using defaults until background is ready.", err);
    settingsCache = { ...DEFAULT_SETTINGS };
    settingsFallback = true;
  }
  shrimptLog("boot", "bootstrap", {
    href: typeof location !== "undefined" ? location.href : "",
    settingsFallback,
    autoDecrypt: settingsCache?.autoDecrypt,
    clickToReveal: settingsCache?.clickToReveal,
    scanTextLimit: settingsCache?.scanTextLimit,
    observerDebounceMs: settingsCache?.observerDebounceMs,
    runtimeId: typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : null
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      const profileChanged = Boolean(changes[STORAGE_KEYS.ACTIVE_PROFILE_ID]);
      const settingsChanged = Boolean(changes[STORAGE_KEYS.SETTINGS]);
      if (profileChanged || settingsChanged) {
        onIdentityOrConversationStorageChanged().catch(console.error);
      }
    }
    if (area === "session") {
      const unlock = changes[SESSION_UNLOCK_KEY];
      if (unlock?.newValue === true) {
        refreshEnvelopesAfterSessionUnlock().catch(console.error);
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === MESSAGE_SESSION_UNLOCKED) {
      shrimptLog("boot", "session unlock message from background; refreshing envelopes");
      refreshEnvelopesAfterSessionUnlock().catch(console.error);
    }
  });

  ensureScanHud();
  syncFieldProtectionChrome();
  await rescanPage();
  startObserver();
  scheduleLateRescans();
  startFieldEncryptFocusCapture();
  scheduleFieldAutoBind();
}

async function onIdentityOrConversationStorageChanged() {
  settingsCache = await request(MESSAGE_TYPES.GET_SETTINGS);
  applyHudLayoutPosition();
  applyDockLayoutPosition();
  syncFieldProtectionChrome();
  scheduleFieldAutoBind();
  const wrappers = [...document.querySelectorAll("[data-shrimpt-compact]")];
  shrimptLog("boot", "identity/settings storage changed; rebuilding envelopes", { count: wrappers.length });
  for (const w of wrappers) {
    await rebuildEnvelopeWrapper(w);
  }
  syncFieldCandidateMarks();
  scheduleRescan();
}

async function rebuildEnvelopeWrapper(wrapper) {
  const compact = wrapper.getAttribute("data-shrimpt-compact");
  if (!compact) return;
  const parent = wrapper.parentNode;
  if (!parent) return;
  const fresh = await buildDecryptedNode(compact);
  parent.replaceChild(fresh, wrapper);
}

/** After popup/options unlock, retry decrypt on chips that showed "Extension locked…". */
async function refreshEnvelopesAfterSessionUnlock() {
  try {
    settingsCache = await request(MESSAGE_TYPES.GET_SETTINGS);
  } catch (_e) {
    /* keep cached settings */
  }
  const wrappers = [...document.querySelectorAll("[data-shrimpt-compact]")];
  shrimptLog("boot", "session unlocked; rebuilding envelope chips", { count: wrappers.length });
  for (const w of wrappers) {
    if (!w.isConnected) continue;
    await rebuildEnvelopeWrapper(w);
  }
  await rescanPage();
}

function startObserver() {
  observer = new MutationObserver(() => scheduleRescan());

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: false
  });
}

/** SPAs and lazy content often mount after the first idle scan. */
function scheduleLateRescans() {
  const run = () => rescanPage().catch(console.error);
  setTimeout(run, 400);
  setTimeout(run, 1600);
  setTimeout(async () => {
    if (!settingsFallback) return;
    try {
      settingsCache = await request(MESSAGE_TYPES.GET_SETTINGS);
      settingsFallback = false;
      shrimptLog("boot", "late GET_SETTINGS succeeded; rescanning");
      await rescanPage();
    } catch (_e) {
      shrimptLog("boot", "late GET_SETTINGS still failing; keeping defaults");
    }
  }, 1200);
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
  if (parent.closest(".shrimpt-scan-hud, .shrimpt-chrome-dock")) return false;
  if (parent.closest("[data-shrimpt-compact]")) return false;
  return true;
}

/**
 * Browsers and editors often split one logical string into adjacent TEXT_NODE siblings.
 * Envelopes must be matched on the merged run, then we replace the whole run at once.
 */
function expandForwardTextRun(startNode) {
  const nodes = [];
  let combined = "";
  const limit = scanTextLimit();
  let cur = startNode;

  while (cur && cur.nodeType === Node.TEXT_NODE) {
    const chunk = cur.nodeValue || "";
    if (combined.length + chunk.length > limit) {
      break;
    }
    combined += chunk;
    nodes.push(cur);
    cur = cur.nextSibling;
  }

  return { nodes, combined };
}

/** True when `combined` contains an opening !uwu! whose closing !uwu! is missing from this run. */
function hasUnclosedMarkerInRun(combined) {
  let cursor = 0;
  while (cursor < combined.length) {
    const start = combined.indexOf(MARKER_PREFIX, cursor);
    if (start === -1) return false;
    const payloadStart = start + MARKER_PREFIX.length;
    const end = combined.indexOf(MARKER_SUFFIX, payloadStart);
    if (end === -1) return true;
    cursor = end + MARKER_SUFFIX.length;
  }
  return false;
}

function collectEligibleTextNodes(root) {
  const out = [];
  if (!root) return out;

  function visit(node) {
    if (!node) return;

    if (node.nodeType === Node.TEXT_NODE) {
      if (acceptEligibleTextNode(node)) {
        out.push(node);
      }
      return;
    }

    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const child of node.childNodes) {
        visit(child);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const el = /** @type {Element} */ (node);
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
      return;
    }

    if (tag === "TEMPLATE") {
      const tmpl = /** @type {HTMLTemplateElement} */ (el);
      if (tmpl.content) {
        visit(tmpl.content);
      }
      return;
    }

    for (const child of el.childNodes) {
      visit(child);
    }

    if (el.shadowRoot) {
      visit(el.shadowRoot);
    }
  }

  visit(root);
  return out;
}

function scanReadIndicatorsEnabled() {
  return settingsCache?.showScanReadIndicators !== false;
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

function clearFragmentHighlightOnly() {
  try {
    if (typeof CSS !== "undefined" && CSS.highlights?.delete) {
      CSS.highlights.delete(FRAGMENT_HIGHLIGHT_NAME);
    }
  } catch (_e) {
    /* ignore */
  }
}

function applyFragmentHighlight(textNodes) {
  try {
    if (typeof CSS !== "undefined" && CSS.highlights?.delete) {
      CSS.highlights.delete(FRAGMENT_HIGHLIGHT_NAME);
    }
  } catch (_e) {
    /* ignore */
  }

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
    CSS.highlights.set(FRAGMENT_HIGHLIGHT_NAME, highlight);
  } catch (_e) {
    /* unsupported */
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
  if (hudRoot?.isConnected && hudRoot.querySelector(".shrimpt-scan-hud-drag")) {
    applyHudLayoutPosition();
    return;
  }
  if (hudRoot?.isConnected) hudRoot.remove();

  hudRoot = document.createElement("div");
  hudRoot.className = "shrimpt-scan-hud";
  hudRoot.setAttribute("role", "status");
  hudRoot.setAttribute("aria-live", "polite");
  hudRoot.innerHTML = `
    <button type="button" class="shrimpt-scan-hud-drag" aria-label="Drag to move scan summary">⣿</button>
    <div class="shrimpt-scan-hud-inner">
      <div class="shrimpt-scan-hud-top">
        <div class="shrimpt-scan-hud-headline">
          <span class="shrimpt-scan-hud-title">Shrimpt layer</span>
          <span class="shrimpt-scan-hud-pill" aria-hidden="true"></span>
        </div>
        <button type="button" class="shrimpt-scan-hud-toggle" aria-expanded="true" aria-label="Collapse scan summary">▾</button>
      </div>
      <div class="shrimpt-scan-hud-details">
        <label class="shrimpt-scan-hud-hl-row">
          <input type="checkbox" class="shrimpt-scan-hud-hl-cb" checked aria-label="Show scan highlights on the page and yellow tint on text fields" />
          <span class="shrimpt-scan-hud-hl-label">Show scan &amp; field indicators</span>
        </label>
        <p class="shrimpt-scan-hud-stats"><strong class="shrimpt-scan-hud-count">—</strong></p>
        <p class="shrimpt-scan-hud-meta muted"></p>
      </div>
    </div>
  `;

  const hlCb = /** @type {HTMLInputElement | null} */ (hudRoot.querySelector(".shrimpt-scan-hud-hl-cb"));
  hlCb?.addEventListener("change", async () => {
    const on = hlCb.checked;
    try {
      settingsCache = await request(MESSAGE_TYPES.UPDATE_SETTINGS, { showScanReadIndicators: on });
    } catch (_e) {
      hlCb.checked = !on;
      return;
    }
    await rescanPage();
  });

  const toggle = hudRoot.querySelector(".shrimpt-scan-hud-toggle");
  toggle?.addEventListener("click", () => {
    const collapsed = hudRoot.classList.toggle("is-collapsed");
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.textContent = collapsed ? "▸" : "▾";
    requestAnimationFrame(() => applyHudLayoutPosition());
  });

  (document.body || document.documentElement).appendChild(hudRoot);
  applyHudLayoutPosition();
  const dragEl = hudRoot.querySelector(".shrimpt-scan-hud-drag");
  attachOverlayDrag(hudRoot, dragEl, "uwuHudLeft", "uwuHudTop");
}

function updateScanHud({
  textNodeCount,
  ciphertextBlocks,
  highlightSupported,
  incompleteFragments = 0,
  readIndicatorsOn = true
}) {
  ensureScanHud();
  const statsEl = hudRoot.querySelector(".shrimpt-scan-hud-stats");
  const metaEl = hudRoot.querySelector(".shrimpt-scan-hud-meta");
  const pillEl = hudRoot.querySelector(".shrimpt-scan-hud-pill");
  const hlCb = /** @type {HTMLInputElement | null} */ (hudRoot.querySelector(".shrimpt-scan-hud-hl-cb"));
  if (!statsEl || !metaEl) return;

  if (hlCb && hlCb.checked !== readIndicatorsOn) {
    hlCb.checked = readIndicatorsOn;
  }

  hudRoot.classList.toggle("shrimpt-scan-hud--fragment-alert", incompleteFragments > 0 && readIndicatorsOn);

  if (pillEl) {
    pillEl.textContent =
      incompleteFragments > 0
        ? `${textNodeCount} regions · ${ciphertextBlocks} enc · ${incompleteFragments} open !uwu!`
        : `${textNodeCount} regions · ${ciphertextBlocks} enc`;
  }

  const hl = highlightSupported ? "" : " Highlights unavailable in this browser.";
  const frag =
    incompleteFragments > 0 && readIndicatorsOn
      ? ` <strong>${incompleteFragments}</strong> incomplete <code>!uwu!</code> fragment${incompleteFragments === 1 ? "" : "s"} (red tint).`
      : "";
  const indOff = readIndicatorsOn ? "" : " Read indicators off (highlights and yellow field tint hidden).";
  statsEl.innerHTML = `<strong class="shrimpt-scan-hud-count">${textNodeCount}</strong> text region${textNodeCount === 1 ? "" : "s"} scanned · <strong>${ciphertextBlocks}</strong> encrypted block${ciphertextBlocks === 1 ? "" : "s"}${hl}${frag}${indOff}`;

  const time = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  metaEl.textContent = `Scan updated ${time}`;
}

async function rescanPage() {
  const gen = ++scanGeneration;
  const root = document.body;
  if (!root) {
    shrimptLog("scan", "rescan skipped (no document.body yet)");
    return;
  }

  const snapshot = collectEligibleTextNodes(root);
  shrimptLog("scan", "rescan start", {
    gen,
    eligibleTextNodes: snapshot.length,
    href: location.href?.slice(0, 200)
  });

  const markerNodes = snapshot.filter((n) => {
    const t = n.nodeValue || "";
    if (!t.includes(MARKER_PREFIX)) return false;
    const { combined } = expandForwardTextRun(n);
    return findEnvelopeMatches(combined).length > 0;
  });

  const incompleteMarkerNodes = snapshot.filter((n) => {
    const t = n.nodeValue || "";
    if (!t.includes(MARKER_PREFIX)) return false;
    const { combined } = expandForwardTextRun(n);
    if (findEnvelopeMatches(combined).length > 0) return false;
    return hasUnclosedMarkerInRun(combined);
  });

  for (const node of markerNodes) {
    if (gen !== scanGeneration) {
      shrimptLog("scan", "rescan superseded during marker processing", { gen, latestGen: scanGeneration });
      return;
    }
    await processTextNode(node);
  }

  if (gen !== scanGeneration) {
    shrimptLog("scan", "rescan superseded before highlights", { gen, latestGen: scanGeneration });
    return;
  }

  const afterNodes = collectEligibleTextNodes(document.body);
  if (scanReadIndicatorsEnabled()) {
    applyScanHighlight(afterNodes);
    applyFragmentHighlight(incompleteMarkerNodes);
  } else {
    clearScanHighlight();
    clearFragmentHighlightOnly();
  }

  const ciphertextBlocks = document.querySelectorAll("[data-shrimpt-compact]").length;
  const highlightSupported = typeof Highlight !== "undefined" && Boolean(CSS.highlights?.set);

  updateScanHud({
    textNodeCount: afterNodes.length,
    ciphertextBlocks,
    highlightSupported,
    incompleteFragments: incompleteMarkerNodes.length,
    readIndicatorsOn: scanReadIndicatorsEnabled()
  });

  shrimptLog("scan", "rescan done", {
    gen,
    markerJobsQueued: markerNodes.length,
    incompleteMarkerRuns: incompleteMarkerNodes.length,
    ciphertextWrappers: ciphertextBlocks,
    textRegionsAfter: afterNodes.length,
    highlightSupported
  });

  syncFieldCandidateMarks();
}

function clearFieldCandidateMarks() {
  for (const oldEl of lastFieldCandidateEls) {
    if (oldEl.isConnected) oldEl.classList.remove(SHRIMPT_FIELD_CANDIDATE_CLASS);
  }
  lastFieldCandidateEls = new Set();
}

/**
 * Yellow tint on inputs/textareas and outermost contenteditable hosts so you can
 * see which controls the extension treats as user-input surfaces.
 * Controlled by the same setting as scan read highlights (popup / options / HUD).
 */
function syncFieldCandidateMarks() {
  const root = document.body;
  if (!root) return;

  if (!scanReadIndicatorsEnabled()) {
    clearFieldCandidateMarks();
    return;
  }

  const next = new Set();

  const allCe = [];
  for (const el of root.querySelectorAll(CE_HOST_SELECTOR)) {
    if (isShrimptChromeTree(el)) continue;
    if (el.closest("[data-shrimpt-compact]")) continue;
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
    if (isShrimptChromeTree(el)) continue;
    if (el.closest("[data-shrimpt-compact]")) continue;
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
      oldEl.classList.remove(SHRIMPT_FIELD_CANDIDATE_CLASS);
    }
  }
  for (const newEl of next) {
    newEl.classList.add(SHRIMPT_FIELD_CANDIDATE_CLASS);
  }
  lastFieldCandidateEls = next;
}

async function processTextNode(textNode) {
  if (!textNode || !textNode.isConnected || processedNodes.has(textNode)) return;
  if (!acceptEligibleTextNode(textNode)) return;

  const { nodes, combined } = expandForwardTextRun(textNode);
  if (!combined.includes(MARKER_PREFIX)) return;

  const matches = findEnvelopeMatches(combined);
  if (!matches.length) {
    shrimptLog("scan", "prefix in run but no complete envelope (check closing !uwu! / sibling splits)", {
      runLength: combined.length,
      siblingTextNodes: nodes.length,
      preview: combined.slice(0, 100).replace(/\s+/g, " ")
    });
    return;
  }

  shrimptLog("scan", "replacing text run with envelope chip(s)", {
    envelopes: matches.length,
    runLength: combined.length,
    siblingTextNodes: nodes.length,
    payloadLens: matches.map((m) => m.payload?.length ?? 0)
  });

  for (const n of nodes) {
    processedNodes.add(n);
  }

  try {
    const fragment = document.createDocumentFragment();
    let cursor = 0;

    for (const match of matches) {
      if (match.start > cursor) {
        fragment.appendChild(document.createTextNode(combined.slice(cursor, match.start)));
      }
      fragment.appendChild(await buildDecryptedNode(normalizeCompactPayload(match.payload)));
      cursor = match.end;
    }

    if (cursor < combined.length) {
      fragment.appendChild(document.createTextNode(combined.slice(cursor)));
    }

    const parent = nodes[0].parentNode;
    if (!parent) {
      for (const n of nodes) {
        processedNodes.delete(n);
      }
      return;
    }

    parent.insertBefore(fragment, nodes[0]);
    for (const n of nodes) {
      if (n.parentNode === parent) {
        parent.removeChild(n);
      }
    }
  } catch (err) {
    for (const n of nodes) {
      processedNodes.delete(n);
    }
    console.error("[Shrimpt] processTextNode", err);
    shrimptLog("scan", "processTextNode threw", { message: err?.message, name: err?.name });
  }
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

let encryptTooltipShadowCssCache = null;

async function getEncryptTooltipShadowCss() {
  if (encryptTooltipShadowCssCache) return encryptTooltipShadowCssCache;
  const url = chrome.runtime.getURL("src/content/encrypt-tooltip-shadow.css");
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not load encrypt tooltip styles.");
  encryptTooltipShadowCssCache = await res.text();
  return encryptTooltipShadowCssCache;
}

function applyShrimptBadgeVisual(badge, state) {
  const base = "shrimpt-envelope-button";
  badge.className = `${base} ${base}--${state}`;
}

/** Crypto / format failure (not LOCKED). Pre–dual-wrap envelopes only decrypt with the recipient’s keys. */
const DECRYPT_FAILED_MESSAGE =
  "Could not decrypt. Older Shrimpt messages were wrapped only for the recipient, so your own copy cannot be opened with your profile. New messages can be read by both sender and recipient. Unlock Shrimpt and confirm the active profile if keys should match.";

function removeEnvelopeChipButton(badge) {
  if (badge?.isConnected) badge.remove();
}

async function buildDecryptedNode(compactEnvelope) {
  const compact = normalizeCompactPayload(compactEnvelope);
  const host = document.createElement("span");
  host.dataset.shrimptCompact = compact;
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = await getEnvelopeShadowCss();
  shadow.appendChild(style);

  const inner = document.createElement("span");
  inner.className = "shrimpt-envelope-inner";

  const badge = document.createElement("button");
  badge.type = "button";
  applyShrimptBadgeVisual(badge, "pending");

  const reveal = document.createElement("span");
  reveal.className = "shrimpt-envelope-reveal";
  reveal.hidden = true;
  reveal.textContent = "Decrypting...";

  inner.appendChild(badge);
  inner.appendChild(reveal);
  shadow.appendChild(inner);

  if (!settingsCache?.autoDecrypt) {
    shrimptLog("decrypt", "chip: autoDecrypt off — decrypt on chip click", { compactLen: compact.length });
    badge.addEventListener("click", async () => {
      await revealMessage(compact, reveal, badge, { forPageScan: false });
    });
    return host;
  }

  try {
    shrimptLog("decrypt", "DECRYPT_ENVELOPE (page scan)", {
      compactLen: compact.length,
      forPageScan: true
    });
    const result = await request(MESSAGE_TYPES.DECRYPT_ENVELOPE, {
      compactEnvelope: compact,
      forPageScan: true
    });
    const ok = applyDecryptResultToUi(result, reveal, badge, { keepPlaintextHidden: false });
    shrimptLog("decrypt", "decrypt result (auto)", {
      ok,
      skipped: result?.skipped,
      code: result?.code,
      verified: result?.verified,
      conversationMismatch: result?.conversationMismatch,
      plaintextLen: (result?.plaintext ?? "").length
    });
    return host;
  } catch (error) {
    const locked = error?.message === "LOCKED";
    shrimptLog("decrypt", "decrypt failed (auto)", { message: error?.message, locked });
    if (locked) {
      applyShrimptBadgeVisual(badge, "pending");
      reveal.textContent = "Extension locked — open the Shrimpt popup and enter your unlock secret.";
      reveal.hidden = false;
    } else {
      removeEnvelopeChipButton(badge);
      reveal.textContent = DECRYPT_FAILED_MESSAGE;
      reveal.hidden = false;
    }
    return host;
  }
}

function applyDecryptResultToUi(result, reveal, badge, options = {}) {
  const keepPlaintextHidden = Boolean(options.keepPlaintextHidden);
  if (result?.skipped && result.code === "WRONG_CONVERSATION") {
    shrimptLog("decrypt", "UI: wrong conversation (skipped)", { code: result.code });
    reveal.textContent =
      "This message was not sent by the contact selected as Them in Shrimpt. Pick Anyone or the right person in the popup.";
    reveal.hidden = false;
    removeEnvelopeChipButton(badge);
    return false;
  }
  reveal.textContent = result.plaintext ?? "";
  reveal.dataset.verified = String(result.verified);
  if (result?.conversationMismatch) {
    removeEnvelopeChipButton(badge);
    reveal.title =
      "Sender does not match Them (Anyone or change Them in the dock/popup). Plaintext is shown so you can still read on the page.";
  } else {
    reveal.removeAttribute("title");
    if (result.verified) {
      removeEnvelopeChipButton(badge);
    } else {
      applyShrimptBadgeVisual(badge, "open");
    }
  }
  reveal.hidden = keepPlaintextHidden;
  return true;
}

async function revealMessage(compactEnvelope, reveal, badge, options = {}) {
  const { forPageScan = false } = options;
  const compact = normalizeCompactPayload(compactEnvelope);
  shrimptLog("decrypt", "revealMessage (user)", { forPageScan, compactLen: compact.length });
  try {
    const result = await request(MESSAGE_TYPES.DECRYPT_ENVELOPE, {
      compactEnvelope: compact,
      forPageScan
    });
    applyDecryptResultToUi(result, reveal, badge, { keepPlaintextHidden: false });
    shrimptLog("decrypt", "revealMessage ok", {
      skipped: result?.skipped,
      code: result?.code,
      verified: result?.verified,
      conversationMismatch: result?.conversationMismatch,
      plaintextLen: (result?.plaintext ?? "").length
    });
  } catch (error) {
    const locked = error?.message === "LOCKED";
    shrimptLog("decrypt", "revealMessage error", { message: error?.message, locked });
    if (locked) {
      applyShrimptBadgeVisual(badge, "pending");
      reveal.textContent = "Extension locked — open the Shrimpt popup and enter your unlock secret.";
    } else {
      removeEnvelopeChipButton(badge);
      reveal.textContent = DECRYPT_FAILED_MESSAGE;
    }
    reveal.hidden = false;
  }
}

/* --- Page field encryption (settings: inputEncryptMode) --- */

let fieldBinding = null;
let chromeDockHost = null;

function getInputEncryptMode() {
  const m = settingsCache?.inputEncryptMode;
  if (m === "live_overlay") return "live_overlay";
  if (m === "button_replace") return "button_replace";
  return "button_replace";
}

function isShrimptChromeTree(node) {
  if (!node) return false;
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!el?.closest) return false;
  if (
    el.closest(
      ".shrimpt-scan-hud, .shrimpt-chrome-dock, .shrimpt-field-overlay-host, .shrimpt-field-encrypt-tooltip-host"
    )
  ) {
    return true;
  }
  const root = el.getRootNode();
  if (root instanceof ShadowRoot) {
    const host = root.host;
    if (
      host?.matches?.(
        ".shrimpt-chrome-dock, .shrimpt-field-overlay-host, .shrimpt-field-encrypt-tooltip-host, .shrimpt-scan-hud"
      )
    ) {
      return true;
    }
  }
  return false;
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
    if (isShrimptChromeTree(n)) return null;
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
  replaceContentEditableWhole(el, text);
}

function setFieldWrappedCipher(el, kind, wrapped) {
  setFieldPlain(el, kind, wrapped);
}

function rangeFullyInsideHost(range, hostEl) {
  if (!range || !hostEl) return false;
  try {
    return hostEl.contains(range.startContainer) && hostEl.contains(range.endContainer);
  } catch (_e) {
    return false;
  }
}

function firstDeepTextNode(root) {
  if (!root) return null;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  return w.nextNode();
}

function lastDeepTextNode(root) {
  if (!root) return null;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last = null;
  let n;
  while ((n = w.nextNode())) last = n;
  return last;
}

function collectEditableTextNodes(host) {
  const out = [];
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    let p = n.parentElement;
    let skip = false;
    while (p && p !== host) {
      if (isShrimptChromeTree(p) || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(p.tagName)) {
        skip = true;
        break;
      }
      p = p.parentElement;
    }
    if (!skip) out.push(n);
  }
  return out;
}

function isLexicalEditorContentHost(host) {
  return host?.getAttribute?.("data-lexical-editor") != null;
}

/**
 * Lexical / rich editors keep block wrappers (e.g. &lt;p&gt;&lt;br&gt;&lt;/p&gt;). Replacing
 * host.textContent nukes that tree and breaks the editor.
 */
function replaceLexicalEditorHostContent(host, wrapped) {
  let block = host.querySelector(":scope > p");
  if (!block) block = host.firstElementChild;
  if (!block) {
    const p = document.createElement("p");
    p.appendChild(document.createTextNode(wrapped));
    host.replaceChildren(p);
    return;
  }
  block.replaceChildren(document.createTextNode(wrapped));
  for (const n of [...host.childNodes]) {
    if (n !== block) n.remove();
  }
}

function replaceLexicalEmptyPlaceholder(host) {
  let block = host.querySelector(":scope > p");
  if (!block) block = host.firstElementChild;
  if (!block) {
    const p = document.createElement("p");
    p.appendChild(document.createElement("br"));
    host.replaceChildren(p);
    return;
  }
  block.replaceChildren();
  block.appendChild(document.createElement("br"));
  for (const n of [...host.childNodes]) {
    if (n !== block) n.remove();
  }
}

/**
 * Replace all visible text in a contenteditable host while keeping block structure where possible.
 */
function replaceContentEditableWhole(host, wrapped) {
  if (!host) return;
  const lexical = isLexicalEditorContentHost(host);

  if (!wrapped) {
    if (lexical) {
      replaceLexicalEmptyPlaceholder(host);
    } else {
      host.textContent = "";
    }
    host.dispatchEvent(new Event("input", { bubbles: true }));
    try {
      host.focus();
    } catch (_e) {
      /* ignore */
    }
    return;
  }

  if (lexical) {
    replaceLexicalEditorHostContent(host, wrapped);
  } else {
    const texts = collectEditableTextNodes(host).filter((t) => (t.nodeValue || "").length > 0);
    if (texts.length === 1) {
      texts[0].data = wrapped;
    } else if (texts.length > 1) {
      const r = document.createRange();
      r.setStart(texts[0], 0);
      const last = texts[texts.length - 1];
      r.setEnd(last, last.nodeValue.length);
      r.deleteContents();
      const tn = document.createTextNode(wrapped);
      r.insertNode(tn);
      r.setStartAfter(tn);
      r.collapse(true);
      const sel = document.getSelection?.();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(r);
      }
    } else {
      const first = host.firstElementChild;
      if (first) {
        first.replaceChildren(document.createTextNode(wrapped));
        for (const n of [...host.childNodes]) {
          if (n !== first) n.remove();
        }
      } else {
        host.textContent = wrapped;
      }
    }
  }

  host.dispatchEvent(new Event("input", { bubbles: true }));
  try {
    host.focus();
  } catch (_e) {
    /* ignore */
  }
}

/**
 * Collapsed caret: resolve nested markup (e.g. caret in &lt;p&gt; next to &lt;br&gt;) to a text run.
 * @returns {{ plain: string, range: Range } | null}
 */
function textNodeRunFromCollapsedCaret(host, live, sel) {
  if (!live.collapsed || !rangeFullyInsideHost(live, host) || !sel) return null;
  const an = sel.anchorNode;
  const off = sel.anchorOffset;

  const pack = (tn) => {
    if (!tn || tn.nodeType !== Node.TEXT_NODE || !host.contains(tn)) return null;
    const raw = tn.nodeValue ?? "";
    if (!raw.length) return null;
    const range = document.createRange();
    range.selectNodeContents(tn);
    return { plain: raw.replace(/\r\n/g, "\n"), range: range.cloneRange() };
  };

  if (an.nodeType === Node.TEXT_NODE) return pack(an);

  if (an.nodeType === Node.ELEMENT_NODE && host.contains(an)) {
    if (off < an.childNodes.length) {
      const next = an.childNodes[off];
      let hit = pack(next);
      if (!hit && next?.nodeType === Node.ELEMENT_NODE) hit = pack(firstDeepTextNode(next));
      if (hit) return hit;
    }
    if (off > 0) {
      const prev = an.childNodes[off - 1];
      let hit = pack(prev);
      if (!hit && prev?.nodeType === Node.ELEMENT_NODE) hit = pack(lastDeepTextNode(prev));
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Decide what to encrypt and how to splice ciphertext back (preserves CE markup outside the slice).
 * @returns {{ plain: string, spec: object }}
 */
function getEncryptReplaceSpec(el, kind) {
  if (kind === "value") {
    const v = el.value ?? "";
    let a = typeof el.selectionStart === "number" ? el.selectionStart : 0;
    let b = typeof el.selectionEnd === "number" ? el.selectionEnd : 0;
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    if (b > a) {
      return {
        plain: v.slice(a, b).replace(/\r\n/g, "\n"),
        spec: { mode: "value_slice", start: a, end: b }
      };
    }
    return {
      plain: v.replace(/\r\n/g, "\n"),
      spec: { mode: "value_all" }
    };
  }

  const host = el;
  const sel = document.getSelection?.();
  if (sel && sel.rangeCount > 0) {
    const live = sel.getRangeAt(0);
    if (rangeFullyInsideHost(live, host)) {
      if (!live.collapsed) {
        const plain = live.toString().replace(/\r\n/g, "\n");
        return {
          plain,
          spec: { mode: "ce_range", range: live.cloneRange() }
        };
      }
      const run = textNodeRunFromCollapsedCaret(host, live, sel);
      if (run) {
        return {
          plain: run.plain,
          spec: { mode: "ce_text_node", range: run.range }
        };
      }
    }
  }

  const all = (host.innerText ?? host.textContent ?? "").replace(/\r\n/g, "\n");
  return { plain: all, spec: { mode: "ce_all" } };
}

function applyWrappedCiphertextWithSpec(el, kind, wrapped, spec) {
  if (kind === "value") {
    if (spec.mode === "value_slice" && typeof spec.start === "number" && typeof spec.end === "number") {
      const v = el.value ?? "";
      const out = v.slice(0, spec.start) + wrapped + v.slice(spec.end);
      setNativeFormControlValue(el, out);
      const caret = spec.start + wrapped.length;
      try {
        el.selectionStart = el.selectionEnd = caret;
      } catch (_e) {
        /* some inputs are read-only to selection API */
      }
      return;
    }
    setNativeFormControlValue(el, wrapped);
    return;
  }

  if (spec.mode === "ce_range" && spec.range) {
    const range = spec.range;
    if (
      !range.startContainer?.isConnected ||
      !el.contains(range.startContainer) ||
      !el.contains(range.endContainer)
    ) {
      replaceContentEditableWhole(el, wrapped);
      return;
    }
    range.deleteContents();
    const tn = document.createTextNode(wrapped);
    range.insertNode(tn);
    range.setStartAfter(tn);
    range.collapse(true);
    const sel = document.getSelection?.();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    try {
      el.focus();
    } catch (_e) {
      /* ignore */
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  if (spec.mode === "ce_text_node" && spec.range) {
    const tn = spec.range.startContainer;
    if (tn?.nodeType === Node.TEXT_NODE && tn.isConnected && el.contains(tn)) {
      tn.replaceData(0, tn.length, wrapped);
      const sel = document.getSelection?.();
      if (sel) {
        const nr = document.createRange();
        const end = Math.min(wrapped.length, tn.length);
        nr.setStart(tn, end);
        nr.collapse(true);
        sel.removeAllRanges();
        sel.addRange(nr);
      }
      try {
        el.focus();
      } catch (_e) {
        /* ignore */
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    replaceContentEditableWhole(el, wrapped);
    return;
  }

  replaceContentEditableWhole(el, wrapped);
}

function resolveProtectableField(focusEl) {
  const explicitTarget = focusEl != null;
  let el = explicitTarget ? focusEl : document.activeElement;
  if (el?.nodeType === Node.TEXT_NODE) {
    const ce = getContentEditableHost(el);
    if (ce) return ce;
    el = el.parentElement;
  }
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return getContentEditableHostFromSelection();
  }
  if (isShrimptChromeTree(el)) return null;

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

  /* Focus is on a real element that is not a field — never fall back to selection
   * (would bind the wrong control, e.g. dock button + caret still in compose). */
  if (explicitTarget) return null;
  if (el === document.body || el === document.documentElement) {
    return getContentEditableHostFromSelection();
  }
  return null;
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
  ensureChromeDock();
  applyDockLayoutPosition();
  refreshChromeDockSelectors().catch(console.error);
}

function ensureChromeDock() {
  if (chromeDockHost?.isConnected) return;
  chromeDockHost = document.createElement("div");
  chromeDockHost.className = "shrimpt-chrome-dock";
  chromeDockHost.setAttribute("data-shrimpt-chrome", "1");
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
      .status { display: block; font-size: 11px; color: #8b98ad; margin-top: 8px; min-height: 1.2em; }
    </style>
    <div class="dock">
      <div class="drag" data-shrimpt-dock-drag>
        <span class="drag-mark" aria-hidden="true">⣿⣿</span>
        <span class="drag-title">Shrimpt — page tools</span>
      </div>
      <div class="body">
        <div class="row">
          <label class="lbl" for="shrimpt-prof">You</label>
          <select class="sel" id="shrimpt-prof" data-a="profiles" aria-label="Decrypt as profile"></select>
        </div>
        <div class="row">
          <label class="lbl" for="shrimpt-con">Them</label>
          <select class="sel" id="shrimpt-con" data-a="contacts" aria-label="Encrypt for contact"></select>
        </div>
        <span class="status" data-a="status"></span>
      </div>
    </div>
  `;
  shadow.querySelector('[data-a="profiles"]').addEventListener("change", onDockProfileChange);
  shadow.querySelector('[data-a="contacts"]').addEventListener("change", onDockContactChange);
  document.documentElement.appendChild(chromeDockHost);
  applyDockLayoutPosition();
  const dragHandle = shadow.querySelector("[data-shrimpt-dock-drag]");
  attachOverlayDrag(chromeDockHost, dragHandle, "uwuDockLeft", "uwuDockTop");
  requestAnimationFrame(() => applyDockLayoutPosition());
}

function getToolbarShadow() {
  return chromeDockHost?.shadowRoot || null;
}

async function onDockProfileChange(ev) {
  const id = ev.target.value;
  if (!id) return;
  try {
    await request(MESSAGE_TYPES.SET_ACTIVE_PROFILE, { profileId: id });
  } catch (e) {
    setFieldToolbarStatus(e?.message === "LOCKED" ? "Locked — open the Shrimpt popup and enter your unlock secret." : e.message || String(e));
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

function scheduleFieldAutoBind(expectedField) {
  clearTimeout(fieldAutoBindTimer);
  const gen = ++fieldAutoBindGen;
  fieldAutoBindTimer = setTimeout(() => {
    fieldAutoBindTimer = null;
    if (gen !== fieldAutoBindGen) return;
    tryBindFocusedProtectableField(expectedField);
  }, 120);
}

function tryBindFocusedProtectableField(expectedField) {
  let el = null;
  if (expectedField?.isConnected) {
    const ae = document.activeElement;
    if (fieldKind(expectedField) === "value") {
      if (ae === expectedField) el = expectedField;
    } else if (expectedField.contains(ae) || ae === expectedField) {
      el = expectedField;
    }
  }

  if (!el) {
    const cur = document.activeElement;
    if (!cur || cur.nodeType !== Node.ELEMENT_NODE || isShrimptChromeTree(cur)) return;
    el = resolveProtectableField(cur);
  }
  if (!el) return;
  if (fieldBinding?.target === el) return;
  void bindFieldEncryptToElement(el).catch((err) => console.error("[Shrimpt] bind field encrypt", err));
}

async function bindFieldEncryptToElement(el) {
  const mode = getInputEncryptMode();
  if (!el) {
    setFieldToolbarStatus("Focus a text field or contenteditable region.");
    return;
  }
  detachFieldBinding();
  const fk = fieldKind(el);
  if (mode === "live_overlay") {
    await startLiveFieldBinding(el, fk);
  } else {
    await startButtonReplaceBinding(el, fk);
  }
  setFieldToolbarStatus(
    mode === "live_overlay"
      ? "Type in the overlay, then click the tooltip to encrypt."
      : fk === "contenteditable"
        ? "Select the text to encrypt (or put the caret in one text run). Then click the tooltip."
        : "Type here, then click the tooltip to encrypt."
  );
}

function startFieldEncryptFocusCapture() {
  document.addEventListener(
    "focusin",
    (ev) => {
      const t = ev.target;
      if (!t || t.nodeType !== Node.ELEMENT_NODE) return;
      if (isShrimptChromeTree(t)) return;
      const el = resolveProtectableField(t);
      if (!el) return;
      if (fieldBinding?.target === el) return;
      scheduleFieldAutoBind(el);
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

async function createEncryptTooltipHost(targetEl, onEncryptClick) {
  const host = document.createElement("div");
  host.className = "shrimpt-field-encrypt-tooltip-host";
  host.setAttribute("data-shrimpt-chrome", "1");
  host.style.cssText =
    "position:fixed;left:0;top:0;z-index:2147483647;margin:0;padding:0;border:none;background:transparent;pointer-events:auto;box-sizing:border-box;display:block;visibility:visible;opacity:1;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = await getEncryptTooltipShadowCss();
  shadow.appendChild(style);
  const encryptTipBtn = document.createElement("button");
  encryptTipBtn.type = "button";
  encryptTipBtn.className = "tip";
  encryptTipBtn.setAttribute("data-a", "encrypt-tip");
  encryptTipBtn.textContent = "Click to encrypt";
  shadow.appendChild(encryptTipBtn);
  const keepEditorSelection = (e) => {
    e.preventDefault();
  };
  encryptTipBtn.addEventListener("mousedown", keepEditorSelection);
  encryptTipBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const out = onEncryptClick();
    if (out && typeof out.then === "function") {
      out.catch((err) => console.error("[Shrimpt] encrypt click", err));
    }
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
  const { plain, spec } = getEncryptReplaceSpec(el, fk);
  if (!plain.trim()) {
    setFieldToolbarStatus(
      fk === "contenteditable"
        ? "Nothing to encrypt — select text in the field, or place the caret in a text run."
        : "Nothing to encrypt."
    );
    return;
  }
  const rid = settingsCache?.selectedRecipientContactId;
  if (!rid) {
    setFieldToolbarStatus("Choose a specific contact on Them (not Anyone) in the page dock or popup.");
    return;
  }
  try {
    setFieldToolbarStatus("Encrypting…");
    setEncryptTooltipBusy(true);
    const { compact } = await request(MESSAGE_TYPES.ENCRYPT_TEXT, {
      plaintext: plain,
      recipientContactId: rid
    });
    if (!el.isConnected) {
      setFieldToolbarStatus("Field was removed; canceled.");
      return;
    }
    applyWrappedCiphertextWithSpec(el, fk, wrapEnvelopeCompact(compact), spec);
    setFieldToolbarStatus(
      spec.mode === "ce_all" || spec.mode === "value_all"
        ? "Replaced whole field with ciphertext."
        : "Replaced selection with ciphertext."
    );
  } catch (e) {
    setFieldToolbarStatus(e?.message === "LOCKED" ? "Locked — open the Shrimpt popup and enter your unlock secret." : e.message || String(e));
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
    setFieldToolbarStatus(e?.message === "LOCKED" ? "Locked — open the Shrimpt popup and enter your unlock secret." : e.message || String(e));
  } finally {
    setEncryptTooltipBusy(false);
  }
}

async function startButtonReplaceBinding(el, fk) {
  const kind = fk || fieldKind(el);
  const encryptTooltipHost = await createEncryptTooltipHost(el, () => onFieldToolbarEncryptNow());

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

async function startLiveFieldBinding(el, fk) {
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
  overlayHost.className = "shrimpt-field-overlay-host";
  overlayHost.setAttribute("data-shrimpt-chrome", "1");
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
    <textarea spellcheck="true" autocomplete="off" aria-label="Shrimpt plaintext (not sent as plain text)"></textarea>
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

  const encryptTooltipHost = await createEncryptTooltipHost(el, () => onLiveEncryptTooltipClick());

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
    setFieldToolbarStatus("Choose Them (not Anyone) in the dock or popup to encrypt.");
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
        const msg = chrome.runtime.lastError.message;
        shrimptLog("msg", "sendMessage failed (service worker / channel)", { type, message: msg });
        reject(new Error(msg));
        return;
      }

      if (!response?.ok) {
        const msg = response?.error || "Unknown extension error.";
        shrimptLog("msg", "background returned error", { type, message: msg });
        reject(new Error(msg));
        return;
      }

      if (type === MESSAGE_TYPES.DECRYPT_ENVELOPE || type === MESSAGE_TYPES.ENCRYPT_TEXT) {
        shrimptLog("msg", "background ok", type);
      }

      resolve(response.result);
    });
  });
}
